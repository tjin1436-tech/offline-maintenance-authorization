'use strict';
// Recompute outcomes from archived SQLite + verified envelopes, not runner flags.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const C=require('./common.cjs');const {assert}=require('./net.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const same=(a,b,msg)=>assert(C.canonical(a)===C.canonical(b),msg);
function dbRead(file){
  const d=new DatabaseSync(file,{readOnly:true});
  try{assert(d.prepare('PRAGMA integrity_check').get().integrity_check==='ok','SQLite integrity');
    assert(d.prepare('PRAGMA foreign_key_check').all().length===0,'SQLite foreign keys');
    return {grants:d.prepare('SELECT * FROM grants ORDER BY grant_id').all(),ops:d.prepare('SELECT * FROM ops ORDER BY grant_id,seq').all(),robot:d.prepare('SELECT * FROM robot_receipts ORDER BY op_id').all()};
  }finally{d.close();}
}
function audit(base,write=true){
  const p=read(path.join(base,'protocol.json')),done=read(path.join(base,'completion.json'));
  assert(p.version==='stage7-recovery-ablation-v1'&&done.completed,'incomplete or wrong protocol');
  assert(Number.isInteger(p.repeats)&&p.repeats>=1&&p.repeats<=30,'bad repetitions');
  same(p.variants,['full','late_reserve','retry_pending'],'variant design');
  same(p.scenarios,[['no_fault',null],['before_dispatch','after_reserve'],['after_effect','after_robot'],['during_done','during_done']],'scenario design');
  assert(p.expected_cases===12*p.repeats&&p.quota===1&&p.grant_ttl_ms===120000,'protocol count/parameters');
  const required=['run_ablation.cjs','audit_ablation.cjs','worker.cjs','store.cjs','harness.cjs','net.cjs','common.cjs','chain_node.cjs','contracts/OfflineRegistry.sol','package-lock.json','original_worker.cjs','stage6_source_hashes.json'];
  same(Object.keys(p.source_sha256).sort(),required.sort(),'source manifest incomplete');
  for(const [n,h] of Object.entries(p.source_sha256))assert(sha(path.join(__dirname,n))===h,'source changed: '+n);
  const old=read(path.join(__dirname,'stage6_source_hashes.json'));
  assert(sha(path.join(__dirname,'original_worker.cjs'))===old['worker.cjs'],'stage6 original hash');
  for(const n of ['store.cjs','harness.cjs','net.cjs','common.cjs','chain_node.cjs','contracts/OfflineRegistry.sol','package-lock.json'])assert(sha(path.join(__dirname,n))===old[n],'shared stage6 source changed: '+n);
  const keys=read(path.join(base,'public_keys.json')),events=read(path.join(base,'process_events.json'));
  const tx=read(path.join(base,'transactions.json')),live=read(path.join(base,'live_check.json')),artifact=read(path.join(base,'contract_artifact.json'));
  const deployment=read(path.join(base,'deployment.json'));
  same(live.receipts.map(x=>x.hash).sort(),tx.map(x=>x.receipt.transactionHash).sort(),'live transaction set');
  assert(new Set(tx.map(x=>x.receipt.transactionHash)).size===tx.length,'duplicate transaction evidence');
  for(const t of tx){
    assert(BigInt(t.receipt.status)===1n,'failed transaction');
    same(C.decodeEvents(t.receipt,artifact.abi),t.events,'decoded EVM events');
    const l=live.receipts.find(x=>x.hash===t.receipt.transactionHash);assert(l&&l.blockHash===t.receipt.blockHash&&l.status===t.receipt.status,'live receipt mismatch');
    assert(t.receipt.to.toLowerCase()===deployment.address.toLowerCase(),'receipt contract address');
  }
  const accepted=tx.filter(t=>t.events.some(x=>x.name==='RecordAccepted'));
  assert(live.success&&live.records===accepted.length&&live.conflicts===0,'live record totals');
  const ids=[];for(let r=1;r<=p.repeats;r++)for(const [s] of p.scenarios)for(const v of p.variants)ids.push(`${s}-${v}-r${r}`);
  same([...done.case_ids].sort(),[...ids].sort(),'case matrix');
  same(fs.readdirSync(path.join(base,'cases')).sort(),[...ids].sort(),'case directories');
  assert(done.cases===ids.length&&done.chain_records===accepted.length&&done.transactions===tx.length,'completion counts');
  const rows=[];let doneOps=0;
  for(const id of ids){
    const dir=path.join(base,'cases',id),c=read(path.join(dir,'case.json'));
    assert(c.completed&&c.id===id&&id===`${c.scenario}-${c.variant}-r${c.repeat}`,'case identity/completion');
    assert(c.checkpoint===p.scenarios.find(x=>x[0]===c.scenario)[1],'checkpoint config');
    const g=dbRead(path.join(dir,'gateway.sqlite')),r=dbRead(path.join(dir,'robot.sqlite'));
    for(const role of ['gateway','robot']){
      const rel=`cases/${id}/${role}.sqlite`;
      const e=events.find(e=>e.type==='DATABASE_EXPORTED'&&e.archive_path.replaceAll('\\','/')===rel);
      assert(e&&e.file_hash===sha(path.join(base,rel)),'database export hash: '+rel);
      const snap=role==='gateway'?g:r;
      assert(e.state_hash===C.hash(snap),'database export state: '+rel);
      for(const k of ['grants','ops','robot'])same(snap[k],c.final[role][k],'archive/snapshot mismatch '+id);
    }
    assert(g.grants.length===1&&r.grants.length===0&&r.ops.length===0&&g.robot.length===0,'unexpected role state');
    const grant=JSON.parse(g.grants[0].envelope);same(grant,c.grant,'grant in case');
    assert(C.verify(grant,keys.issuer)&&grant.body.quota===1&&grant.body.work_order===id&&grant.body.expires_at-grant.body.issued_at===120000,'grant validity');
    const input=[c.requests.first,c.requests.second];
    for(const x of input){assert(C.verify(x,keys.subject),'request signature');for(const k of ['grant_id','gateway','robot','work_order','version'])assert(x.body[k]===grant.body[k],'request grant binding');}
    same(input.map(x=>x.body.op_id),[id+'-op1',id+'-op2'],'request identity');
    assert(g.grants[0].used===g.ops.length,'reservation accounting');
    const signedEffects=new Map();
    for(const x of r.robot){
      const command=JSON.parse(x.command),ack=JSON.parse(x.ack),req=input.find(q=>q.body.op_id===x.op_id);
      assert(req&&C.verify(command,keys.gateway)&&C.verify(ack,keys.robot),'robot signatures');
      const b=req.body,expected={op_id:b.op_id,robot:b.robot,operation:b.operation,grant_id:b.grant_id,work_order:b.work_order,version:b.version,request_hash:C.hash(req)};
      same(command.body,expected,'command binding');
      assert(x.command_hash===C.hash(expected)&&ack.body.command_hash===x.command_hash&&ack.body.op_id===x.op_id&&ack.body.result==='DONE'&&ack.body.robot===b.robot&&ack.body.operation===b.operation,'receipt binding');
      assert(x.effect_count===1&&ack.body.received_at>=grant.body.issued_at&&ack.body.received_at<grant.body.expires_at,'effect count/time');
      signedEffects.set(x.op_id,x);
    }
    for(const op of g.ops){
      const req=input.find(q=>q.body.op_id===op.op_id);assert(req&&op.request_hash===C.hash(req),'op binding');same(JSON.parse(op.request),req,'op request');
      assert(op.seq===1&&op.previous_hash==='GENESIS'&&op.grant_id===grant.body.grant_id,'sequence/grant');
      assert(op.admitted_at>=grant.body.issued_at&&op.admitted_at<grant.body.expires_at,'admission time');
      if(op.state==='DONE'){
        const record=JSON.parse(op.record),ack=JSON.parse(op.ack),effect=signedEffects.get(op.op_id);
        assert(effect&&C.preflight(record,keys)==='VALID'&&record.body.receipt_hash===C.hash(ack),'completion evidence');
        same(ack,JSON.parse(effect.ack),'stored receipt');same(record.body.grant,grant,'record grant');same(record.body.request,req,'record request');
        assert(record.body.sequence===op.seq&&record.body.executed_at===op.admitted_at&&record.body.previous_hash===op.previous_hash,'record SQL fields');
        assert(op.synced===1&&g.grants[0].last_hash===C.hash(record),'completion sync/last hash');
        const t=accepted.find(t=>t.receipt.transactionHash===op.tx_hash);assert(t&&t.context===id,'accepted tx missing');
        same(t.payload.record,record,'transaction record');same(t.payload.ack,ack,'transaction receipt');
        const sid=C.label(grant.body.work_order+':'+grant.body.grant_id);same(t.payload.input,C.recordInput(record,sid),'EVM input');
        const e=t.events.find(x=>x.name==='RecordAccepted');assert(e.args[0]===sid&&Number(e.args[1])===op.seq&&e.args[2]===C.hash(record),'accepted event fields');
        const registrations=tx.filter(x=>x.kind==='register'&&x.context===id);assert(registrations.length===1,'registration count');
        const reg=registrations[0],b=grant.body;
        same(reg.payload.policy,{sessionId:sid,submitter:deployment.bridge,robot:C.label(b.robot),workOrder:C.label(b.work_order),version:b.version,issuedAt:b.issued_at,expiresAt:b.expires_at,quota:b.quota,grantHash:C.hash(grant)},'registered grant');
        same(reg.payload.operations,b.operations.map(C.label),'registered operations');
        const le=reg.events.find(x=>x.name==='LeaseRegistered');assert(le&&le.args[0]===sid&&le.args[1].toLowerCase()===deployment.bridge.toLowerCase()&&le.args[2]===C.hash(grant),'registration event');
        doneOps++;
      }else assert(op.state==='PENDING'&&!op.record&&!op.ack&&op.synced===0&&!signedEffects.has(op.op_id),'pending evidence');
    }
    const kills=events.filter(x=>x.type==='FORCED_TERMINATION'&&c.pids.includes(x.pid));
    assert(kills.length===(c.scenario==='no_fault'?0:1),'forced termination count');
    if(c.checkpoint)assert(events.some(e=>e.type==='CHECKPOINT'&&e.pid===kills[0].pid&&e.phase===c.checkpoint),'checkpoint evidence');
    const calls=events.filter(e=>e.type==='ROBOT_CALL'&&e.pid===c.robot_pid);
    const effects=events.filter(e=>e.type==='ROBOT_EFFECT'&&e.pid===c.robot_pid);
    same(effects.map(x=>x.op_id).sort(),[...signedEffects.keys()].sort(),'effect events vs durable receipts');
    const total=r.robot.reduce((n,x)=>n+x.effect_count,0);
    const orphan=r.robot.filter(x=>!g.ops.some(o=>o.op_id===x.op_id)).length;
    const row={id,variant:c.variant,scenario:c.scenario,repeat:c.repeat,robot_effects:total,
      quota_excess:Math.max(0,total-grant.body.quota),duplicate_effects:r.robot.reduce((n,x)=>n+Math.max(0,x.effect_count-1),0),
      effects_without_gateway_intent:orphan,effects_without_done_record:r.robot.filter(x=>!g.ops.some(o=>o.op_id===x.op_id&&o.state==='DONE')).length,
      done:g.ops.filter(o=>o.state==='DONE').length,pending:g.ops.filter(o=>o.state==='PENDING').length,
      first_operation_done:Number(g.ops.some(o=>o.op_id===id+'-op1'&&o.state==='DONE')),
      new_request_result:c.actions.find(x=>x.name==='new_request_same_grant').response.body.result,
      execute_rpc:calls.filter(x=>x.kind==='execute').length,receipt_rpc:calls.filter(x=>x.kind==='receipt').length,
      forced_terminations:kills.length};
    assert(['DONE','QUOTA','PENDING_BLOCK'].includes(row.new_request_result),'unexpected new request result');
    // Independent checks of actual after-restart snapshots distinguish lost intent from a later completion.
    const ar=c.after_restart,ac=c.after_recover;
    assert(ar.robot.robot.every(x=>signedEffects.has(x.op_id))&&ac.robot.robot.every(x=>signedEffects.has(x.op_id)),'intermediate receipt subset');
    if(c.scenario==='before_dispatch')assert(ar.robot.robot.length===0,'dispatch checkpoint already executed');
    if(['after_effect','during_done'].includes(c.scenario))assert(ar.robot.robot.length===1,'effect checkpoint missing effect');
    const recovered=c.actions.find(a=>a.name==='recover').response;assert(recovered.status===200,'recovery API');
    const newDone=row.new_request_result==='DONE';assert(newDone===g.ops.some(o=>o.op_id===id+'-op2'&&o.state==='DONE'),'new request evidence');
    rows.push(row);
  }
  assert(doneOps===accepted.length&&tx.length===doneOps*2,'chain versus SQL completion count');
  assert(events.filter(e=>e.type==='FORCED_TERMINATION').length===9*p.repeats,'total kills');
  const metrics=['robot_effects','quota_excess','duplicate_effects','effects_without_gateway_intent','effects_without_done_record','done','pending','first_operation_done','execute_rpc','receipt_rpc','forced_terminations'];
  const groups=[];for(const [scenario] of p.scenarios)for(const variant of p.variants){
    const subset=rows.filter(r=>r.variant===variant&&r.scenario===scenario);
    groups.push({scenario,variant,runs:subset.length,...Object.fromEntries(metrics.map(k=>[k,subset.reduce((s,r)=>s+r[k],0)])),
      new_request_results:subset.map(r=>r.new_request_result)});
  }
  const result={audit_passed:true,scope:'Archive consistency and outcome recomputation; not safety success of all variants, third-party certification or physical exactly-once guarantee.',
    platform:p.environments.platform,cases:rows.length,chain_records:accepted.length,transactions:tx.length,groups,rows};
  if(write){
    C.save(path.join(base,'audit.json'),result);
    const cols=Object.keys(rows[0]);fs.writeFileSync(path.join(base,'outcomes.csv'),cols.join(',')+'\n'+rows.map(r=>cols.map(k=>r[k]).join(',')).join('\n')+'\n');
    fs.writeFileSync(path.join(base,'summary.md'),'# Stage 7 recovery ablation\n\nEnvironment: '+p.environments.platform+' / '+p.environments.node+'; '+rows.length+' runs. Audit passed means the recorded evidence is consistent.\n\n'+
      '| Scenario | Variant | Runs | Quota excess | Duplicate effects | Effects without gateway intent | Pending | First operation DONE | Execute RPC |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n'+groups.map(g=>`| ${g.scenario} | ${g.variant} | ${g.runs} | ${g.quota_excess} | ${g.duplicate_effects} | ${g.effects_without_gateway_intent} | ${g.pending} | ${g.first_operation_done} | ${g.execute_rpc} |`).join('\n')+'\n\nAll numeric outcomes are sums across the listed runs. Read protocol.json and README_中文.md for boundaries.\n');
  }
  return result;
}
if(require.main===module){try{const r=audit(path.resolve(process.argv[2]||'stage7_results'));console.log(JSON.stringify({audit_passed:r.audit_passed,cases:r.cases,chain_records:r.chain_records,transactions:r.transactions,groups:r.groups},null,2));}catch(e){console.error(e);process.exitCode=1;}}
module.exports={audit};
