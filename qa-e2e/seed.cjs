/* Seeds ONE test login per LUXARDO FLOW role into the LOCAL emulators only.
 * Password for all: Test@12345   Emails: <role>@test.lux  (+ super admin) */
if (!process.env.FIRESTORE_EMULATOR_HOST) process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const path = require('path');
const admin = require(require.resolve('firebase-admin', { paths: [path.join(__dirname, '..', 'functions')] }));
admin.initializeApp({ projectId: 'demo-luxardo-flow' });
const ROLES = ['owner', 'admin', 'designer', 'pm', 'dispatch', 'guard', 'tailor', 'store', 'accounts', 'analysis'];
(async () => {
  const users = [...ROLES.map((r) => ({ email: `${r}@test.lux`, role: r })), { email: 'luxardodigiwork@gmail.com', role: 'super_admin' }];
  for (const u of users) {
    let rec;
    try { rec = await admin.auth().getUserByEmail(u.email); }
    catch { rec = await admin.auth().createUser({ email: u.email, password: 'Test@12345', displayName: `${u.role.toUpperCase()} Test` }); }
    const now = new Date().toISOString();
    await admin.firestore().doc(`staff/${rec.uid}`).set({ uid: rec.uid, displayName: `${u.role.toUpperCase()} Test`, email: u.email, role: u.role, active: true, phoneNumber: null, mustChangePassword: false, createdAt: now, updatedAt: now, createdBy: 'seed' });
    await admin.firestore().doc(`customers/${rec.uid}`).set({ uid: rec.uid, email: u.email, name: u.role, role: u.role, staffRole: u.role, createdAt: now }, { merge: true });
    console.log(u.role.padEnd(12), u.email);
  }
  process.exit(0);
})();
