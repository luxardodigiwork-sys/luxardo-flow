import RoleLoginPage from '../../components/auth/RoleLoginPage';

/**
 * The ONE common LUXARDO FLOW staff login page.
 *
 * Every operational staff role signs in here: designer, pm, dispatch, guard,
 * tailor, store, accounts, analysis. Identity + role are resolved from
 * staff/{uid} — the canonical, server-enforced source — and the user is
 * routed to /production, where the role decides what renders.
 *
 * Owner, Admin and Super Admin do NOT use this page — Owner/Super Admin share
 * a dedicated route (/owner/login) and Admin has its own (/admin/login); both
 * offer Google Sign-In. (allowedRoles below is not actually consulted in
 * `common` mode — see RoleLoginPage's isEligibleLoomIdentity-based check —
 * kept here only as accurate documentation of who lands on /production from
 * this page.)
 */
export default function StaffLoginPage() {
  return (
    <RoleLoginPage
      common
      roleLabel="USER"
      allowedRoles={[
        'designer', 'pm', 'dispatch',
        'guard', 'tailor', 'store', 'accounts', 'analysis',
      ]}
      redirectPath="/production"
      lockKey="loom_staff_lock"
      attemptsKey="loom_staff_attempts"
      tagline="LUXARDO FLOW authorised users"
    />
  );
}
