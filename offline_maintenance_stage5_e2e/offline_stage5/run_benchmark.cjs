const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {performance}=require('node:perf_hooks');
const {Contract,ContractFactory,JsonRpcProvider}=require('ethers');
const C=require('./common.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitUntil(t){while(performance.now()<t)await sleep(Math.max(1,Math.ceil(t-performance.now())));}
const assert=(ok,msg)=>{if(!ok)throw Error(msg);};
async function serve(handler){
 const server=http.createServer(async(req,res)=>{try{let data='';for await(const b of req)data+=b;
 const reply=await handler(req.url,data?JSON.parse(data):null);if(!res.destroyed){res.writeHead(reply.status||200,{'Content-Type':'application/json'});res.end(JSON.stringify(reply.body));}}
 catch(e){if(!res.destroyed){res.writeHead(500);res.end(JSON.stringify({error:String(e)}));}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);})};
}
async function request(url,body,timeout=1000){
 const begin=performance.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
 try{const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
 return {status:response.status,body:await response.json(),begin_ms:begin,end_ms:performance.now()};}
 catch(e){return {status:0,body:{error:e.name},begin_ms:begin,end_ms:performance.now()};}finally{clearTimeout(timer);}
}
function options(){const a=process.argv.slice(2),o={repeats:3,output:'stage5_results'};for(let i=0;i<a.length;i++){if(a[i]==='--repeats')o.repeats=Number(a[++i]);else if(a[i]==='--output')o.output=a[++i];else throw Error('Unknown argument '+a[i]);}assert(Number.isInteger(o.repeats)&&o.repeats>=1&&o.repeats<=30,'repeats must be 1..30');return o;}
const percentile=(v,p)=>v.length?[...v].sort((a,b)=>a-b)[Math.ceil(p*v.length)-1]:null;
async function main(){
 const opt=options(),dir=path.resolve(opt.output);assert(!fs.existsSync(dir)||!fs.readdirSync(dir).length,'Use an empty --output directory');fs.mkdirSync(dir,{recursive:true});
 const artifact=C.compile();C.save(path.join(dir,'contract_artifact.json'),artifact);
 let chain,relayProvider,heartbeatStop=true,beatTask;const servers=[];const runs=[],transactions=[];
 try{
 chain=await C.startChain(path.join(dir,'chain-db'),path.join(dir,'node.log'));
 const owner=await chain.provider.getSigner(0),bridge=await chain.provider.getSigner(1);
 const registry=await new ContractFactory(artifact.abi,artifact.bytecode,owner).deploy();await registry.waitForDeployment();const address=await registry.getAddress();
 C.save(path.join(dir,'deployment.json'),{address,bridge:await bridge.getAddress(),chain_id:1337});
 async function retain(tx,kind,runId){const begin=performance.now();await tx.wait();const receipt=await chain.provider.send('eth_getTransactionReceipt',[tx.hash]);const transaction=await chain.provider.send('eth_getTransactionByHash',[tx.hash]);transactions.push({run_id:runId,kind,receipt,transaction,events:C.decodeEvents(receipt,artifact.abi),wait_ms:performance.now()-begin});return receipt;}
 let gate={open:true,delay:0},current=null;
 const issuer=C.keypair(),subject=C.keypair(),gatewayKey=C.keypair(),robotKey=C.keypair();
 const keys={issuer:C.pub(issuer),subject:C.pub(subject),gateway:C.pub(gatewayKey),robot:C.pub(robotKey)};
 C.save(path.join(dir,'public_keys.json'),keys);
 const auth=await serve(async(url,body)=>{if(url==='/health')return {body:{ok:true}};
 if(url==='/validate'){assert(current,'No active run');current.issuer_calls++;return {body:{valid:C.verify(body.grant,keys.issuer)&&Date.now()<body.grant.body.expires_at}};}
 assert(url==='/grant'&&current,'Unknown issuer endpoint');current.issuer_calls++;
 assert(Number.isInteger(body.ttl_ms)&&body.ttl_ms>0&&body.ttl_ms<=6000,'Issuer TTL limit');
 const now=Date.now();const grant=C.sign({grant_id:current.id+'-g'+(++current.grant_counter),subject:keys.subject,gateway:'gw-1',robot:'robot-1',work_order:current.id,version:1,issued_at:now,expires_at:now+body.ttl_ms,quota:100,operations:['diagnose']},issuer);
 current.grants.push({grant,ttl_ms:body.ttl_ms,history_ms:[...history],created_ms:performance.now()});return {body:{grant}};});servers.push(auth);
 const authRelay=await serve(async(url,body)=>{if(!gate.open){await sleep(350);return {status:503,body:{offline:true}};}await sleep(gate.delay);const r=await request(auth.url+url,body);return {status:r.status||502,body:r.body};});servers.push(authRelay);
 const chainRelay=await serve(async(url,body)=>{if(!gate.open){await sleep(350);return {status:503,body:{offline:true}};}await sleep(gate.delay);const r=await request(chain.url,body,10000);return {status:r.status||502,body:r.body};});servers.push(chainRelay);
 relayProvider=new JsonRpcProvider(chainRelay.url,undefined,{cacheTimeout:-1,batchMaxCount:1});relayProvider.pollingInterval=50;
 const relayOwner=await relayProvider.getSigner(0),relayBridge=await relayProvider.getSigner(1);
 const onchain=new Contract(address,artifact.abi,relayBridge);
 const robot=await serve(async(url,body)=>{assert(url==='/execute','Robot route');assert(C.verify(body,keys.gateway),'Robot command signature');const b=body.body;
 assert(b.robot==='robot-1'&&b.operation==='diagnose','Robot scope');current.robot_calls++;
 return {body:{ack:C.sign({op_id:b.op_id,robot:b.robot,operation:b.operation,result:'DONE',received_at:Date.now()},robotKey)}};});servers.push(robot);
 let cache=null,counts=new Map(),previous=new Map(),seen=new Set(),queue=[],history=[],state=false;
 function ttl(policy){if(policy==='online')return 1000;if(policy==='fixed')return 4000;const h=[...history].slice(-20).sort((a,b)=>a-b);return Math.min(6000,Math.max(1000,Math.ceil(2*(h[Math.ceil(.9*h.length)-1]+250))));}
 async function issue(policy){const r=await request(authRelay.url+'/grant',{ttl_ms:ttl(policy)},200);current.auth_requests++;current.auth_samples.push({kind:'grant',...r});if(r.status!==200)return false;assert(C.verify(r.body.grant,keys.issuer),'Issuer signature');cache=r.body.grant;return true;}
 async function beat(){while(!heartbeatStop){const r=await request(authRelay.url+'/health',undefined,200);if(current){current.heartbeats.push({begin_ms:r.begin_ms,end_ms:r.end_ms,status:r.status});const next=r.status===200;if(next!==state){current.transitions.push({online:next,at_ms:r.end_ms});state=next;}}
 await sleep(100);}}
 let lock=Promise.resolve();
 const gw=await serve(async(url,body)=>{
 if(url!=='/execute')return {status:404,body:{error:'route'}};
 const old=lock;let release;lock=new Promise(r=>release=r);await old;
 try{
 const r=body.request,start=performance.now(),s={start_ms:start};
 if(!C.verify(r,keys.subject))return {status:403,body:{reason:'signature'}};
 const b=r.body;if(seen.has(b.op_id))return {status:409,body:{reason:'duplicate'}};
 if(current.policy==='online'){const checked=await request(authRelay.url+'/validate',{grant:cache},200);current.auth_requests++;current.auth_samples.push({kind:'validate',...checked});if(checked.status!==200||!checked.body.valid)return {status:403,body:{reason:'online_authorization_unavailable'}};}
 else if(!cache||Date.now()>=cache.body.expires_at){if(!await issue(current.policy))return {status:403,body:{reason:'expired_or_unavailable'}};}
 const grant=cache,g=grant.body,now=Date.now();
 if(!C.verify(grant,keys.issuer)||['gateway','robot','work_order','version','grant_id'].some(k=>b[k]!==g[k])||!g.operations.includes(b.operation)||g.subject!==keys.subject||now<g.issued_at||now>=g.expires_at)return {status:403,body:{reason:'scope_or_expiry'}};
 const n=counts.get(g.grant_id)||0;if(n>=g.quota)return {status:403,body:{reason:'quota'}};
 s.authorized_ms=performance.now();
 const command=C.sign({op_id:b.op_id,robot:b.robot,operation:b.operation},gatewayKey);
 const rr=await request(robot.url+'/execute',command);
 assert(rr.status===200&&C.verify(rr.body.ack,keys.robot)&&rr.body.ack.body.op_id===b.op_id,'Robot acknowledgement');
 s.robot_done_ms=performance.now();
 const record=C.sign({sequence:n+1,grant,request:r,executed_at:now,previous_hash:previous.get(g.grant_id)||'GENESIS',result:'DONE'},gatewayKey);
 assert(C.preflight(record,keys)==='VALID','Bridge preflight');
 counts.set(g.grant_id,n+1);previous.set(g.grant_id,C.hash(record));seen.add(b.op_id);
 const item={record,ack:rr.body.ack,stages:s,accepted_ms:s.robot_done_ms};queue.push(item);
 C.save(path.join(dir,'spool.json'),queue);s.persisted_ms=performance.now();current.records.push(item);
 return {body:{result:'DONE',grant_id:g.grant_id,stages:s}};
 }finally{release();}});servers.push(gw);
 // Execute sequentially; each run uses identical planned request offsets, fresh state and identical initial history.
 for(let repeat=1;repeat<=opt.repeats;repeat++)for(const delay of [0,50])for(const scenario of ['connected','short_outage','long_outage'])for(const policy of ['online','fixed','adaptive'].map((_,i)=>['online','fixed','adaptive'][(i+repeat-1)%3])){
 const id=`r${repeat}-d${delay}-${scenario}-${policy}`,outageMs=scenario==='short_outage'?1500:scenario==='long_outage'?4500:0;
 current={id,repeat,delay_ms:delay,scenario,policy,outage_ms:outageMs,history:[500,500,750,750,500,750,500,500],grant_counter:0,issuer_calls:0,auth_requests:0,auth_samples:[],robot_calls:0,grants:[],records:[],attempts:[],heartbeats:[],transitions:[]};
 cache=null;counts=new Map();previous=new Map();seen=new Set();queue=[];history=[...current.history];state=false;gate={open:true,delay};
 assert(await issue(policy),'Initial grant issuance');
 heartbeatStop=false;beatTask=beat();await sleep(120);
 const begin=performance.now();current.fault_begin_ms=outageMs?begin:null;
 if(outageMs)gate.open=false;
 const offsets=outageMs?[0,.2,.4,.6,.8].map(x=>x*outageMs):[0,100,200,300,400];
 for(let k=0;k<offsets.length;k++){
 await waitUntil(begin+offsets[k]);
 // Client learns current grant id from gateway cache, then signs bound request. Online fresh issuance must use same grant, so issue before signing.
 if(policy==='online'&&gate.open){assert(await issue(policy),'Client online pre-authorization');}
 const b={op_id:id+'-op'+k,operation:'diagnose',gateway:'gw-1',robot:'robot-1',work_order:id,version:1,grant_id:cache.body.grant_id};
 const result=await request(gw.url+'/execute',{request:C.sign(b,subject)},2000);
 current.attempts.push({op_id:b.op_id,phase:outageMs?'offline':'connected',planned_offset_ms:offsets[k],...result});
 }
 if(outageMs){await waitUntil(begin+outageMs);gate.open=true;current.fault_end_ms=performance.now();history.push(current.fault_end_ms-current.fault_begin_ms);}
 const detectionDeadline=performance.now()+2000;while(!state&&performance.now()<detectionDeadline)await sleep(20);assert(state,'No heartbeat recovery');
 current.recovery_detected_ms=outageMs?current.transitions.filter(x=>x.online&&x.at_ms>=current.fault_end_ms)[0]?.at_ms:null;
 // Refresh before the final recovery probe; completed history is now available to adaptive issuance.
 assert(await issue(policy),'Recovery issuance');
 const finalBody={op_id:id+'-recovery',operation:'diagnose',gateway:'gw-1',robot:'robot-1',work_order:id,version:1,grant_id:cache.body.grant_id};
 const final=await request(gw.url+'/execute',{request:C.sign(finalBody,subject)},2000);current.attempts.push({op_id:finalBody.op_id,phase:'recovery',...final});assert(final.status===200,'Recovery command failed');
 heartbeatStop=true;await beatTask;
 current.flush_begin_ms=performance.now();const enrolled=new Set();
 for(const item of queue){const g=item.record.body.grant.body,sid=C.label(id+':'+g.grant_id);item.session_id=sid;
 assert(C.preflight(item.record,keys)==='VALID','Upload signature validation');
 if(!enrolled.has(sid)){
 const p={sessionId:sid,submitter:await bridge.getAddress(),robot:C.label(g.robot),workOrder:C.label(g.work_order),version:g.version,issuedAt:g.issued_at,expiresAt:g.expires_at,quota:g.quota,grantHash:C.hash(item.record.body.grant)};
 await retain(await onchain.connect(relayOwner).registerLease(p,g.operations.map(C.label),{gasLimit:2000000}),'register',id);enrolled.add(sid);}
 const tx=await onchain.submit(C.recordInput(item.record,sid),{gasLimit:2000000});const receipt=await retain(tx,'submit',id);assert(Number(BigInt(receipt.status))===1,'Submit reverted');item.tx_hash=receipt.transactionHash;item.uploaded_ms=performance.now();
 item.queue_ack_ms=performance.now();C.save(path.join(dir,'spool.json'),queue.filter(x=>!x.tx_hash));
 }
 current.flush_end_ms=performance.now();
 const down=current.transitions.find(x=>!x.online&&x.at_ms>=begin);
 const accepted=current.attempts.filter(a=>a.status===200),denied=current.attempts.filter(a=>a.status!==200),off=current.attempts.filter(a=>a.phase==='offline');
 current.metrics={commands:current.attempts.length,accepted:accepted.length,offline_commands:off.length,offline_accepted:off.filter(a=>a.status===200).length,
 command_p50_ms:percentile(accepted.map(a=>a.end_ms-a.begin_ms),.5),command_p95_ms:percentile(accepted.map(a=>a.end_ms-a.begin_ms),.95),
 denied_p50_ms:percentile(denied.map(a=>a.end_ms-a.begin_ms),.5),denied_p95_ms:percentile(denied.map(a=>a.end_ms-a.begin_ms),.95),
 detection_ms:outageMs&&down?down.at_ms-begin:null,recovery_detection_ms:outageMs?current.recovery_detected_ms-current.fault_end_ms:null,
 flush_ms:current.flush_end_ms-current.flush_begin_ms,restoration_to_flush_ms:outageMs?current.flush_end_ms-current.fault_end_ms:null,
 authorization_http_requests:current.auth_requests,issuer_successful_calls:current.issuer_calls,robot_http_calls:current.robot_calls,chain_records:queue.length};
 runs.push(current);C.save(path.join(dir,'runs.json'),runs);C.save(path.join(dir,'transactions.json'),transactions);
 console.log(id,JSON.stringify(current.metrics));current=null;
 }
 const scope={stage:'local_loopback_end_to_end',runs:runs.length,repeats:opt.repeats,policies:3,scenarios:3,injected_response_delays_ms:[0,50],heartbeat_interval_ms:100,heartbeat_timeout_ms:200,fixed_ttl_ms:4000,adaptive_cap_ms:6000,
 time_units:'signed grant and contract declared execution timestamps are Unix milliseconds; monotonic performance fields are local process milliseconds',
 environment:{node:process.version,platform:os.platform(),release:os.release(),cpu:os.cpus()[0]?.model},
 limitations:['HTTP services share one Node process; local EVM node is a child process','command duration measures signed request to gateway response; client grant preparation is separate in auth_samples','policy order rotates over repeats; repeat=1 alone retains order and warmup effects','robot HTTP endpoint is an emulator; no physical robot action measured','controlled HTTP relay outage and response delay are injected, not real WAN observations','shortened TTLs test mechanisms and cannot establish minute-scale availability','5 planned commands plus one recovery command per run; no retries or request-load benchmark','no proactive half-life renewal: this benchmark tests pre-issued leases, not full stage4 scheduling','online authorization includes client grant issuance then online validation of that same bound grant','upload is explicitly triggered after recovery; setup/heartbeat/recovery probe costs are included in restoration-to-flush, not flush-only','same-process Date.now assumes trustworthy clock; crash and compromised bridge are outside this benchmark','local Ganache uses an ephemeral in-memory database; receipts are checked live and later replayed on a fresh node; no restart persistence claim','local Ganache development-node receipts do not establish public-chain finality or performance','few observations per run: request p95 is descriptive, not population inference']};C.save(path.join(dir,'scope.json'),scope);
 // Query original node while it is still running; do not claim restart persistence.
 const live=[];for(const t of transactions){const r=await chain.provider.send('eth_getTransactionReceipt',[t.receipt.transactionHash]);assert(r&&r.blockHash===t.receipt.blockHash&&r.status===t.receipt.status,'Live receipt requery');live.push({hash:r.transactionHash,blockHash:r.blockHash,status:r.status});}
 let checked=0;for(const run of runs)for(const item of run.records){const e=await registry.entries(item.session_id,item.record.body.sequence);assert(e[0]===C.hash(item.record)&&e[2],'Live ledger entry');checked++;}
 assert(Number(await registry.totalRecords())===checked,'Live ledger total');C.save(path.join(dir,'live_check.json'),{success:true,receipts:live,records_checked:checked,scope:'original node queried before shutdown; no persistence claim'});
 require('./summarize.cjs').write(dir);
 console.log('Completed runs:',runs.length);
 }finally{heartbeatStop=true;if(relayProvider)relayProvider.destroy();for(const s of servers.reverse())await s.close();if(chain)await chain.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
