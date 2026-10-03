/* Logs in as every role, clicks every sidebar + dashboard link, and reports
 * any link that redirects, shows a permission message, or logs an error. */
import {session} from './lib.mjs';
const res={};
for(const role of ['owner','admin','super_admin','designer','pm','dispatch','guard','tailor','store','accounts','analysis']){
  const {b,p,log}=await session(role);
  const links=await p.locator('aside nav a').evaluateAll(a=>a.map(x=>[x.innerText.trim(),x.getAttribute('href')]));
  const quick=await p.locator('main a[href^="/production"]').evaluateAll(a=>a.map(x=>x.getAttribute('href')));
  const bad=[];
  for(const [label,href] of [...links, ...quick.map(h=>['quick',h])]){
    log.length=0; await p.goto((process.env.BASE_URL||'http://localhost:4173')+href); await p.waitForTimeout(1500);
    const t=(await p.locator('body').innerText()).replace(/\s+/g,' ');
    const errs=log.filter(l=>!l.includes('404'));
    if(!p.url().endsWith(href) || /permission|not authori/i.test(t) || errs.length) bad.push(`${label} ${href} -> ${p.url().replace((process.env.BASE_URL||'http://localhost:4173'),'')} ${errs.slice(0,1)}`);
  }
  res[role]={links:links.map(l=>l[0]).join(', '),bad};
  console.log(role.padEnd(11),'|',res[role].links,'| BROKEN:',bad.length?bad:'none');
  await b.close();
}
