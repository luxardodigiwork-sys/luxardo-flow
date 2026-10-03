/* V1 UI acceptance (emulators only): fabric screens + Owner rules in a real
 * browser. Run after `npm run seed` and `npm run v1-backend`. */
import fs from 'fs';
import { session, buttons } from './lib.mjs';
const BASE = process.env.BASE_URL || 'http://localhost:4173';
fs.mkdirSync('shots', { recursive: true });
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const txt = async p => (await p.locator('body').innerText()).replace(/\s+/g, ' ');
const go = async (p, path) => { await p.goto(BASE + path); await p.waitForTimeout(2500); };

// 1. Dispatch: inventory, stock-in, add fabric
{ const { b, p, log } = await session('dispatch');
  const nav = await p.locator('aside nav a').evaluateAll(a => a.map(x => x.innerText.trim()));
  ok(nav.includes('Fabric Inventory') && nav.includes('Fabric Issues'), 'dispatch sidebar has Fabric Inventory + Fabric Issues');
  await go(p, '/production/fabric');
  ok(await p.getByTestId('low-stock-banner').isVisible(), 'low-stock banner shows Navy Wool');
  await p.getByTestId('fabric-row-FAB-0001').getByRole('button', { name: /stock in/i }).click();
  await p.getByPlaceholder('Meters received *').fill('20');
  await p.getByPlaceholder('Supplier').fill('Raymond');
  await p.getByRole('button', { name: /add to stock/i }).click(); await p.waitForTimeout(3000);
  ok((await txt(p)).includes('20 m added to stock'), 'stock-in via UI');
  ok((await p.getByTestId('fabric-row-FAB-0001').innerText()).includes('25.00'), 'navy stock now 25.00 m');
  await p.getByRole('button', { name: /add fabric/i }).first().click();
  await p.getByPlaceholder('Fabric name *').fill('Cotton Test');
  await p.getByPlaceholder('Low-stock alert at (m) *').fill('3');
  await p.getByPlaceholder('Opening stock (m)').fill('40');
  await p.getByRole('button', { name: /save fabric/i }).click(); await p.waitForTimeout(3000);
  ok((await txt(p)).includes('Cotton Test'), 'add fabric via UI');
  await p.screenshot({ path: 'shots/v1-fabric-inventory.png', fullPage: true });
  ok(log.filter(l => !l.includes('404')).length === 0, 'dispatch: no console errors ' + JSON.stringify(log.filter(l => !l.includes('404'))));
  await b.close(); }

// 2. Designer: guide visible + editable on design page; photo field on create
{ const { b, p, log } = await session('designer');
  await go(p, '/production/designs/KL-0001');
  const sec = p.getByTestId('fabric-guide-section');
  ok(await sec.isVisible(), 'design page shows Fabric per piece');
  ok((await sec.locator('select').count()) === 2, 'existing 2 guide lines loaded');
  await go(p, '/production/designs/new');
  ok(await p.getByTestId('design-photo').count() === 1, 'design create has camera/gallery photo field');
  await p.getByTestId('design-photo').setInputFiles('../qa-e2e/garment.jpg').catch(() => {});
  await b.close(); }

// 3. Dispatch issues fabric for PR-0002 to Guard via UI
{ const { b, p, log } = await session('dispatch');
  await go(p, '/production/requests/PR-0002');
  const sec = p.getByTestId('pr-fabric-section');
  ok(await sec.isVisible(), 'PR page shows Fabric section');
  const t = await sec.innerText();
  ok(/2\.5 m × 5 = 12\.5 m/.test(t.replace(/\s+/g, ' ')), 'PR shows 2.5 m × 5 = 12.5 m');
  await p.getByTestId('issue-guard-select').selectOption({ index: 1 });
  await sec.getByRole('button', { name: /issue fabric/i }).click(); await p.waitForTimeout(3500);
  const after = (await sec.innerText()).replace(/\s+/g, ' ');
  ok(/Fabric issued \(FI-/.test(after) || /issued to/.test(after), 'fabric issued via UI: ' + after.slice(0, 160));
  ok(/Low stock now: Satin Lining/.test(after), 'low stock alert message (Satin 0.4 m left)');
  await p.screenshot({ path: 'shots/v1-pr-fabric.png', fullPage: true });
  await b.close(); }

// 4. Guard confirms
{ const { b, p, log } = await session('guard');
  await p.waitForTimeout(3000);
  ok(await p.getByTestId('dashboard-fabric-pending').isVisible(), 'guard dashboard shows fabric waiting');
  await go(p, '/production/fabric-issues');
  await p.getByRole('button', { name: /confirm received/i }).first().click(); await p.waitForTimeout(3000);
  ok(!(await p.getByRole('button', { name: /confirm received/i }).count()), 'guard confirmed receipt');
  await p.screenshot({ path: 'shots/v1-guard-issues.png', fullPage: true });
  await b.close(); }

// 5. Owner low-stock banner
{ const { b, p, log } = await session('owner');
  await p.waitForTimeout(3000);
  console.log('   owner console:', JSON.stringify(log.filter(l => !l.includes('404'))));
  const banner = p.getByTestId('dashboard-low-stock');
  ok(await banner.isVisible() && /Satin Lining/.test(await banner.innerText()), 'owner dashboard low-stock banner (Satin Lining)');
  await b.close(); }

// 6. PM rules in UI on PR-0002 pieces
{ const { b, p } = await session('pm');
  await go(p, '/production/requests/PR-0002');
  const gen = p.getByRole('button', { name: /generate/i }).first();
  if (await gen.count()) { await gen.click(); await p.waitForTimeout(800); const c = p.getByRole('button', { name: /confirm|generate/i }); if (await c.count() > 1) await c.last().click(); await p.waitForTimeout(3000); }
  await go(p, '/production/pieces');
  const ids = [...new Set((await txt(p)).match(/PIECE-\d{4}/g) || [])].sort();
  const pid = ids[ids.length - 1];
  await go(p, '/production/pieces/' + pid);
  ok(!(await p.getByRole('button', { name: /mark rework/i }).count()), `Mark Rework hidden on OPEN ${pid}`);
  await p.locator('select:visible').first().selectOption({ index: 1 });
  await p.getByRole('button', { name: /^assign karigar$/i }).click(); await p.waitForTimeout(2500);
  await p.locator('select:visible').last().selectOption({ index: 1 });
  await p.getByRole('button', { name: /start session/i }).click(); await p.waitForTimeout(3000);
  const qc = p.getByRole('button', { name: 'QC_PENDING' });
  ok(await qc.isDisabled(), 'QC_PENDING disabled while session running');
  ok((await txt(p)).includes('Stop it before sending this piece to QC'), 'hint shown');
  await p.getByRole('button', { name: 'Stop', exact: true }).click(); await p.waitForTimeout(3000);
  ok(await p.getByRole('button', { name: 'QC_PENDING' }).isEnabled(), 'QC_PENDING enabled after stop');
  await p.screenshot({ path: 'shots/v1-pm-rules.png', fullPage: true });
  await b.close(); }

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
