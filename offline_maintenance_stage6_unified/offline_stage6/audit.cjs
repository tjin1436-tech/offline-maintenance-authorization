'use strict';
// Independent evidence checks: deliberately does not import worker, store, harness or their verification helpers.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {Interface}=require('ethers');
const assert=(v,m)=>{if(!v)throw Error(m);};
const canon=v=>Array.isArray(v)?'['+v.map(canon).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>'0x'+crypto.createHash('sha256').update(canon(v)).digest('hex');
const label=v=>'0x'+crypto.createHash('sha256').update(v).digest('hex');
const same=(a,b)=>canon(a)===canon(b);
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
function signature(e,pub){const key=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(pub,'base64')]),type:'spki',format:'der'});
  assert(crypto.verify(null,Buffer.from(canon(e.body)),key,Buffer.from(e.signature,'base64')),'signature mismatch');}
function verifyRecord(record,ack,keys){
  signature(record,keys.gateway);const b=record.body,g=b.grant.body,r=b.request.body;
  signature(b.grant,keys.issuer);signature(b.request,keys.subject);signature(ack,keys.robot);
  assert(g.subject===keys.subject,'grant subject');
  for(const k of ['grant_id','gateway','robot','work_order','version'])assert(g[k]===r[k],'scope mismatch '+k);
  assert(g.operations.includes(r.operation)&&b.result==='DONE','operation/state');
  assert(Number.isSafeInteger(b.sequence)&&b.sequence>=1&&b.sequence<=g.quota,'sequence quota');
  assert(g.issued_at<=b.executed_at&&b.executed_at<g.expires_at,'declared admission time');
  const cmd={op_id:r.op_id,robot:r.robot,operation:r.operation,grant_id:r.grant_id,work_order:r.work_order,version:r.version,request_hash:digest(b.request)};
  assert(ack.body.op_id===r.op_id&&ack.body.command_hash===digest(cmd)&&ack.body.result==='DONE','receipt binding');
  assert(b.receipt_hash===digest(ack),'receipt hash');
}
function verifySnapshot(gw,robot,keys,confirmed){
  assert(gw.settings.synchronous===2||gw.settings.journal_mode==='memory','database settings');
  const robots=new Map(robot.robot.map(r=>[r.op_id,r]));assert(robots.size===robot.robot.length,'robot id uniqueness');
  for(const r of robot.robot){const cmd=JSON.parse(r.command),ack=JSON.parse(r.ack);signature(cmd,keys.gateway);signature(ack,keys.robot);
    assert(r.effect_count===1&&r.command_hash===digest(cmd.body)&&ack.body.command_hash===r.command_hash,'robot ledger binding');}
  for(const gr of gw.grants){const grant=JSON.parse(gr.envelope);signature(grant,keys.issuer);
    const ops=gw.ops.filter(x=>x.grant_id===gr.grant_id).sort((a,b)=>a.seq-b.seq);
    assert(gr.used===ops.length&&gr.used<=grant.body.quota,'quota reservation count');
    let prev='GENESIS';
    for(let i=0;i<ops.length;i++){
      const o=ops[i],req=JSON.parse(o.request);signature(req,keys.subject);
      assert(o.seq===i+1&&o.request_hash===digest(req)&&o.previous_hash===prev&&o.op_id===req.body.op_id,'local sequence/request');
      assert(req.body.grant_id===gr.grant_id&&grant.body.issued_at<=o.admitted_at&&o.admitted_at<grant.body.expires_at,'reserved request/time');
      if(o.state==='PENDING'){assert(i===ops.length-1&&!o.record&&!o.ack&&!o.synced,'pending tail');}
      else{
        const record=JSON.parse(o.record),ack=JSON.parse(o.ack);verifyRecord(record,ack,keys);
        assert(same(record.body.request,req)&&same(record.body.grant,grant)&&record.body.sequence===o.seq&&record.body.previous_hash===prev&&record.body.executed_at===o.admitted_at,'record versus row');
        assert(robots.has(o.op_id)&&same(JSON.parse(robots.get(o.op_id).ack),ack),'robot independent receipt');prev=digest(record);
        if(o.synced)assert(confirmed.has(o.tx_hash)&&confirmed.get(o.tx_hash)===prev,'local sync confirmation');
      }
    }
    assert(gr.last_hash===prev,'grant last digest');
  }
  assert(gw.ops.every(o=>gw.grants.some(g=>g.grant_id===o.grant_id)),'unbound operation');
}
function compareDB(dir,role,snapshot,memory=false){if(memory)return;
  const db=new DatabaseSync(path.join(dir,role+'.sqlite'),{readOnly:true});
  try{const observed={grants:db.prepare('SELECT * FROM grants ORDER BY grant_id').all(),ops:db.prepare('SELECT * FROM ops ORDER BY grant_id,seq').all(),robot:db.prepare('SELECT * FROM robot_receipts ORDER BY op_id').all()};
    for(const k of Object.keys(observed))assert(same(observed[k],snapshot[k]),role+' SQLite/snapshot mismatch '+k);
    assert(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok','SQLite integrity');
  }finally{db.close();}
}
function audit(dir,{checkSource=true}={}){
  const protocol=read(path.join(dir,'protocol.json')),completion=read(path.join(dir,'completion.json')),keys=read(path.join(dir,'public_keys.json'));
  assert(completion.completed,'incomplete experiment');
  if(checkSource)for(const [f,hash]of Object.entries(protocol.source_sha256))assert(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,f))).digest('hex')===hash,'source changed '+f);
  const txs=read(path.join(dir,'transactions.json'));
  const iface=new Interface(read(path.join(dir,'contract_artifact.json')).abi),confirmed=new Map(),accepted=new Map(),lease=new Map();
  const txHashes=new Set();let duplicates=0;
  for(const t of txs){
    const receipt=t.receipt;assert(BigInt(receipt.status)===1n&&!txHashes.has(receipt.transactionHash),'receipt status/uniqueness');txHashes.add(receipt.transactionHash);
    const parsed=receipt.logs.flatMap(l=>{try{const e=iface.parseLog(l);return [{name:e.name,args:Array.from(e.args).map(x=>typeof x==='bigint'?x.toString():x)}];}catch{return [];}});
    assert(same(parsed,t.events),'raw receipt/event mismatch');
    if(t.kind==='register'){
      const p=t.payload.policy;assert(!lease.has(p.sessionId),'duplicate lease registration');
      assert(parsed.length===1&&parsed[0].name==='LeaseRegistered'&&parsed[0].args[0]===p.sessionId&&parsed[0].args[2]===p.grantHash,'lease event binding');
      lease.set(p.sessionId,{p,operations:t.payload.operations,count:0,prev:'0x'+'0'.repeat(64)});
    }else{
      const {record,ack,input}=t.payload;verifyRecord(record,ack,keys);const b=record.body,g=b.grant.body,r=b.request.body;
      const expected={sessionId:label(g.work_order+':'+g.grant_id),sequence:b.sequence,previousHash:b.previous_hash==='GENESIS'?'0x'+'0'.repeat(64):b.previous_hash,
        recordHash:digest(record),requestId:label(r.op_id),robot:label(r.robot),workOrder:label(r.work_order),version:r.version,operation:label(r.operation),executedAt:b.executed_at};
      assert(same(input,expected),'record/contract input mapping');const l=lease.get(input.sessionId);assert(l&&l.p.grantHash===digest(b.grant),'registered grant binding');
      const key=input.sessionId+':'+input.sequence,old=accepted.get(key),name=old?'DuplicateObserved':'RecordAccepted';
      assert(parsed.length===1&&parsed[0].name===name&&parsed[0].args[0]===input.sessionId&&Number(parsed[0].args[1])===input.sequence&&parsed[0].args[2]===input.recordHash,'submit event binding');
      if(old){assert(same(old,input),'inconsistent duplicate');duplicates++;}
      else{assert(input.sequence===l.count+1&&input.previousHash===l.prev&&input.sequence<=l.p.quota,'contract prefix');l.count++;l.prev=input.recordHash;accepted.set(key,input);}
      confirmed.set(receipt.transactionHash,input.recordHash);
    }
  }
  const live=read(path.join(dir,'live_check.json'));assert(live.success&&live.records===accepted.size&&live.receipts.length===txs.length,'live totals');
  const lives=new Map(live.receipts.map(x=>[x.hash,x]));for(const t of txs){const l=lives.get(t.receipt.transactionHash);assert(l&&l.blockHash===t.receipt.blockHash&&l.status===t.receipt.status,'live receipt evidence');}
  const coverage=new Set();const cover=s=>{for(const o of s.ops)if(o.synced)coverage.add(digest(JSON.parse(o.record)));};
  const faults=read(path.join(dir,'faults.json'));assert(faults.length===protocol.expected_fault_cases,'fault count');
  const faultKeys=new Set();
  for(const c of faults){assert(!faultKeys.has(c.context),'duplicate fault case');faultKeys.add(c.context);assert(c.passed&&c.checks.every(x=>x.passed),'failed fault case');
    const expected={done:c.id==='U03'?0:c.id==='U09'?2:1,used:c.id==='U09'?2:1,robot_effects:c.id==='U03'?0:c.id==='U09'?2:1,synced:c.id==='U03'?0:c.id==='U09'?2:1};
    const actual={done:c.gateway.ops.filter(x=>x.state==='DONE').length,used:c.gateway.grants.reduce((n,g)=>n+g.used,0),robot_effects:c.robot.robot.reduce((n,r)=>n+r.effect_count,0),synced:c.gateway.ops.filter(x=>x.synced).length};
    assert(same(actual,expected)&&same(c.expected,expected)&&same(c.observed,actual),'fault final invariants');
    verifySnapshot(c.gateway,c.robot,keys,confirmed);cover(c.gateway);const d=path.join(dir,'faults',c.context);compareDB(d,'gateway',c.gateway);compareDB(d,'robot',c.robot);
    assert(same(read(path.join(d,'case.json')),c),'individual fault evidence');
  }
  for(let rep=1;rep<=protocol.repeats;rep++)for(let n=1;n<=12;n++)assert(faultKeys.has('U'+String(n).padStart(2,'0')+'-r'+rep),'missing specified fault');
  const events=read(path.join(dir,'process_events.json')),kills=events.filter(e=>e.type==='FORCED_TERMINATION');
  const exported=events.filter(e=>e.type==='DATABASE_EXPORTED');
  assert(exported.length>0,'missing original database export evidence');
  for(const e of exported){
    const rel=e.archive_path.replaceAll('\\','/');assert(!rel.startsWith('/')&&!rel.split('/').includes('..'),'unsafe artifact path');
    const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,rel))).digest('hex');
    assert(hash===e.file_hash,'exported SQLite bytes changed');
    assert(events.some(x=>x.type==='CLOSED'&&x.pid===e.pid&&x.state_hash===e.state_hash&&x.file_hash===e.file_hash),'export not tied to orderly close');
  }
  assert(kills.length===13*protocol.repeats,'forced termination count');
  for(const e of kills){assert(events.some(x=>x.type==='EXIT'&&x.pid===e.pid&&(x.signal||x.code!==0)),'missing abnormal exit');assert(events.some(x=>x.type==='READY'&&x.pid===e.pid),'killed process not ready');}
  const func=read(path.join(dir,'functional','functional.json'));assert(func.passed&&func.checks.length===9&&func.checks.every(x=>x.passed),'functional results');
  verifySnapshot(func.gateway,func.robot,keys,confirmed);cover(func.gateway);compareDB(path.join(dir,'functional'),'gateway',func.gateway);compareDB(path.join(dir,'functional'),'robot',func.robot);
  const runs=read(path.join(dir,'benchmark.json'));assert(runs.length===protocol.expected_benchmark_runs,'matrix completeness');
  const runKeys=new Set();let commandCount=0,acceptedCount=0;
  for(const r of runs){assert(!runKeys.has(r.context),'duplicate matrix cell');runKeys.add(r.context);assert(r.passed&&r.attempts.length===6,'benchmark run');
    for(const a of r.attempts){signature(a.signed,keys.subject);assert(Number.isFinite(a.duration_ms)&&a.duration_ms>=0,'duration');
      const op=r.gateway.ops.find(o=>o.op_id===a.signed.body.op_id);assert((a.body.result==='DONE')===!!op,'attempt/record coverage');}
    const count=r.attempts.filter(a=>a.body.result==='DONE').length;acceptedCount+=count;commandCount+=r.attempts.length;
    assert(r.accepted===count&&r.offline_accepted===r.attempts.filter(a=>a.phase==='offline'&&a.body.result==='DONE').length,'derived benchmark count');
    if(r.policy==='online')assert(r.offline_accepted===0,'online accepted offline request');
    for(const item of r.grants){const a=[...item.history_ms].slice(-20).sort((x,y)=>x-y),ttl=r.policy==='online'?1000:r.policy==='fixed'?4000:Math.min(6000,Math.max(1000,Math.ceil(2*(a[Math.ceil(.9*a.length)-1]+250))));
      signature(item.grant,keys.issuer);assert(item.ttl_ms===ttl&&item.grant.body.expires_at-item.grant.body.issued_at===ttl,'TTL policy');}
    verifySnapshot(r.gateway,r.robot,keys,confirmed);cover(r.gateway);assert(r.gateway.ops.every(x=>x.synced),'benchmark queue not drained');
    const d=path.join(dir,'benchmark',r.context);compareDB(d,'gateway',r.gateway,r.mode==='memory');compareDB(d,'robot',r.robot);assert(same(read(path.join(d,'run.json')),r),'individual run evidence');
  }
  let soakCount=0;if(protocol.soakSeconds){const s=read(path.join(dir,'soak','soak.json'));assert(s.passed&&s.elapsed_seconds>=protocol.soakSeconds,'soak interval');
    assert(s.attempts.every(x=>x.body.result==='DONE')&&s.gateway.ops.length===s.attempts.length&&s.gateway.ops.every(x=>x.synced),'soak operation completeness');
    verifySnapshot(s.gateway,s.robot,keys,confirmed);cover(s.gateway);compareDB(path.join(dir,'soak'),'gateway',s.gateway);compareDB(path.join(dir,'soak'),'robot',s.robot);soakCount=s.attempts.length;}
  assert(coverage.size===accepted.size&&[...accepted.values()].every(x=>coverage.has(x.recordHash)),'chain versus all completed local records');
  assert(completion.fault_cases===faults.length&&completion.benchmark_runs===runs.length&&completion.transactions===txs.length&&completion.chain_records===accepted.size&&completion.soak_commands===soakCount,'completion totals');
  return {audit_success:true,fault_cases:faults.length,forced_terminations:kills.length,functional_checks:9,benchmark_runs:runs.length,
    benchmark_commands:commandCount,benchmark_accepted:acceptedCount,soak_commands:soakCount,transactions:txs.length,chain_records:accepted.size,duplicate_events:duplicates,
    limits:'Checks saved signatures, raw EVM events, live receipt evidence, SQLite snapshots and invariants. Does not independently attest physical actions, filesystem durability or wall-clock truth.'};
}
if(require.main===module){const i=process.argv.indexOf('--input');const dir=path.resolve(i<0?'stage6_results':process.argv[i+1]);
  try{const r=audit(dir);fs.writeFileSync(path.join(dir,'audit.json'),JSON.stringify(r,null,2));console.log(JSON.stringify(r));}catch(e){console.error(e);process.exitCode=1;}}
module.exports={audit};
