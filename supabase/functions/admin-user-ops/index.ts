import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const AUTH_EMAIL_DOMAIN = 'jsr.internal';

function buildAuthEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
    status: 200,
  });
}

function err(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
    status,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Verify caller is an authenticated admin ────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return err('Missing Authorization header', 401);
    const jwt = authHeader.replace(/^Bearer\s+/i, '');

    // Service-role callers (server-side scripts, QA tests) are trusted without
    // a user profile check — the service-role key already has full DB access.
    const isServiceRole = jwt === serviceKey;

    if (!isServiceRole) {
      const { data: { user: callerAuthUser }, error: authErr } = await admin.auth.getUser(jwt);
      if (authErr || !callerAuthUser) return err('Invalid or expired session', 401);

      const { data: caller, error: callerErr } = await admin
        .from('users')
        .select('role')
        .eq('auth_user_id', callerAuthUser.id)
        .single();
      if (callerErr || !caller) return err('Caller profile not found', 403);
      if (caller.role !== 'admin') return err('Admin access required', 403);
    }

    // ── Dispatch ───────────────────────────────────────────────────────────
    const body = await req.json();
    const { op } = body;

    // ── create ─────────────────────────────────────────────────────────────
    if (op === 'create') {
      const { fullName, username, password, role } = body;
      if (!fullName || !username || !password) return err('fullName, username, and password are required');

      const { data: authData, error: authCreateErr } = await admin.auth.admin.createUser({
        email: buildAuthEmail(username),
        password,
        email_confirm: true,
      });
      if (authCreateErr) {
        const msg = authCreateErr.message ?? '';
        if (msg.includes('already registered') || msg.includes('duplicate') || msg.includes('already exists')) {
          return err(`An auth account for username "${username}" already exists`);
        }
        return err(`Auth user creation failed: ${msg}`);
      }

      const authUserId = authData.user.id;

      const { data: newUser, error: insertErr } = await admin
        .from('users')
        .insert({
          username,
          full_name: fullName,
          role: role || 'user',
          auth_user_id: authUserId,
          permissions: {},
        })
        .select('id, username, full_name, role, permissions, auth_user_id, created_at')
        .single();

      if (insertErr) {
        // Orphan safety: roll back the auth user we just created
        await admin.auth.admin.deleteUser(authUserId);
        if (insertErr.code === '23505') return err(`Username "${username}" is already taken`);
        return err(`Profile creation failed (auth user rolled back): ${insertErr.message}`);
      }

      return ok({ data: newUser });
    }

    // ── update_username ────────────────────────────────────────────────────
    if (op === 'update_username') {
      const { userId, newUsername } = body;
      if (!userId || !newUsername) return err('userId and newUsername are required');

      const { data: userRow, error: lookupErr } = await admin
        .from('users')
        .select('auth_user_id')
        .eq('id', userId)
        .single();
      if (lookupErr || !userRow) return err('User not found');
      if (!userRow.auth_user_id) return err('User has no linked auth account');

      const { error: updateErr } = await admin.auth.admin.updateUserById(userRow.auth_user_id, {
        email: buildAuthEmail(newUsername),
      });
      if (updateErr) return err(`Auth email update failed: ${updateErr.message}`);

      return ok({ success: true });
    }

    // ── reset_password ─────────────────────────────────────────────────────
    if (op === 'reset_password') {
      const { userId, newPassword } = body;
      if (!userId || !newPassword) return err('userId and newPassword are required');

      const { data: userRow, error: lookupErr } = await admin
        .from('users')
        .select('auth_user_id')
        .eq('id', userId)
        .single();
      if (lookupErr || !userRow) return err('User not found');
      if (!userRow.auth_user_id) return err('User has no linked auth account');

      const { error: pwErr } = await admin.auth.admin.updateUserById(userRow.auth_user_id, {
        password: newPassword,
      });
      if (pwErr) return err(`Password reset failed: ${pwErr.message}`);

      return ok({ success: true });
    }

    // ── delete ─────────────────────────────────────────────────────────────
    if (op === 'delete') {
      const { userId } = body;
      if (!userId) return err('userId is required');

      const { data: userRow, error: lookupErr } = await admin
        .from('users')
        .select('auth_user_id')
        .eq('id', userId)
        .single();
      if (lookupErr || !userRow) return err('User not found');

      // Delete auth account FIRST so that if it fails we leave the profile intact
      // (orphaned auth account is worse than a dangling profile — auth account
      // can still be used to log in).
      if (userRow.auth_user_id) {
        const { error: authDelErr } = await admin.auth.admin.deleteUser(userRow.auth_user_id);
        if (authDelErr) return err('Auth account deletion failed. Profile not deleted.');
      }

      const { error: deleteErr } = await admin
        .from('users')
        .delete()
        .eq('id', userId);
      if (deleteErr) {
        // Auth account is already gone; log the orphan for manual cleanup.
        console.error(`Profile deletion failed after auth delete for userId ${userId}`);
        return err('Profile deletion failed after auth account was removed. Contact an admin.');
      }

      return ok({ success: true });
    }

    return err(`Unknown op: "${op}"`);

  } catch (e) {
    console.error('admin-user-ops unhandled:', e);
    return err('An unexpected error occurred. Check function logs for details.', 500);
  }
});
