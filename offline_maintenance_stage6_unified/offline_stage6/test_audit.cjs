'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {audit}=require('./audit.cjs');
const i=process.argv.indexOf('--input'),dir=path.resolve(i<0?'stage6_results':process.argv[i+1]);
const positive=audit(dir);const controls=[];const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'stage6-audit-negative-'));
const mutations=[
  ['summary_count','completion.json',d=>{d.benchmark_runs++;}],
  ['signature','faults.json',d=>{const x=d.find(x=>x.gateway.ops.some(o=>o.record)).gateway.ops.find(o=>o.record);const r=JSON.parse(x.record);r.signature=Buffer.alloc(64).toString('base64');x.record=JSON.stringify(r);}],
  ['quota','faults.json',d=>{d[0].gateway.grants[0].used++;}],
  ['missing_receipt','live_check.json',d=>{d.receipts.pop();}],
  ['pending_as_done','faults.json',d=>{d.find(x=>x.id==='U03').gateway.ops[0].state='DONE';}]
];
try{for(const [name,file,mutate]of mutations){const copy=path.join(tmp,name);fs.cpSync(dir,copy,{recursive:true});const p=path.join(copy,file),d=JSON.parse(fs.readFileSync(p));mutate(d);fs.writeFileSync(p,JSON.stringify(d));
  let rejected=false,reason;try{audit(copy);}catch(e){rejected=true;reason=String(e);}controls.push({name,rejected,reason});if(!rejected)throw Error('Negative control accepted: '+name);}}
finally{fs.rmSync(tmp,{recursive:true,force:true});}
const out={positive_control_passed:positive.audit_success,controls};fs.writeFileSync(path.join(dir,'negative_controls.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out));
