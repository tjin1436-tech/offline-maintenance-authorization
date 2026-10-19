'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');const C=require('./common.cjs');
const {audit}=require('./audit_ablation.cjs');const {assert}=require('./net.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const base=path.resolve(process.argv[2]||'stage7_results');
audit(base,false);
const controls=[
  ['completion_count',dir=>{const f=path.join(dir,'completion.json'),j=read(f);j.cases++;C.save(f,j);}],
  ['grant_signature',dir=>{const id=read(path.join(dir,'completion.json')).case_ids[0],f=path.join(dir,'cases',id,'case.json'),j=read(f);j.grant.signature=Buffer.alloc(64).toString('base64');C.save(f,j);}],
  ['database_quota',dir=>{const id=read(path.join(dir,'completion.json')).case_ids[0],d=new DatabaseSync(path.join(dir,'cases',id,'gateway.sqlite'));d.exec('UPDATE grants SET used=0');d.close();}],
  ['transaction_omission',dir=>{const f=path.join(dir,'transactions.json'),j=read(f);j.pop();C.save(f,j);}],
  ['kill_evidence_omission',dir=>{const f=path.join(dir,'process_events.json'),j=read(f);j.splice(j.findIndex(x=>x.type==='FORCED_TERMINATION'),1);C.save(f,j);}]
];
const results=[];
for(const [name,mutate] of controls){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'stage7-audit-control-'));
  try{
    fs.cpSync(base,temp,{recursive:true,filter:src=>!path.relative(base,src).split(path.sep).some(s=>s==='chain-ephemeral'||s.startsWith('working_'))});
    mutate(temp);let rejected=false,reason='';try{audit(temp,false);}catch(e){rejected=true;reason=String(e);}
    assert(rejected,'Audit accepted corrupted evidence: '+name);results.push({name,rejected,reason});
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
C.save(path.join(base,'audit_negative_controls.json'),{passed:true,controls:results});
console.log('Audit negative controls: '+results.length+'/'+results.length+' rejected.');
