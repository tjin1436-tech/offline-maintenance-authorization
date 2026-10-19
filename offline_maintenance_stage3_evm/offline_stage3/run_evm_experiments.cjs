const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {Contract,ContractFactory,ZeroHash}=require('ethers');
const C=require('./common.cjs');

function options(){
  const args=process.argv.slice(2),out={repeats:3,output:'stage3_results',importFile:path.join(__dirname,'input','your_functional_evidence.json')};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--repeats')out.repeats=Number(args[++i]);
    else if(args[i]==='--output')out.output=args[++i];
    else if(args[i]==='--import')out.importFile=args[++i];
    else if(args[i]==='--no-import')out.importFile=null;
    else throw Error('Unknown argument: '+args[i]);
  }
  if(!Number.isInteger(out.repeats)||out.repeats<1||out.repeats>30)throw Error('--repeats must be 1..30');
  return out;
}

async function main(){
 const opt=options(),dir=path.resolve(opt.output);
 if(fs.existsSync(dir)&&fs.readdirSync(dir).length)throw Error('Output directory is not empty; use a new --output');
 fs.mkdirSync(dir,{recursive:true});
 const artifact=C.compile();C.save(path.join(dir,'contract_artifact.json'),artifact);
 const transactions=[],rows=[],evidence=[],importRows=[],operational=[];
 let chain=await C.startChain(path.join(dir,'chain-db'),path.join(dir,'node.log'));
 let owner,gateway,stranger,registry,address;
 const connect=async()=>{owner=await chain.provider.getSigner(0);gateway=await chain.provider.getSigner(1);stranger=await chain.provider.getSigner(2);
   if(address)registry=new Contract(address,artifact.abi,gateway);};
 await connect();
 let active='SETUP',repeat=0;
 async function retain(receipt,kind){
   const raw=receipt.transactionHash?receipt:await chain.provider.send('eth_getTransactionReceipt',[receipt.hash]);
   const tx=await chain.provider.send('eth_getTransactionByHash',[raw.transactionHash]);
   const entry={case:active,repeat,kind,hash:raw.transactionHash,status:Number(BigInt(raw.status)),
     gasUsed:BigInt(raw.gasUsed).toString(),blockNumber:Number(BigInt(raw.blockNumber)),
     receipt:raw,transaction:tx,events:C.decodeEvents(raw,artifact.abi)};
   transactions.push(entry);return entry;
 }
 async function transact(promise,kind='submit'){
   const tx=await promise;
   try{await tx.wait();}catch(err){if(!err.receipt)throw err;}
   const raw=await chain.provider.send('eth_getTransactionReceipt',[tx.hash]);
   if(!raw)throw Error('Missing actual mined receipt');
   return retain(raw,kind);
 }
 const outcome=entry=>entry.status===0?'REVERTED':entry.events.some(e=>e.name==='RecordAccepted')?'ACCEPTED':
   entry.events.some(e=>e.name==='DuplicateObserved')?'DUPLICATE':entry.events.some(e=>e.name==='ConflictObserved')?'CONFLICT':'SUCCESS';
 const submit=async(record,ctx,bypass=false,caller)=>{
   const checked=C.preflight(record,ctx.keys);
   if(!bypass&&checked!=='VALID')return {outcome:'PREFLIGHT_'+checked,receipt:null};
   const target=caller?registry.connect(caller):registry;
   const receipt=await transact(target.submit(C.recordInput(record,ctx.sessionId),{gasLimit:2000000}));
   return {outcome:outcome(receipt),receipt};
 };
 async function enroll(ctx){
   const g=ctx.grant.body;
   ctx.sessionId=C.label(ctx.namespace+':'+g.grant_id+':'+ctx.keys.subject);
   const policy={sessionId:ctx.sessionId,submitter:await gateway.getAddress(),robot:C.label(g.robot),workOrder:C.label(g.work_order),
     version:g.version,issuedAt:g.issued_at,expiresAt:g.expires_at,quota:g.quota,grantHash:C.hash(ctx.grant)};
   const tx=await transact(registry.connect(owner).registerLease(policy,g.operations.map(C.label),{gasLimit:2000000}),'lease_registration');
   if(tx.status!==1)throw Error('Lease enrollment reverted');
   ctx.policy=policy;return ctx;
 }
 async function fresh(quota=2){
   const issuer=C.keypair(),subject=C.keypair(),gw=C.keypair();
   const keys={issuer:C.pub(issuer),gateway:C.pub(gw),subject:C.pub(subject)};
   const g={grant_id:active+'-'+repeat,subject:keys.subject,gateway:'gw-1',robot:'robot-1',work_order:'wo-1',version:1,
     issued_at:0,expires_at:900,quota,operations:['diagnose','adjust']};
   const grant=C.sign(g,issuer),ctx={namespace:'synthetic:'+active+':'+repeat,keys,grant,gw,subject};
   ctx.record=(sequence=1,executed_at=100,previous_hash='GENESIS',op_id='op-'+sequence)=>{
     const request=C.sign({op_id,operation:'diagnose',gateway:g.gateway,robot:g.robot,work_order:g.work_order,version:g.version,grant_id:g.grant_id},subject);
     return C.sign({sequence,grant,request,executed_at,previous_hash,result:'DONE'},gw);
   };
   return enroll(ctx);
 }
 const count=async ctx=>Number((await registry.leaseState(ctx.sessionId))[0]);
 async function worker(ctx,record,pause,queuePath){
   const config={url:chain.url,address,abi:artifact.abi,input:C.recordInput(record,ctx.sessionId),pause,queuePath};
   const child=spawn(process.execPath,[path.join(__dirname,'submit_worker.cjs')],{stdio:['pipe','pipe','pipe']});
   let errors='';child.stderr.on('data',b=>{errors+=b.toString();});
   const message=await new Promise((resolve,reject)=>{
     let buf='';const timer=setTimeout(()=>reject(Error('Gateway worker timeout')),20000);
     child.once('error',e=>{clearTimeout(timer);reject(e);});
     child.stdout.on('data',b=>{buf+=b.toString();const index=buf.indexOf('\n');if(index>=0){clearTimeout(timer);try{resolve(JSON.parse(buf.slice(0,index)));}catch(e){reject(e);}}});
     child.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('Gateway worker failed: '+errors));});
     child.stdin.end(JSON.stringify(config)+'\n');
   }).catch(e=>{child.kill('SIGKILL');throw e;});
   if(pause){
     if(message.type!=='CHECKPOINT')throw Error('Missing after-commit checkpoint');
     const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
     child.kill('SIGKILL');const exit=await exited;
     operational.push({case:active,repeat,event:'GATEWAY_FORCED_TERMINATION',pid:child.pid,phase:'after_evm_commit',exit});
   }else{
     const code=await new Promise(resolve=>{if(child.exitCode!==null)resolve(child.exitCode);else child.once('exit',resolve);});
     if(code!==0)throw Error('Worker did not exit successfully after its result');
   }
   child.stdin.destroy();
   return retain(message.receipt,'gateway_worker_submit');
 }
 const cases=[
  ['C1_valid_registration',['ACCEPTED',1],async()=>{const c=await fresh();const r=c.record();return {actual:[(await submit(r,c)).outcome,await count(c)],ctx:c,records:[r]};}],
  ['C2_duplicate',['ACCEPTED','DUPLICATE',1],async()=>{const c=await fresh();const r=c.record();return {actual:[(await submit(r,c)).outcome,(await submit(r,c)).outcome,await count(c)],ctx:c,records:[r]};}],
  ['C3_signed_conflict',['ACCEPTED','CONFLICT',true,1],async()=>{const c=await fresh();const a=c.record(),b=c.record(1,101);const first=(await submit(a,c)).outcome,second=(await submit(b,c)).outcome;
    const entry=await registry.entries(c.sessionId,1);return {actual:[first,second,entry[0]===C.hash(a),await count(c)],ctx:c,records:[a,b]};}],
  ['C4_unauthorized_submitter',['REVERTED',0],async()=>{const c=await fresh();const r=c.record();return {actual:[(await submit(r,c,false,stranger)).outcome,await count(c)],ctx:c,records:[r]};}],
  ['C5_wrong_previous_hash',['REVERTED',0],async()=>{const c=await fresh();const r=c.record(1,100,'11'.repeat(32));return {actual:[(await submit(r,c)).outcome,await count(c)],ctx:c,records:[r]};}],
  ['C6_sequence_gap',['REVERTED',0],async()=>{const c=await fresh();const r=c.record(2);return {actual:[(await submit(r,c)).outcome,await count(c)],ctx:c,records:[r]};}],
  ['C7_quota_exhaustion',['ACCEPTED','REVERTED',1],async()=>{const c=await fresh(1);const a=c.record(),b=c.record(2,100,C.hash(a).slice(2));return {actual:[(await submit(a,c)).outcome,(await submit(b,c,true)).outcome,await count(c)],ctx:c,records:[a,b]};}],
  ['C8_expiry_boundary',['PREFLIGHT_BAD_DECLARED_TIME','REVERTED',0],async()=>{const c=await fresh();const r=c.record(1,900);return {actual:[(await submit(r,c)).outcome,(await submit(r,c,true)).outcome,await count(c)],ctx:c,records:[r]};}],
  ['C9_invalid_signature_adapter',['PREFLIGHT_BAD_GATEWAY_SIGNATURE',0],async()=>{const c=await fresh();const r=c.record();r.body.executed_at=101;const before=transactions.length;
    const result=await submit(r,c);return {actual:[result.outcome,transactions.length-before],ctx:c,records:[r]};}],
  ['C10_node_restart',['ACCEPTED',1,true,true],async()=>{const c=await fresh();const r=c.record();const accepted=await submit(r,c);const hash=accepted.receipt.hash;
    const oldPid=chain.child.pid;await chain.close();chain=await C.startChain(path.join(dir,'chain-db'),path.join(dir,'node.log'));await connect();
    operational.push({case:active,repeat,event:'EVM_NODE_GRACEFUL_RESTART',oldPid,newPid:chain.child.pid});
    const receipt=await chain.provider.send('eth_getTransactionReceipt',[hash]);const entry=await registry.entries(c.sessionId,1);
    return {actual:[accepted.outcome,await count(c),receipt!==null&&Number(BigInt(receipt.status))===1,entry[0]===C.hash(r)],ctx:c,records:[r]};}],
  ['C11_gateway_crash_after_commit',['ACCEPTED',false,'DUPLICATE',true,1],async()=>{const c=await fresh();const r=c.record();const queuePath=path.join(dir,active+'_'+repeat+'_queue.json');
    C.save(queuePath,{record:r,synced:false});const first=await worker(c,r,true,queuePath);const before=JSON.parse(fs.readFileSync(queuePath)).synced;
    const second=await worker(c,r,false,queuePath);const after=JSON.parse(fs.readFileSync(queuePath)).synced;
    return {actual:[outcome(first),before,outcome(second),after,await count(c)],ctx:c,records:[r]};}],
  ['C12_offline_spool_then_upload',['RPC_UNAVAILABLE',0,'ACCEPTED','ACCEPTED',2],async()=>{const c=await fresh();const a=c.record(),b=c.record(2,200,C.hash(a).slice(2));
    const {createServer}=require('node:http');let dropped=true,proxyProvider;
    const gate=createServer(async(req,res)=>{
      if(dropped){req.socket.destroy();return;}
      try{const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const reply=await fetch(chain.url,{method:'POST',headers:{'Content-Type':'application/json'},body:Buffer.concat(chunks)});
        res.writeHead(reply.status,{'Content-Type':'application/json','Connection':'close'});res.end(await reply.text());
      }catch{req.socket.destroy();}
    });await new Promise(resolve=>gate.listen(0,'127.0.0.1',resolve));
    const gateUrl='http://127.0.0.1:'+gate.address().port;
    try{
      let unavailable='UNEXPECTED_SUCCESS';try{await fetch(gateUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal:AbortSignal.timeout(2000)});}catch{unavailable='RPC_UNAVAILABLE';}
      const spool=path.join(dir,active+'_'+repeat+'_spool.json');C.save(spool,{records:[a,b],synced:false});
      const before=await count(c);dropped=false;
      const {JsonRpcProvider}=require('ethers');proxyProvider=new JsonRpcProvider(gateUrl,undefined,{cacheTimeout:-1,batchMaxCount:1});proxyProvider.pollingInterval=100;
      const bridge=await proxyProvider.getSigner(1);const one=(await submit(a,c,false,bridge)).outcome,two=(await submit(b,c,false,bridge)).outcome;
      C.save(spool,{records:[a,b],synced:true});operational.push({case:active,repeat,event:'RPC_GATE_RESTORED_AND_SPOOL_UPLOADED'});
      return {actual:[unavailable,before,one,two,await count(c)],ctx:c,records:[a,b]};
    }finally{if(proxyProvider)proxyProvider.destroy();gate.closeAllConnections();await new Promise(resolve=>gate.close(resolve));}}],
  ['C13_trusted_bridge_boundary',['BAD_GATEWAY_SIGNATURE','ACCEPTED',1],async()=>{const c=await fresh();const r=c.record();r.body.executed_at=101;
    return {actual:[C.preflight(r,c.keys),(await submit(r,c,true)).outcome,await count(c)],ctx:c,records:[r],boundary:'Authorized EVM account bypassed off-chain signature checks; contract cannot verify Ed25519.'};}],
 ];
 try{
   const factory=new ContractFactory(artifact.abi,artifact.bytecode,owner);const deployed=await factory.deploy({gasLimit:6000000});
   const deployment=deployed.deploymentTransaction();await deployment.wait();address=await deployed.getAddress();registry=new Contract(address,artifact.abi,gateway);
   await retain(await chain.provider.send('eth_getTransactionReceipt',[deployment.hash]),'deployment');
   const deployedCode=await chain.provider.getCode(address);C.save(path.join(dir,'deployment.json'),{address,chainId:1337,transactionHash:deployment.hash,deployedCodeHash:C.label(deployedCode),deployedCode});
   for(repeat=1;repeat<=opt.repeats;repeat++)for(const [name,expected,fn] of cases){
     active=name;const start=transactions.length;
     try{const result=await fn();const passed=C.canonical(result.actual)===C.canonical(expected);
       rows.push({case:name,repeat,expected,actual:result.actual,pass:passed});
       evidence.push({case:name,repeat,public_keys:result.ctx.keys,sessionId:result.ctx.sessionId,policy:result.ctx.policy,
         records:result.records,preflight:result.records.map(r=>C.preflight(r,result.ctx.keys)),boundary:result.boundary||null,transactionHashes:transactions.slice(start).map(t=>t.hash)});
       console.log(`${passed?'PASS':'FAIL'} repeat=${repeat} ${name}`);
     }catch(err){rows.push({case:name,repeat,expected,actual:{error:String(err)},pass:false});console.log(`FAIL repeat=${repeat} ${name}: ${err}`);}
   }
   if(opt.importFile){
     repeat=0;const imported=JSON.parse(fs.readFileSync(path.resolve(opt.importFile),'utf8'));C.save(path.join(dir,'imported_evidence.json'),imported);
     for(const source of imported){
       active='IMPORTED:'+source.case+':'+(source.repeat||'');
       const records=(source.local_records||source.snapshot?.records?.map(x=>x.record)||[]).filter(r=>r.body.result==='DONE');
       if(!records.length)continue;
       const ctx={namespace:active+':'+(source.group||''),keys:source.public_keys,grant:records[0].body.grant};
       try{
         for(const r of records)if(C.preflight(r,ctx.keys)!=='VALID')throw Error('Import preflight failed');
         await enroll(ctx);const outcomes=[];for(const r of records)outcomes.push((await submit(r,ctx)).outcome);
         const passed=outcomes.every(o=>o==='ACCEPTED')&&(await count(ctx))===records.length;
         importRows.push({case:active,records:records.length,outcomes,pass:passed});
         evidence.push({case:active,repeat:0,public_keys:ctx.keys,sessionId:ctx.sessionId,policy:ctx.policy,records,preflight:records.map(r=>C.preflight(r,ctx.keys)),imported:true});
       }catch(err){importRows.push({case:active,pass:false,error:String(err)});}
     }
   }
   for(const row of rows.filter(r=>r.case==='C11_gateway_crash_after_commit'||r.case==='C12_offline_spool_then_upload')){
     const suffix=row.case==='C11_gateway_crash_after_commit'?'_queue.json':'_spool.json';
     const stored=JSON.parse(fs.readFileSync(path.join(dir,row.case+'_'+row.repeat+suffix),'utf8'));
     if(stored.synced!==true){row.pass=false;row.actual={runtime:row.actual,finalArtifactError:'Queue/spool synchronization flag inconsistent'};}
   }
 }finally{
   C.save(path.join(dir,'results.json'),rows);C.save(path.join(dir,'transactions.json'),transactions);C.save(path.join(dir,'evidence.json'),evidence);
   C.save(path.join(dir,'operational_events.json'),operational);C.save(path.join(dir,'import_results.json'),importRows);
   const csv=['case,repeat,pass,expected,actual',...rows.map(r=>[r.case,r.repeat,r.pass,C.canonical(r.expected),C.canonical(r.actual)].map(v=>'"'+String(v).replaceAll('"','""')+'"').join(','))].join('\n');
   fs.writeFileSync(path.join(dir,'results.csv'),'\ufeff'+csv);
   const scope={stage:'local_EVM_functional_experiments',node:process.version,platform:os.platform(),arch:os.arch(),chainId:1337,
     ganache:require('ganache/package.json').version,ethers:require('ethers').version,solc:require('solc').version(),evmVersion:'shanghai',
     repeats:opt.repeats,caseTypes:cases.length,runs:rows.length,passed:rows.filter(r=>r.pass).length,
     minedTransactions:transactions.length,revertedTransactions:transactions.filter(t=>t.status===0).length,
     importedCompletedRecords:importRows.filter(r=>r.pass).reduce((n,r)=>n+r.records,0),
     limitations:['Ganache development node, not public Ethereum or distributed consensus','Ed25519 verified off-chain by trusted bridge',
       'contract trusts declared execution time and authenticated EVM submitter','robot remains a receipt simulator',
       'node restart is graceful with persistent database, not power loss','gas values are actual receipts for this implementation, not production fee estimates']};
   C.save(path.join(dir,'scope.json'),scope);await chain.close();
 }
 console.log(`\n${rows.filter(r=>r.pass).length}/${rows.length} passed; transactions=${transactions.length}; imported records=${importRows.filter(r=>r.pass).reduce((n,r)=>n+r.records,0)}; output=${dir}`);
 if(rows.some(r=>!r.pass)||importRows.some(r=>!r.pass))process.exitCode=1;
}
main().catch(err=>{console.error(err);process.exitCode=1;});
