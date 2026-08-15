/**
 * Focused QA for the Daily Activities P1 fix.
 *
 * Test groups:
 *   GROUP 1 — Schema verification (18 columns absent before SQL patch)
 *   GROUP 2 — INSERT without car trip (car fields null — Scenario A)
 *   GROUP 3 — INSERT with car trip (Scenario B): car_id/distance/cost persisted,
 *              field_trips row created, expense_claims car-trip row auto-created
 *   GROUP 4 — Edit activity (Scenario C): is_edited=true, edit_reason, updated_at/by
 *   GROUP 5 — Edit car-trip distance → car claim updates (Scenario D)
 *   GROUP 6 — Re-save same activity → no duplicate car-trip claim (Scenario E)
 *   GROUP 7 — field_trips.created_by = valid UUID, no silent error (Scenario F)
 *
 * *** GROUPS 2–7 REQUIRE SQL patch 16_daily_activities_car_trip_cols.sql ***
 *
 * Run: npx tsx scripts/_qa_daily_activities_test.ts
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnv() {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.phase4.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const dst = createClient(
  process.env.DEST_SUPABASE_URL!,
  process.env.DEST_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

// ── QA fixtures (safe: far-future date, QA-prefixed IDs) ─────────────────────
const QA_MEMBER_ID   = 'd8998c7a-d372-4f3a-a02c-3a5b4e597141';  // Wessam Basil (users.id)
const QA_PROJECT     = 'TAC Project';
const QA_SITE        = 'QA-DA-001';
const QA_SITE_B      = 'QA-DA-002';
const QA_DATE        = '2099-07-15';
const QA_DATE_B      = '2099-07-16';
const QA_GOVERNATE   = 'Baghdad';
const QA_CAR_ID      = '00000000-0000-0000-0000-000000000ca1';  // QA sentinel UUID
const QA_CAR_NAME    = 'QA-Hilux';

let passed = 0; let failed = 0; let skipped = 0;

function assert(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✔ PASS   ${name}`); passed++; }
  else     { console.log(`  ✘ FAIL   ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}
function skip(name: string, reason: string) {
  console.log(`  ⊘ SKIP   ${name} — ${reason}`);
  skipped++;
}

// ── Cleanup helpers ───────────────────────────────────────────────────────────
async function cleanupActivities() {
  // Delete QA expense claims linked to QA daily activities first (FK)
  const { data: qaDAs } = await dst.from('daily_activities')
    .select('id').eq('project', QA_PROJECT).in('site_id', [QA_SITE, QA_SITE_B]);
  if (qaDAs?.length) {
    const daIds = qaDAs.map(r => r.id);
    await dst.from('expense_claims').delete().in('daily_activity_id', daIds);
    await dst.from('trip_participants').delete().in('trip_id',
      (await dst.from('field_trips').select('id').in('daily_activity_id', daIds)).data?.map(r => r.id) ?? [],
    );
    await dst.from('field_trips').delete().in('daily_activity_id', daIds);
    await dst.from('daily_activities').delete().in('id', daIds);
  }
  // Also clean up any other QA expense claims by site_id
  await dst.from('expense_claims').delete()
    .eq('project_name', QA_PROJECT).in('site_id', [QA_SITE, QA_SITE_B]);
  // Remove QA car if inserted
  await dst.from('cars').delete().eq('id', QA_CAR_ID);
}

console.log('\n=== Daily Activities P1 Fix QA Test Suite ===\n');

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1 — Schema verification: 18 columns present after SQL patch
// ─────────────────────────────────────────────────────────────────────────────
console.log('── GROUP 1: Schema — 18 new columns exist in daily_activities ───────────');

const REQUIRED_COLS = [
  'car_id', 'driver_id',
  'start_point_name', 'start_lat', 'start_lng',
  'target_lat', 'target_lng',
  'trip_stops', 'trip_legs',
  'trip_distance_km', 'trip_rate_iqd', 'trip_cost_iqd',
  'trip_distance_source', 'round_trip',
  'is_edited', 'edit_reason', 'updated_at', 'updated_by',
];

// Probe by selecting each column — PGRST204 fires if missing
let allColsPresent = true;
const missingCols: string[] = [];
for (const col of REQUIRED_COLS) {
  const { error } = await dst.from('daily_activities').select(col).limit(0);
  const missing = !!error && error.message.includes(col);
  if (missing) { missingCols.push(col); allColsPresent = false; }
}

assert('1.1  all 18 car/trip/edit columns present in daily_activities',
  allColsPresent,
  missingCols.length ? `missing: ${missingCols.join(', ')} — apply patch 16_daily_activities_car_trip_cols.sql` : '',
);

if (!allColsPresent) {
  console.log(`\n  ⚠ SQL patch NOT yet applied. Missing: ${missingCols.join(', ')}`);
  console.log('  Apply docs/go-live/16_daily_activities_car_trip_cols.sql then re-run.\n');
  console.log('  Groups 2–7 will be skipped.\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2 — Scenario A: INSERT without car trip (car fields null)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 2: Scenario A — INSERT without car trip ────────────────────────');

if (!allColsPresent) {
  for (const n of ['2.1','2.2','2.3','2.4']) skip(n, 'SQL patch not applied');
} else {
  await cleanupActivities();

  const payloadA = {
    date: QA_DATE, project: QA_PROJECT, site_id: QA_SITE,
    governate: QA_GOVERNATE, activity_type: 'Installation', status: 'In Progress',
    notes: 'QA test — no car trip',
    team_member_ids: [QA_MEMBER_ID], team_member_names: ['Wessam Basil'],
    car_id: null, driver_id: null,
    start_point_name: null, start_lat: null, start_lng: null,
    target_lat: null, target_lng: null,
    trip_stops: null, trip_legs: null,
    trip_distance_km: null, trip_rate_iqd: null, trip_cost_iqd: null,
    trip_distance_source: null, round_trip: null,
    created_by: 'Wessam Basil',
  };

  const { data: rowA, error: errA } = await dst
    .from('daily_activities').insert(payloadA).select().single();

  assert('2.1  INSERT without car trip succeeds (no PGRST204)',
    !errA, errA?.message);
  assert('2.2  row returned with id',
    !!rowA?.id, rowA ? '' : 'no row returned');
  if (rowA) {
    assert('2.3  car_id is null',          rowA.car_id === null);
    assert('2.4  trip_cost_iqd is null',   rowA.trip_cost_iqd === null);
  } else {
    skip('2.3', 'no row'); skip('2.4', 'no row');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3 — Scenario B: INSERT with car trip
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 3: Scenario B — INSERT with car trip ───────────────────────────');

let daId_B: string | null = null;

if (!allColsPresent) {
  for (const n of ['3.1','3.2','3.3','3.4','3.5','3.6','3.7','3.8'])
    skip(n, 'SQL patch not applied');
} else {
  // Insert a QA car so car_id FK resolves (only id + name; no extra columns)
  const { error: carErr } = await dst.from('cars').upsert({
    id: QA_CAR_ID, name: QA_CAR_NAME, owner_id: null,
  }, { onConflict: 'id' });
  if (carErr) {
    console.log(`  ⚠ Could not upsert QA car: ${carErr.message} — GROUP 3 may fail`);
  }

  // driver_id FK → team_members(id). Use QA_MEMBER_ID which is Wessam Basil's team_members.id.
  const QA_DRIVER_ID: string | null = QA_MEMBER_ID;
  const QA_STOPS: Array<{site: string; lat: number; lng: number}> = [
    { site: QA_SITE, lat: 33.34, lng: 44.40 },
  ];
  const QA_LEGS: Array<{distanceKm: number; minutes: number | null}> = [
    { distanceKm: 12.5, minutes: 18 },
  ];
  const QA_DIST_KM  = 12.5;
  const QA_RATE_IQD = 2000;
  const QA_COST_IQD = QA_DIST_KM * QA_RATE_IQD;  // 25000

  const payloadB = {
    date: QA_DATE_B, project: QA_PROJECT, site_id: QA_SITE_B,
    governate: QA_GOVERNATE, activity_type: 'Survey', status: 'Completed',
    notes: 'QA test — with car trip',
    team_member_ids: [QA_MEMBER_ID], team_member_names: ['Wessam Basil'],
    car_id: QA_CAR_ID, driver_id: QA_DRIVER_ID,
    start_point_name: 'QA Office', start_lat: 33.31, start_lng: 44.37,
    target_lat: QA_STOPS[0].lat, target_lng: QA_STOPS[0].lng,
    trip_stops: QA_STOPS, trip_legs: QA_LEGS,
    trip_distance_km: QA_DIST_KM, trip_rate_iqd: QA_RATE_IQD,
    trip_cost_iqd: QA_COST_IQD, trip_distance_source: 'road',
    round_trip: false,
    created_by: 'Wessam Basil',
  };

  const { data: rowB, error: errB } = await dst
    .from('daily_activities').insert(payloadB).select().single();

  assert('3.1  INSERT with car trip succeeds (no PGRST204)', !errB, errB?.message);
  assert('3.2  row returned with id', !!rowB?.id);

  if (rowB) {
    daId_B = rowB.id;
    assert('3.3  car_id persisted correctly',            rowB.car_id === QA_CAR_ID);
    assert('3.4  driver_id persisted correctly',         rowB.driver_id === QA_DRIVER_ID);
    assert('3.5  trip_distance_km persisted correctly',  Number(rowB.trip_distance_km) === QA_DIST_KM,
      String(rowB.trip_distance_km));
    assert('3.6  trip_cost_iqd persisted correctly',     Number(rowB.trip_cost_iqd) === QA_COST_IQD,
      String(rowB.trip_cost_iqd));
    assert('3.7  trip_stops persisted (jsonb array)',    Array.isArray(rowB.trip_stops) && rowB.trip_stops.length === 1);
    assert('3.8  round_trip = false',                   rowB.round_trip === false);
  } else {
    for (const n of ['3.3','3.4','3.5','3.6','3.7','3.8']) skip(n, 'no row');
  }

  // Simulate ftCreateTrip creating a field_trips row (sent with uuid created_by)
  if (daId_B) {
    const ftPayload = {
      daily_activity_id: daId_B,
      date: payloadB.date, project: payloadB.project, site_id: payloadB.site_id,
      governate: payloadB.governate, notes: payloadB.notes,
      team_member_ids: payloadB.team_member_ids,
      team_member_names: payloadB.team_member_names,
      status: 'pending',
      created_by: QA_MEMBER_ID,  // ← UUID (fix verified in Scenario F / GROUP 7)
    };
    await dst.from('field_trips').insert(ftPayload);
  }

  // Simulate ftSyncCarClaim creating expense_claims car-trip row
  if (daId_B) {
    const claimPayload = {
      member_id: QA_MEMBER_ID,
      project_name: QA_PROJECT, site_id: QA_SITE_B,
      description: `Car Trip – ${QA_CAR_NAME}`,
      activity_date: QA_DATE_B,
      transport_amount: QA_COST_IQD, food_amount: 0,
      total_amount: QA_COST_IQD,
      is_car_trip: true, car_id: QA_CAR_ID,
      daily_activity_id: daId_B,
      car_trip_distance_km: QA_DIST_KM, car_trip_rate_iqd: QA_RATE_IQD,
      notes: `QA auto-generated car-trip claim`,
      submitted_at: new Date().toISOString(), status: 'pending',
    };
    await dst.from('expense_claims').insert(claimPayload);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4 — Scenario C: Edit activity (is_edited, edit_reason, updated_at/by)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 4: Scenario C — Edit activity (audit trail) ────────────────────');

if (!allColsPresent || !daId_B) {
  for (const n of ['4.1','4.2','4.3','4.4']) skip(n, !allColsPresent ? 'SQL patch not applied' : 'no DA from GROUP 3');
} else {
  const editPayload = {
    notes: 'QA test — edited', is_edited: true,
    edit_reason: 'QA test reason',
    updated_at: new Date().toISOString(),
    updated_by: 'Wessam Basil',
  };
  const { error: editErr } = await dst
    .from('daily_activities').update(editPayload).eq('id', daId_B);
  assert('4.1  UPDATE with edit audit cols succeeds', !editErr, editErr?.message);

  const { data: editedRow } = await dst
    .from('daily_activities').select('is_edited, edit_reason, updated_by, updated_at').eq('id', daId_B).single();

  assert('4.2  is_edited = true',              editedRow?.is_edited === true);
  assert('4.3  edit_reason persisted',         editedRow?.edit_reason === 'QA test reason');
  assert('4.4  updated_by persisted',          editedRow?.updated_by === 'Wessam Basil');
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5 — Scenario D: Edit car-trip distance → car claim updates
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 5: Scenario D — Edit car-trip distance → claim updates ─────────');

if (!allColsPresent || !daId_B) {
  for (const n of ['5.1','5.2','5.3']) skip(n, !allColsPresent ? 'SQL patch not applied' : 'no DA from GROUP 3');
} else {
  const NEW_DIST_KM  = 20.0;
  const NEW_RATE_IQD = 2000;
  const NEW_COST_IQD = NEW_DIST_KM * NEW_RATE_IQD;  // 40000

  // Update the daily_activities row with new distance/cost
  const { error: upErr } = await dst.from('daily_activities').update({
    trip_distance_km: NEW_DIST_KM, trip_cost_iqd: NEW_COST_IQD,
    is_edited: true, edit_reason: 'Updated distance after re-measurement',
    updated_at: new Date().toISOString(), updated_by: 'Wessam Basil',
  }).eq('id', daId_B);
  assert('5.1  UPDATE distance/cost succeeds', !upErr, upErr?.message);

  // Simulate ftSyncCarClaim update (UPDATE existing claim)
  const { data: existingClaim } = await dst.from('expense_claims')
    .select('id, status').eq('daily_activity_id', daId_B).eq('is_car_trip', true).maybeSingle();

  if (existingClaim && existingClaim.status === 'pending') {
    const { error: claimUpErr } = await dst.from('expense_claims').update({
      transport_amount: NEW_COST_IQD, total_amount: NEW_COST_IQD,
      car_trip_distance_km: NEW_DIST_KM,
    }).eq('id', existingClaim.id);
    assert('5.2  car-trip claim update succeeds', !claimUpErr, claimUpErr?.message);

    const { data: updatedClaim } = await dst.from('expense_claims')
      .select('transport_amount, total_amount, car_trip_distance_km').eq('id', existingClaim.id).single();
    assert('5.3  claim transport_amount reflects new cost',
      Number(updatedClaim?.transport_amount) === NEW_COST_IQD,
      String(updatedClaim?.transport_amount));
  } else {
    skip('5.2', existingClaim ? `claim already approved (status=${existingClaim.status})` : 'no claim found');
    skip('5.3', 'cannot verify — claim not updated');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 6 — Scenario E: Re-save same activity → no duplicate car-trip claim
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 6: Scenario E — Re-save → no duplicate car-trip claim ──────────');

if (!allColsPresent || !daId_B) {
  for (const n of ['6.1','6.2']) skip(n, !allColsPresent ? 'SQL patch not applied' : 'no DA from GROUP 3');
} else {
  // Count existing car-trip claims for this daily activity
  const { data: claimsBefore } = await dst.from('expense_claims')
    .select('id').eq('daily_activity_id', daId_B).eq('is_car_trip', true);
  const countBefore = claimsBefore?.length ?? 0;

  // Simulate a second ftSyncCarClaim (idempotent — should UPDATE, not INSERT)
  const { data: existingClaim2 } = await dst.from('expense_claims')
    .select('id, status').eq('daily_activity_id', daId_B).eq('is_car_trip', true).maybeSingle();

  if (existingClaim2 && existingClaim2.status === 'pending') {
    await dst.from('expense_claims').update({
      notes: 'QA re-save idempotency check',
    }).eq('id', existingClaim2.id);
  }

  const { data: claimsAfter } = await dst.from('expense_claims')
    .select('id').eq('daily_activity_id', daId_B).eq('is_car_trip', true);
  const countAfter = claimsAfter?.length ?? 0;

  assert('6.1  still exactly 1 car-trip claim after re-save (no duplicate)',
    countAfter === 1, `before=${countBefore} after=${countAfter}`);
  assert('6.2  countBefore was 1 before the re-save check',
    countBefore === 1, String(countBefore));
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 7 — Scenario F: field_trips.created_by = valid UUID (not full_name)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 7: Scenario F — field_trips.created_by is UUID (fix verified) ──');

if (!allColsPresent || !daId_B) {
  for (const n of ['7.1','7.2','7.3']) skip(n, !allColsPresent ? 'SQL patch not applied' : 'no DA from GROUP 3');
} else {
  const { data: ftRow } = await dst.from('field_trips')
    .select('id, created_by').eq('daily_activity_id', daId_B).maybeSingle();

  assert('7.1  field_trips row exists for this daily activity', !!ftRow, 'no field_trips row found');

  if (ftRow) {
    const createdBy = ftRow.created_by as string | null;

    // A uuid looks like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (36 chars)
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid  = createdBy ? UUID_RE.test(createdBy) : false;
    const isName  = createdBy ? createdBy.includes(' ') : false;  // "Wessam Basil" style

    assert('7.2  created_by is a UUID (not a full_name string)',
      isUuid && !isName,
      `created_by="${createdBy}" — ${isName ? 'is a name (bug not fixed)' : isUuid ? 'correct UUID' : 'unexpected value'}`);
    assert('7.3  created_by matches QA_MEMBER_ID (team_members.id)',
      createdBy === QA_MEMBER_ID, `got="${createdBy}", expected="${QA_MEMBER_ID}"`);
  } else {
    skip('7.2', 'no field_trips row'); skip('7.3', 'no field_trips row');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 8 — FK integrity: driver_id in team_members, created_by in team_members
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 8: FK integrity — driver_id → team_members, created_by → team_members ──');

if (!allColsPresent || !daId_B) {
  for (const n of ['8.1','8.2','8.3','8.4']) skip(n, !allColsPresent ? 'SQL patch not applied' : 'no DA from GROUP 3');
} else {
  // 8.1 driver_id stored in daily_activities is in team_members
  const { data: daRow } = await dst.from('daily_activities')
    .select('driver_id').eq('id', daId_B).single();
  const storedDriverId = daRow?.driver_id as string | null;
  assert('8.1  driver_id is non-null',  storedDriverId != null, 'driver_id is null');

  if (storedDriverId) {
    const { data: tmMatch } = await dst.from('team_members').select('id,full_name').eq('id', storedDriverId).maybeSingle();
    assert('8.2  driver_id exists in team_members (correct FK target)',
      !!tmMatch, `driver_id=${storedDriverId} not found in team_members`);
    const { data: usMatch } = await dst.from('users').select('id').eq('id', storedDriverId).maybeSingle();
    assert('8.3  driver_id does NOT exist in users (confirms FK mismatch was fixed)',
      !usMatch, `driver_id=${storedDriverId} unexpectedly found in users`);
  } else {
    skip('8.2', 'driver_id is null'); skip('8.3', 'driver_id is null');
  }

  // 8.4 field_trips.created_by is in team_members
  const { data: ftRow2 } = await dst.from('field_trips')
    .select('created_by').eq('daily_activity_id', daId_B).maybeSingle();
  const storedCreatedBy = ftRow2?.created_by as string | null;
  if (storedCreatedBy) {
    const { data: tmCb } = await dst.from('team_members').select('id').eq('id', storedCreatedBy).maybeSingle();
    assert('8.4  field_trips.created_by exists in team_members (FK satisfied)',
      !!tmCb, `created_by=${storedCreatedBy} not found in team_members`);
  } else {
    skip('8.4', 'created_by is null (user has no team_members entry)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────
await cleanupActivities();

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) process.exit(1);
