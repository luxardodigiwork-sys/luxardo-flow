import { chromium } from 'playwright';
const BASE=process.env.BASE_URL||'http://localhost:4173';
export async function session(role){
  const b=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  const p=await b.newPage({viewport:{width:1280,height:900}});
  const log=[]; p.on('console',m=>{if(m.type()==='error')log.push(m.text().slice(0,250))});
  p.on('dialog',d=>{log.push('DIALOG '+d.message()); d.accept().catch(()=>{})});
  const priv=['owner','admin','super_admin'].includes(role);
  await p.goto(BASE+(priv?'/admin/login':'/login')); await p.waitForTimeout(1200);
  await p.locator('input[type=email]:visible').first().fill(role==='super_admin'?'luxardodigiwork@gmail.com':role+'@test.lux');
  const pw=p.locator('input[type=password]:visible').first(); await pw.fill('Test@12345'); await pw.press('Enter');
  await p.waitForURL('**/production',{timeout:15000});
  return {b,p,log};
}
export const buttons=p=>p.locator('button:visible').evaluateAll(bs=>bs.map(b=>(b.innerText||'').trim().replace(/\s+/g,' ')+(b.disabled?' [disabled]':'')).filter(Boolean));
export const text=async p=>(await p.locator('main, body').first().innerText()).replace(/\s+/g,' ');
