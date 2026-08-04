import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { isSupabaseConfigured } from './lib/supabase';
import ProtectedRoute from './components/ProtectedRoute';
import AppLayout from './components/AppLayout';
import Login from './pages/Login';
import MyAttendance from './pages/MyAttendance';
import DailyActivities from './pages/DailyActivities';
import SitesDB from './pages/SitesDB';
import Dashboard from './pages/Dashboard';
import MyExpenses from './pages/MyExpenses';
import MyProfile from './pages/MyProfile';
import MyTrips from './pages/MyTrips';
import LiveTrips from './pages/LiveTrips';
import RoutePlanner from './pages/RoutePlanner';
import HrProfiles from './pages/HrProfiles';
import AttendanceAdmin from './pages/AttendanceAdmin';
import NetworkScopes from './pages/NetworkScopes';
import SiteLookup from './pages/SiteLookup';
import FinTeam from './pages/FinTeam';
import FinRevenue from './pages/FinRevenue';
import FinGenExp from './pages/FinGenExp';
import FinProjExp from './pages/FinProjExp';
import FinDashboard from './pages/FinDashboard';
import FinReport from './pages/FinReport';
import FinClients from './pages/FinClients';
import FinInvoices from './pages/FinInvoices';
import FinExpClaims from './pages/FinExpClaims';
import FinCars from './pages/FinCars';
import FinPayslips from './pages/FinPayslips';
import FinPerformance from './pages/FinPerformance';
import ActivityLog from './pages/ActivityLog';
import UserManagement from './pages/UserManagement';
import BackupRestore from './pages/BackupRestore';
import MyWork from './pages/MyWork';
import MySites from './pages/MySites';

function RoleRedirect() {
  const { currentUser, loading } = useAuth();
  if (loading) return null;
  const role = currentUser?.role?.toLowerCase();
  if (role === 'engineer' || role === 'technician') return <Navigate to="/my-work" replace />;
  return <Navigate to="/attendance" replace />;
}

// Shown instead of the app when VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// are missing, so a blank or mid-migration .env fails safely with a clear
// message rather than crashing or silently reaching another project.
function ConfigurationMissing() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      textAlign: 'center',
    }}>
      <div style={{ maxWidth: 460 }}>
        <h1 style={{ fontSize: 20, marginBottom: 12 }}>Configuration required</h1>
        <p style={{ color: '#555', lineHeight: 1.5, margin: 0 }}>
          This app isn't connected to a Supabase project yet. Set{' '}
          <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>{' '}
          in your <code>.env</code> file (see <code>.env.example</code>), then
          restart the dev server or redeploy.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  if (!isSupabaseConfigured) return <ConfigurationMissing />;

  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/attendance"        element={<MyAttendance />} />
            <Route path="/my-profile"       element={<MyProfile />} />
            <Route path="/my-expenses"      element={<MyExpenses />} />
            <Route path="/my-trips"         element={<MyTrips />} />
            <Route path="/live-trips"       element={<LiveTrips />} />
            <Route path="/route-planner"    element={<RoutePlanner />} />
            <Route path="/daily-activities" element={<DailyActivities />} />
            <Route path="/sites-db"         element={<SitesDB />} />
            <Route path="/hr-profiles"          element={<HrProfiles />} />
            <Route path="/attendance-admin"          element={<AttendanceAdmin />} />
            <Route path="/network-scopes/:proj/:sec" element={<NetworkScopes />} />
            <Route path="/network-scopes"            element={<NetworkScopes />} />
            <Route path="/site-lookup"               element={<SiteLookup />} />
            <Route path="/finance/team"              element={<FinTeam />} />
            <Route path="/finance/revenue"           element={<FinRevenue />} />
            <Route path="/finance/general-expenses"  element={<FinGenExp />} />
            <Route path="/finance/project-expenses"  element={<FinProjExp />} />
            <Route path="/finance/dashboard"          element={<FinDashboard />} />
            <Route path="/finance/monthly-report"     element={<FinReport />} />
            <Route path="/finance/clients"            element={<FinClients />} />
            <Route path="/finance/invoices"           element={<FinInvoices />} />
            <Route path="/finance/expense-claims"     element={<FinExpClaims />} />
            <Route path="/finance/cars"               element={<FinCars />} />
            <Route path="/finance/payslips"           element={<FinPayslips />} />
            <Route path="/finance/performance"        element={<FinPerformance />} />
            <Route path="/activity-log"              element={<ActivityLog />} />
            <Route path="/user-management"           element={<UserManagement />} />
            <Route path="/backup-restore"            element={<BackupRestore />} />
            <Route path="/dashboard"                 element={<Dashboard />} />
            <Route path="/my-work"                   element={<MyWork />} />
            <Route path="/my-sites"                  element={<MySites />} />
            <Route path="/"           element={<RoleRedirect />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
