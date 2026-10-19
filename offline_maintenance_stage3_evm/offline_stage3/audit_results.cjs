// Reopens the saved local chain and queries actual receipts/state; does not submit transactions.
const fs=require('node:fs');
const path=require('node:path');
const {Contract,sha256}=require('ethers');
const C=require('./common.cjs');
const EVENT_SPEC={
 C1_valid_registration:['ACCEPTED'],C2_duplicate:['ACCEPTED','DUPLICATE'],C3_signed_conflict:['ACCEPTED','CONFLICT'],
 C4_unauthorized_submitter:['REVERTED'],C5_wrong_previous_hash:['REVERTED'],C6_sequence_gap:['REVERTED'],
 C7_quota_exhaustion:['ACCEPTED','REVERTED'],C8_expiry_boundary:['REVERTED'],C9_invalid_signature_adapter:[],
 C10_node_restart:['ACCEPTED'],C11_gateway_crash_after_commit:['ACCEPTED','DUPLICATE'],
 C12_offline_spool_then_upload:['ACCEPTED','ACCEPTED'],C13_trusted_bridge_boundary:['ACCEPTED']
};
async function main(){
 const argv=process.argv.slice(2);let directory='stage3_results';
 if(argv.length){if(argv[0]!=='--input'||argv.length!==2)throw Error('Usage: node audit_results.cjs --input stage3_results');directory=argv[1];}
 const dir=path.resolve(directory),read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
 const artifact=read('contract_artifact.json'),deployment=read('deployment.json'),rows=read('results.json'),
   transactions=read('transactions.json'),evidence=read('evidence.json'),scope=read('scope.json'),imports=read('import_results.json'),operational=read('operational_events.json');
 const failures=[],warnings=[],signatureChecks=[];
 const expectedCsv='\ufeff'+['case,repeat,pass,expected,actual',...rows.map(r=>[r.case,r.repeat,r.pass,C.canonical(r.expected),C.canonical(r.actual)].map(v=>'"'+String(v).replaceAll('"','""')+'"').join(','))].join('\n');
 if(fs.readFileSync(path.join(dir,'results.csv'),'utf8').replaceAll('\r\n','\n')!==expectedCsv)failures.push('CSV/JSON mismatch');
 const liveArtifact=C.compile();
 if(liveArtifact.sourceSha256!==artifact.sourceSha256||liveArtifact.bytecode!==artifact.bytecode)failures.push('Source/compiler artifact differs');
 if(rows.length!==scope.runs||rows.filter(r=>r.pass).length!==scope.passed||rows.some(r=>!r.pass||C.canonical(r.expected)!==C.canonical(r.actual)))failures.push('Result/scope mismatch or functional failure');
 if(new Set(rows.map(r=>r.case+':'+r.repeat)).size!==rows.length)failures.push('Duplicate case/repeat');
 for(let repeat=1;repeat<=scope.repeats;repeat++)for(const name of Object.keys(EVENT_SPEC)){
  if(!rows.some(r=>r.case===name&&r.repeat===repeat))failures.push('Missing case '+name+':'+repeat);
 }
 for(let repeat=1;repeat<=scope.repeats;repeat++){
   const restart=operational.filter(e=>e.case==='C10_node_restart'&&e.repeat===repeat&&e.event==='EVM_NODE_GRACEFUL_RESTART');
   const kill=operational.filter(e=>e.case==='C11_gateway_crash_after_commit'&&e.repeat===repeat&&e.event==='GATEWAY_FORCED_TERMINATION');
   const restore=operational.filter(e=>e.case==='C12_offline_spool_then_upload'&&e.repeat===repeat&&e.event==='RPC_GATE_RESTORED_AND_SPOOL_UPLOADED');
   if(restart.length!==1||restart[0].oldPid===restart[0].newPid)failures.push('Node restart trace mismatch '+repeat);
   if(kill.length!==1||(kill[0].exit.code===0&&!kill[0].exit.signal))failures.push('Gateway termination trace mismatch '+repeat);
   if(restore.length!==1)failures.push('RPC restore trace mismatch '+repeat);
   const queue=read('C11_gateway_crash_after_commit_'+repeat+'_queue.json');
   const spool=read('C12_offline_spool_then_upload_'+repeat+'_spool.json');
   if(queue.synced!==true||spool.synced!==true)failures.push('Final spool/queue not synced '+repeat);
 }
 const chain=await C.startChain(path.join(dir,'chain-db'),path.join(dir,'audit_node.log'));
 let verified=0,gasSum=0n,accepted=0,duplicates=0,conflicts=0,reverted=0;
 try{
  const network=await chain.provider.getNetwork();if(Number(network.chainId)!==scope.chainId)failures.push('Chain ID mismatch');
  const code=await chain.provider.getCode(deployment.address);
  if(code!==deployment.deployedCode||C.label(code)!==deployment.deployedCodeHash||code==='0x')failures.push('Deployed bytecode mismatch');
  const registry=new Contract(deployment.address,artifact.abi,chain.provider);
  const receiptOutcomes=new Map();
  for(const saved of transactions){
    const receipt=await chain.provider.send('eth_getTransactionReceipt',[saved.hash]);
    const tx=await chain.provider.send('eth_getTransactionByHash',[saved.hash]);
    if(!receipt||!tx){failures.push('Receipt/transaction missing '+saved.hash);continue;}
    if(C.canonical(receipt)!==C.canonical(saved.receipt)||C.canonical(tx)!==C.canonical(saved.transaction))failures.push('Receipt/transaction changed '+saved.hash);
    if(Number(BigInt(receipt.status))!==saved.status||BigInt(receipt.gasUsed).toString()!==saved.gasUsed)failures.push('Status/gas mismatch '+saved.hash);
    if(saved.kind==='deployment'&&tx.input!==artifact.bytecode)failures.push('Deployment input differs from compiler bytecode');
    const block=await chain.provider.send('eth_getBlockByNumber',[receipt.blockNumber,false]);
    if(!block||block.hash!==receipt.blockHash||!block.transactions.includes(saved.hash))failures.push('Block inclusion mismatch '+saved.hash);
    const events=C.decodeEvents(receipt,artifact.abi);
    if(C.canonical(events)!==C.canonical(saved.events))failures.push('Decoded event mismatch '+saved.hash);
    if(saved.kind==='submit'||saved.kind==='gateway_worker_submit'){
      const result=Number(BigInt(receipt.status))===0?'REVERTED':events.some(e=>e.name==='RecordAccepted')?'ACCEPTED':
        events.some(e=>e.name==='DuplicateObserved')?'DUPLICATE':events.some(e=>e.name==='ConflictObserved')?'CONFLICT':'UNKNOWN';
      const key=saved.case+':'+saved.repeat;if(!receiptOutcomes.has(key))receiptOutcomes.set(key,[]);receiptOutcomes.get(key).push(result);
      if(result==='ACCEPTED')accepted++;if(result==='DUPLICATE')duplicates++;if(result==='CONFLICT')conflicts++;if(result==='REVERTED')reverted++;
    }
    verified++;gasSum+=BigInt(receipt.gasUsed);
  }
  for(const row of rows){const expected=EVENT_SPEC[row.case],actual=receiptOutcomes.get(row.case+':'+row.repeat)||[];
    if(!expected||C.canonical(expected)!==C.canonical(actual))failures.push({case:row.case,repeat:row.repeat,receiptExpected:expected,receiptActual:actual});}
  for(const e of evidence){
    const checked=e.records.map(r=>({gateway:C.verify(r,e.public_keys.gateway),issuer:C.verify(r.body.grant,e.public_keys.issuer),
      subject:C.verify(r.body.request,e.public_keys.subject),preflight:C.preflight(r,e.public_keys)}));
    const intentionallyInvalid=['C9_invalid_signature_adapter','C13_trusted_bridge_boundary'].includes(e.case);
    for(const c of checked){if(!c.issuer||!c.subject||c.gateway===intentionallyInvalid)failures.push('Unexpected signature status '+e.case);}
    if(C.canonical(checked.map(c=>c.preflight))!==C.canonical(e.preflight))failures.push('Preflight evidence mismatch '+e.case);
    if(e.imported&&checked.some(c=>c.preflight!=='VALID'))failures.push('Imported invalid record '+e.case);
    const state=await registry.leaseState(e.sessionId);
    const expectedAccepted=e.imported?e.records.length:(EVENT_SPEC[e.case]||[]).filter(x=>x==='ACCEPTED').length;
    if(Number(state[0])!==expectedAccepted||!state[2])failures.push('Lease final count mismatch '+e.case);
    if(expectedAccepted){
      const relevant=e.case==='C3_signed_conflict'?[e.records[0]]:e.records.slice(0,expectedAccepted);
      for(const record of relevant){const entry=await registry.entries(e.sessionId,record.body.sequence);
        if(!entry[2]||entry[0]!==C.hash(record))failures.push('Stored record hash mismatch '+e.case);}
    }
    signatureChecks.push({case:e.case,repeat:e.repeat,checked,intentionallyInvalid});
  }
  if(Number(await registry.totalRecords())!==accepted)failures.push('Global accepted count differs from receipts');
  if(Number(await registry.totalConflicts())!==conflicts)failures.push('Global conflict count differs from events');
  if(imports.some(i=>!i.pass))failures.push('Imported cohort has failures');
  for(const imp of imports){const outcomes=receiptOutcomes.get(imp.case+':0')||[];if(outcomes.length!==imp.records||outcomes.some(o=>o!=='ACCEPTED'))failures.push('Import receipt mismatch '+imp.case);}
  warnings.push('C13 deliberately shows that an authorized EVM account can bypass off-chain Ed25519 verification. This is a trust boundary, not a successful security defense.');
  warnings.push('Local development chain inclusion does not demonstrate distributed consensus, public-chain finality or physical robot correctness.');
 }finally{await chain.close();}
 const result={audit_success:failures.length===0,cases:rows.length,receipts_requeried:verified,
   accepted,duplicates,conflicts,reverted,totalGasUsedAllTransactions:gasSum.toString(),signatureChecks,failures,warnings};
 C.save(path.join(dir,'audit.json'),result);
 console.log(JSON.stringify({audit_success:result.audit_success,receipts_requeried:verified,accepted,duplicates,conflicts,reverted,failures},null,2));
 if(!result.audit_success)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
