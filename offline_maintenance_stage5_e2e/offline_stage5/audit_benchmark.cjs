const fs=require('node:fs'),path=require('node:path');
const {Contract,ContractFactory}=require('ethers');const C=require('./common.cjs');
function check(ok,why){if(!ok)throw Error(why);}
function pct(values,p){return values.length?[...values].sort((a,b)=>a-b)[Math.ceil(p*values.length)-1]:null;}
function auditLocal(dir){
 const read=n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));
 const runs=read('runs.json'),scope=read('scope.json'),transactions=read('transactions.json'),keys=read('public_keys.json');
 check(runs.length===scope.repeats*18&&scope.runs===runs.length,'matrix size');
 check(new Set(runs.map(r=>r.id)).size===runs.length,'duplicate run id');let records=0;
 for(const r of runs){
 const accepted=r.attempts.filter(x=>x.status===200),denied=r.attempts.filter(x=>x.status!==200),offline=r.attempts.filter(x=>x.phase==='offline');
 check(r.auth_requests===r.auth_samples.length&&r.auth_samples.every(x=>x.end_ms>=x.begin_ms),'authorization timing samples');
 check(r.attempts.length===6&&r.records.length===accepted.length&&r.robot_calls===accepted.length,'attempt/robot count');
 check(r.attempts.every(x=>x.end_ms>=x.begin_ms),'negative request duration');
 const down=r.transitions.find(x=>!x.online&&x.at_ms>=r.fault_begin_ms);
 const recovery=r.transitions.find(x=>x.online&&x.at_ms>=r.fault_end_ms);
 const expected={commands:6,accepted:accepted.length,offline_commands:offline.length,offline_accepted:offline.filter(x=>x.status===200).length,
 command_p50_ms:pct(accepted.map(x=>x.end_ms-x.begin_ms),.5),command_p95_ms:pct(accepted.map(x=>x.end_ms-x.begin_ms),.95),
 denied_p50_ms:pct(denied.map(x=>x.end_ms-x.begin_ms),.5),denied_p95_ms:pct(denied.map(x=>x.end_ms-x.begin_ms),.95),
 detection_ms:r.outage_ms&&down?down.at_ms-r.fault_begin_ms:null,recovery_detection_ms:r.outage_ms?recovery?.at_ms-r.fault_end_ms:null,
 flush_ms:r.flush_end_ms-r.flush_begin_ms,restoration_to_flush_ms:r.outage_ms?r.flush_end_ms-r.fault_end_ms:null,
 authorization_http_requests:r.auth_requests,issuer_successful_calls:r.issuer_calls,robot_http_calls:r.robot_calls,chain_records:r.records.length};
 check(JSON.stringify(expected)===JSON.stringify(r.metrics),'metric recomputation '+r.id);
 if(r.outage_ms){check(r.fault_end_ms-r.fault_begin_ms>=r.outage_ms-.1,'shortened outage');check(down&&recovery,'missing fault detection');}
 if(r.policy==='online')check(!r.metrics.offline_accepted,'online execution during outage');
 const grants=new Map();for(const x of r.grants){const g=x.grant.body;check(C.verify(x.grant,keys.issuer),'issuer signature');check(g.expires_at-g.issued_at===x.ttl_ms,'TTL mismatch');
 check(!r.outage_ms||x.created_ms<r.fault_begin_ms||x.created_ms>=r.fault_end_ms,'issued during outage');
 const permittedHistory=x.created_ms>=r.fault_end_ms&&r.outage_ms?[...r.history,r.fault_end_ms-r.fault_begin_ms]:r.history;check(JSON.stringify(permittedHistory)===JSON.stringify(x.history_ms),'future history leakage');
 const history=[...x.history_ms].sort((a,b)=>a-b);const ttl=r.policy==='online'?1000:r.policy==='fixed'?4000:Math.min(6000,Math.max(1000,Math.ceil(2*(history[Math.ceil(.9*history.length)-1]+250))));
 check(ttl===x.ttl_ms,'adaptive history formula');grants.set(g.grant_id,x.grant);}
 const counts=new Map(),prev=new Map(),ops=new Set();
 for(const x of r.records){const b=x.record.body,g=b.grant.body,op=b.request.body.op_id;
 check(C.preflight(x.record,keys)==='VALID','record signatures/scope');check(C.verify(x.ack,keys.robot)&&x.ack.body.op_id===op&&x.ack.body.robot===b.request.body.robot&&x.ack.body.operation===b.request.body.operation&&x.ack.body.result==='DONE','robot ack');
 check(grants.has(g.grant_id)&&C.hash(grants.get(g.grant_id))===C.hash(b.grant),'grant membership');
 check(b.sequence===(counts.get(g.grant_id)||0)+1&&b.previous_hash===(prev.get(g.grant_id)||'GENESIS'),'sequence/hash chain');
 counts.set(g.grant_id,b.sequence);prev.set(g.grant_id,C.hash(x.record));check(!ops.has(op),'duplicate execution');ops.add(op);
 const a=accepted.find(a=>a.op_id===op);check(a&&a.begin_ms<=x.stages.start_ms&&x.stages.start_ms<=x.stages.authorized_ms&&x.stages.authorized_ms<=x.stages.robot_done_ms&&x.stages.robot_done_ms<=x.stages.persisted_ms&&x.stages.persisted_ms<=a.end_ms,'stage order');
 check(x.uploaded_ms>=r.flush_begin_ms&&x.uploaded_ms<=r.flush_end_ms,'upload timestamp');
 const tx=transactions.filter(t=>t.kind==='submit'&&t.run_id===r.id&&t.receipt.transactionHash===x.tx_hash);
 check(tx.length===1&&Number(BigInt(tx[0].receipt.status))===1,'receipt membership/status');
 check(tx[0].events.some(e=>e.name==='RecordAccepted'&&e.args[0]===x.session_id&&Number(e.args[1])===b.sequence&&e.args[2]===C.hash(x.record)),'receipt event correspondence');records++;
 }
 check(r.records.length===transactions.filter(t=>t.run_id===r.id&&t.kind==='submit').length,'submit count');
 }
 const live=read('live_check.json');check(live.success&&live.records_checked===records&&live.receipts.length===transactions.length,'live-check scope/count');for(let i=0;i<transactions.length;i++){const r=transactions[i].receipt,l=live.receipts[i];check(l.hash===r.transactionHash&&l.blockHash===r.blockHash&&l.status===r.status,'live-check correspondence');}
 check(read('spool.json').length===0,'pending records remain');
 return {runs,transactions,records};
}
async function main(){const a=process.argv.slice(2),dir=path.resolve(a[a.indexOf('--input')+1]||'stage5_results');let chain;const report={audit_success:false,failures:[]};
 try{const {runs,transactions,records}=auditLocal(dir);const artifact=JSON.parse(fs.readFileSync(path.join(dir,'contract_artifact.json')));const dep=JSON.parse(fs.readFileSync(path.join(dir,'deployment.json')));
 check(C.compile().sourceSha256===artifact.sourceSha256,'contract source hash');
 chain=await C.startChain(path.join(dir,'replay_runtime'),path.join(dir,'audit_node.log'));
 const compiled=C.compile(),owner=await chain.provider.getSigner(0);const deployed=await new ContractFactory(compiled.abi,compiled.bytecode,owner).deploy();await deployed.waitForDeployment();const replayAddress=await deployed.getAddress();
 for(const t of transactions){const old=t.transaction;const hash=await chain.provider.send('eth_sendTransaction',[{from:old.from,to:replayAddress,data:old.input,gas:old.gas}]);let receipt=null;for(let n=0;n<200;n++){receipt=await chain.provider.send('eth_getTransactionReceipt',[hash]);if(receipt)break;await new Promise(r=>setTimeout(r,50));}check(receipt&&Number(BigInt(receipt.status))===1,'fresh replay receipt');check(JSON.stringify(C.decodeEvents(receipt,compiled.abi))===JSON.stringify(t.events),'fresh replay events');}
 for(const r of runs)for(const x of r.records){const entry=await deployed.entries(x.session_id,x.record.body.sequence);check(entry[0]===C.hash(x.record)&&entry[2],'fresh replay ledger entry');}
 check(Number(await deployed.totalRecords())===records,'replay ledger total');Object.assign(report,{audit_success:true,runs_checked:runs.length,records_checked:records,original_live_receipts_checked:transactions.length,transactions_replayed:transactions.length,scope:'original live-check correspondence and fresh EVM replay; no original chain restart-persistence proof'});
 }catch(e){report.failures.push(String(e));}finally{if(chain)await chain.close();}
 C.save(path.join(dir,'audit.json'),report);console.log(JSON.stringify(report,null,2));if(!report.audit_success)process.exitCode=1;
}
module.exports={auditLocal};if(require.main===module)main();
