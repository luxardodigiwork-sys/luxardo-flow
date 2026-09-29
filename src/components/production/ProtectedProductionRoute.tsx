import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Loader2 } from 'lucide-react';
import { isStaffRoleOrSuperAdmin, isLoomHost } from '../../utils/loomIdentity';
import ChangePasswordPage from '../../pages/production/ChangePasswordPage';

/**
 * Production route guard.
 * - Unauthenticated:
 *     - Loom  → /login       (the common LUXARDO FLOW staff sign-in)
 *     - B2C   → /admin/login  (unchanged)
 * - Authenticated without a valid staff identity (canonical staff role or
 *   Super Admin):
 *     - Loom  → /login
 *     - B2C   → /backend      (unchanged)
 * - Authenticated, valid identity, but staff/{uid}.mustChangePassword is
 *   still true (new account / default-password migration): renders the
 *   mandatory Change Password screen INSTEAD OF children, for every
 *   /production/* route — there is no route a User can navigate to that
 *   escapes this, since every one of them mounts through this same guard.
 *   This is a server-truth field (staff/{uid}), never trusted from
 *   localStorage/sessionStorage alone.
 *
 * Beyond that, does NOT check specific roles — per-page role checks are done
 * inside each page using can() from rolePermissions, and every write is
 * re-checked server-side by firestore.loom.rules + the Cloud Functions.
 */
export default function ProtectedProductionRoute({ children }: { children: React.ReactNode }) {
  const { user, isAuthReady } = useAuth();

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-black mx-auto mb-4" />
          <p className="text-xs text-gray-500 uppercase tracking-widest">Loading…</p>
        </div>
      </div>
    );
  }

  const loom = isLoomHost();

  if (!user) return <Navigate to={loom ? '/login' : '/admin/login'} replace />;

  // A legacy / unknown staffRole (e.g. "grade") is treated as no access —
  // fail closed rather than drop the user into a half-broken workspace.
  // Super Admin (staffRole === 'super_admin') is allowed through.
  if (!isStaffRoleOrSuperAdmin(user.staffRole)) {
    return <Navigate to={loom ? '/login' : '/backend'} replace />;
  }

  if (user.mustChangePassword) {
    return <ChangePasswordPage />;
  }

  return <>{children}</>;
}
