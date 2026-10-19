// Negative controls: auditor must reject report corruption, bad signatures, future history and missing receipts.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {auditLocal}=require('./audit_benchmark.cjs');const C=require('./common.cjs');
const a=process.argv.slice(2),input=path.resolve(a[a.indexOf('--input')+1]||'stage5_results');
const fixtures=fs.mkdtempSync(path.join(os.tmpdir(),'stage5-audit-'));const report=[];
try{
 auditLocal(input);
 for(const kind of ['metric_corruption','signature_corruption','future_history','missing_receipt']){
  const d=path.join(fixtures,kind);fs.mkdirSync(d);
  for(const n of ['runs.json','scope.json','transactions.json','public_keys.json','spool.json','live_check.json'])fs.copyFileSync(path.join(input,n),path.join(d,n));
  const r=JSON.parse(fs.readFileSync(path.join(d,'runs.json'))),t=JSON.parse(fs.readFileSync(path.join(d,'transactions.json')));
  if(kind==='metric_corruption')r[0].metrics.accepted++;
  if(kind==='signature_corruption')r[0].records[0].record.signature=Buffer.alloc(64).toString('base64');
  if(kind==='future_history')r.find(x=>x.outage_ms).grants[0].history_ms.push(999999);
  if(kind==='missing_receipt')t.splice(t.findIndex(x=>x.kind==='submit'),1);
  C.save(path.join(d,'runs.json'),r);C.save(path.join(d,'transactions.json'),t);
  let reason=null;try{auditLocal(d);}catch(e){reason=String(e);}
  if(!reason)throw Error('Auditor accepted '+kind);report.push({control:kind,rejected:true,reason});
 }
 C.save(path.join(input,'negative_controls.json'),report);console.log(JSON.stringify({positive_control_passed:true,negative_controls:report},null,2));
}finally{fs.rmSync(fixtures,{recursive:true,force:true});}
