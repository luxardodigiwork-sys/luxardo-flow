/* V1 backend acceptance test (emulators only): fabric inventory + Owner rules.
 * Run after `npm run seed` on fresh emulators: `npm run v1-backend`. */
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore, connectFirestoreEmulator, doc, getDoc } from 'firebase/firestore';
let n=0;
async function as(email){ const app=initializeApp({apiKey:'demo-key',projectId:'demo-luxardo-flow',authDomain:'x'},email+(n++)); const a=getAuth(app); connectAuthEmulator(a,'http://127.0.0.1:9099',{disableWarnings:true}); const c=await signInWithEmailAndPassword(a,email,'Test@12345'); const f=getFunctions(app,'us-central1'); connectFunctionsEmulator(f,'127.0.0.1',5001); const db=getFirestore(app); connectFirestoreEmulator(db,'127.0.0.1',8080); const call=(nm,d)=>httpsCallable(f,nm)(d).then(r=>r.data); call.uid=c.user.uid; call.db=db; return call; }
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('PASS',m)} else {fail++;console.log('FAIL',m)} };
const rejects=async(p,re,m)=>{ try{await p; ok(false,m+' (did not throw)')}catch(e){ ok(re.test(e.message),m+' -> '+e.message) } };
const designer=await as('designer@test.lux'), owner=await as('owner@test.lux'), dispatch=await as('dispatch@test.lux'), pm=await as('pm@test.lux'), admin=await as('admin@test.lux'), guard=await as('guard@test.lux'), tailor=await as('tailor@test.lux'), store=await as('store@test.lux');
const pr0=async(id)=> (await getDoc(doc(owner.db,'productionRequests',id))).data();
// design
const d=await designer('designCreate',{name:'Bandhgala V1',description:'t',image:'',images:[]}); await designer('designSubmit',{id:d.id}); await owner('designApprove',{id:d.id});
// fabric
const f1=await dispatch('fabricCreate',{name:'Navy Wool',colour:'navy',lowStockMeters:5,openingMeters:0}); ok(f1.id.startsWith('FAB-'),'fabric created '+f1.id);
const f2=await dispatch('fabricCreate',{name:'Satin Lining',lowStockMeters:2,openingMeters:10});
await rejects(dispatch('fabricCreate',{name:'navy wool',lowStockMeters:1}),/already exists/,'duplicate fabric name blocked');
await rejects(pm('fabricStockIn',{fabricId:f1.id,meters:5}),/Dispatch\/Admin\/Owner/,'PM cannot stock-in');
const si=await dispatch('fabricStockIn',{fabricId:f1.id,meters:12.5,supplier:'Raymond',billNumber:'B-77'}); ok(si.stockMeters===12.5,'stock-in 12.5 m');
await rejects(dispatch('fabricStockIn',{fabricId:f1.id,meters:-3}),/positive/,'negative stock-in blocked');
await rejects(guard('designFabricGuideSet',{designId:d.id,lines:[{fabricId:f1.id,metersPerPiece:2}]}),/Designer/,'guard cannot set guide');
await designer('designFabricGuideSet',{designId:d.id,lines:[{fabricId:f1.id,metersPerPiece:2.5},{fabricId:f2.id,metersPerPiece:1.2}]});
// PR
const k=await admin('karigarCreate',{name:'Ramesh',mobile:'9876543210',skillTags:['emb'],hourlyRate:120});
const pr=await dispatch('prCreate',{designId:d.id,designVersionId:d.id+'-v1',quantity:3,urgency:'HIGH',garmentType:'Bandhgala'});
await dispatch('prSubmit',{id:pr.id});
await rejects(dispatch('fabricIssueCreate',{prId:pr.id,guardUid:guard.uid}),/Owner-approved/,'cannot issue fabric before approval');
await owner('prApprove',{id:pr.id});
// need 7.5 Navy (have 12.5), 3.6 Satin (have 10)
await rejects(dispatch('fabricIssueCreate',{prId:pr.id,guardUid:pm.uid}),/active Guard/,'issue only to a guard');
const iss=await dispatch('fabricIssueCreate',{prId:pr.id,guardUid:guard.uid,note:'cutting'});
ok(iss.issue.totalMeters===11.1,'auto requirement 3x(2.5+1.2)=11.1 m -> '+iss.issue.totalMeters);
const fm1=(await getDoc(doc(owner.db,'fabricMasters',f1.id))).data(), fm2=(await getDoc(doc(owner.db,'fabricMasters',f2.id))).data();
ok(fm1.stockMeters===5 && fm1.lowStock===true,'navy stock 12.5-7.5=5, low-stock flag on');
ok(Math.abs(fm2.stockMeters-6.4)<1e-9 && fm2.lowStock===false,'satin 10-3.6=6.4');
ok(iss.lowStockAlerts.includes('Navy Wool'),'low-stock alert raised for Navy Wool');
await rejects(dispatch('fabricIssueCreate',{prId:pr.id,guardUid:guard.uid}),/already issued/,'second issue for same PR blocked');
await rejects(tailor('fabricIssueReceive',{issueId:iss.id}),/Guard/,'tailor cannot receive');
await guard('fabricIssueReceive',{issueId:iss.id});
ok((await getDoc(doc(guard.db,'fabricIssues',iss.id))).data().status==='RECEIVED','guard received fabric');
// insufficient stock
const pr2=await dispatch('prCreate',{designId:d.id,designVersionId:d.id+'-v1',quantity:5,urgency:'LOW'}); await dispatch('prSubmit',{id:pr2.id}); await owner('prApprove',{id:pr2.id});
await rejects(dispatch('fabricIssueCreate',{prId:pr2.id,guardUid:guard.uid}),/Not enough fabric/,'insufficient stock blocked');
ok((await getDoc(doc(owner.db,'fabricMasters',f1.id))).data().stockMeters===5,'stock unchanged after failed issue');
// pieces + rules
const g=await pm('prGeneratePieces',{prId:pr.id,count:3}); const [p1,p2,p3]=g.pieceIds;
ok((await pr0(pr.id)).status==='APPROVED','PR still APPROVED before work');
await rejects(pm('recordRework',{pieceId:p1,reason:'x'}),/OPEN/,'rework on OPEN blocked');
await pm('pieceAssignKarigar',{pieceId:p1,karigarId:k.id});
const ls=await pm('labourStart',{pieceId:p1,karigarId:k.id});
ok((await pr0(pr.id)).status==='IN_PRODUCTION','PR auto -> IN_PRODUCTION on first work');
await rejects(pm('recordPieceMovement',{pieceId:p1,toStage:'QC_PENDING',action:'STAGE_MOVE',direction:'FORWARD'}),/Stop the running karigar session/,'QC blocked while labour running');
await pm('labourStop',{sessionId:ls.sessionId});
await pm('recordPieceMovement',{pieceId:p1,toStage:'QC_PENDING',action:'STAGE_MOVE',direction:'FORWARD'});
ok(true,'QC allowed after labour stopped');
await rejects(pm('prGeneratePieces',{prId:pr.id,count:1}),/already generated|No pieces/,'generate still validated in IN_PRODUCTION');
// complete all 3 through store-out; reject none
const tl=(await dispatch('listActiveTailors',{})).tailors[0].uid;
for(const p of [p1,p2,p3]){
  if(p!==p1){ await pm('recordPieceMovement',{pieceId:p,toStage:'IN_WORK',action:'STAGE_MOVE',direction:'FORWARD'}); await pm('recordPieceMovement',{pieceId:p,toStage:'QC_PENDING',action:'STAGE_MOVE',direction:'FORWARD'}); }
  await guard('guardQcPerform',{pieceId:p,verdict:'PASS'});
  await dispatch('dispatchSendToStore',{pieceId:p});
}
const so1=await store('storeOutCreate',{pieceIds:[p1,p2],billNumber:'INV-1'});
ok((await pr0(pr.id)).status==='IN_PRODUCTION','2 of 3 delivered -> still IN_PRODUCTION');
await store('storeOutCreate',{pieceIds:[p3],billNumber:'INV-2'});
const fin=await pr0(pr.id); ok(fin.status==='COMPLETED' && fin.completedQty===3,'all 3 delivered -> COMPLETED');
// post-approval edit allowed in IN_PRODUCTION for pr2? pr2 is APPROVED; test edit on a started PR
console.log(`\nRESULT pass=${pass} fail=${fail}`); process.exit(fail?1:0);
