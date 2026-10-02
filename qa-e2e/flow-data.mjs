/* Creates a full test chain through the real callables (emulator only):
 * Design KL-0001 (approved) -> Karigar K-0001 -> PR-0001 (qty 3, approved)
 * -> PIECE-0001..0003 generated. Then use the UI per role to move pieces. */
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
async function as(email) {
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-luxardo-flow', authDomain: 'x' }, email);
  const a = getAuth(app); connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true });
  await signInWithEmailAndPassword(a, email, 'Test@12345');
  const f = getFunctions(app, 'us-central1'); connectFunctionsEmulator(f, '127.0.0.1', 5001);
  return (name, data) => httpsCallable(f, name)(data).then((r) => r.data);
}
const designer = await as('designer@test.lux'), owner = await as('owner@test.lux'), dispatch = await as('dispatch@test.lux'), pm = await as('pm@test.lux'), admin = await as('admin@test.lux');
const d = await designer('designCreate', { name: 'Royal Bandhgala Navy', description: 'E2E test design', image: '', images: [] });
await designer('designSubmit', { id: d.id }); await owner('designApprove', { id: d.id });
await admin('karigarCreate', { name: 'Ramesh Karigar', mobile: '9876543210', skillTags: ['embroidery'], hourlyRate: 120 });
const pr = await dispatch('prCreate', { designId: d.id, designVersionId: `${d.id}-v1`, quantity: 3, urgency: 'HIGH', garmentType: 'Bandhgala' });
await dispatch('prSubmit', { id: pr.id }); await owner('prApprove', { id: pr.id });
console.log(await pm('prGeneratePieces', { prId: pr.id, count: 3 }));
process.exit(0);
