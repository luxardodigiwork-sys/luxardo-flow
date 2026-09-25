import RoleLoginPage from '../../components/auth/RoleLoginPage';

/**
 * The ONE common LUXARDO FLOW staff login page.
 *
 * Every non-Super-Admin role signs in here (owner, admin, designer, pm,
 * dispatch, guard, tailor, store, accounts, analysis). Identity + role are
 * resolved from staff/{uid} — the canonical, server-enforced source — and the
 * user is routed to /production, where the role decides what renders.
 *
 * Super Admin does NOT use this page; it has a dedicated route (/admin/login).
 */
export default function StaffLoginPage() {
  return (
    <RoleLoginPage
      common
      roleLabel="USER"
      allowedRoles={[
        'owner', 'admin', 'designer', 'pm', 'dispatch',
        'guard', 'tailor', 'store', 'accounts', 'analysis',
      ]}
      redirectPath="/production"
      lockKey="loom_staff_lock"
      attemptsKey="loom_staff_attempts"
      tagline="LUXARDO FLOW authorised users"
    />
  );
}
