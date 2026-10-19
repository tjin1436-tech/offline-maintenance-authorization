'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {ContractFactory}=require('ethers');
const C=require('./common.cjs');
const {request,serve,sleep,assert,serial,performance}=require('./net.cjs');
class Harness {
  constructor(dir) {this.dir=dir;this.events=[];this.transactions=[];this.children=new Set();this.servers=[];
    this.gate={open:true,delay:0};this.counter=0;this.dropAck=false;this.registered=new Map();}
  async start() {
    this.temp=fs.mkdtempSync(path.join(os.tmpdir(),'offline-stage6-keys-'));
    this.pairs={};this.keys={};
    for(const name of ['issuer','subject','gateway','robot']){const pair=C.keypair();this.pairs[name]=pair;this.keys[name]=C.pub(pair);
      fs.writeFileSync(path.join(this.temp,name+'.pem'),pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});}
    C.save(path.join(this.dir,'public_keys.json'),this.keys);
    const artifact=C.compile();this.artifact=artifact;C.save(path.join(this.dir,'contract_artifact.json'),artifact);
    this.chain=await C.startChain(path.join(this.dir,'chain-ephemeral'),path.join(this.dir,'chain.log'));
    this.owner=await this.chain.provider.getSigner(0);this.bridgeSigner=await this.chain.provider.getSigner(1);
    this.registry=await new ContractFactory(artifact.abi,artifact.bytecode,this.owner).deploy();await this.registry.waitForDeployment();
    this.bridgeAddress=await this.bridgeSigner.getAddress();this.connected=this.registry.connect(this.bridgeSigner);
    C.save(path.join(this.dir,'deployment.json'),{address:await this.registry.getAddress(),bridge:this.bridgeAddress,chain_id:1337});
    this.auth=await serve(async(url,b)=>{
      if(url==='/health')return {body:{ok:true}};
      if(url==='/grant'){
        assert(Number.isSafeInteger(b.ttl_ms)&&b.ttl_ms>0&&b.ttl_ms<=120000,'bad test TTL');
        const now=Date.now();const grant=C.sign({grant_id:b.context+'-g'+(++this.counter),subject:this.keys.subject,
          gateway:'gw-1',robot:'robot-1',work_order:b.context,version:1,issued_at:now,expires_at:now+b.ttl_ms,
          quota:b.quota||100,operations:['diagnose']},this.pairs.issuer);
        return {body:{grant}};
      }
      if(url==='/validate')return {body:{valid:C.verify(b.grant,this.keys.issuer)&&Date.now()>=b.grant.body.issued_at&&Date.now()<b.grant.body.expires_at}};
      return {status:404,body:{error:'route'}};
    });this.servers.push(this.auth);
    const bridgeLock=serial();
    this.adapter=await serve((url,b)=>bridgeLock(async()=>{
      if(url!=='/submit')return {status:404,body:{error:'route'}};
      const record=b.record,ack=b.ack;
      if(C.preflight(record,this.keys)!=='VALID')return {status:403,body:{result:'INVALID_RECORD'}};
      const r=record.body.request.body,cmd={op_id:r.op_id,robot:r.robot,operation:r.operation,grant_id:r.grant_id,
        work_order:r.work_order,version:r.version,request_hash:C.hash(record.body.request)};
      if(!C.verify(ack,this.keys.robot)||ack.body.result!=='DONE'||ack.body.op_id!==r.op_id||ack.body.command_hash!==C.hash(cmd)||
        record.body.receipt_hash!==C.hash(ack))return {status:403,body:{result:'INVALID_RECEIPT'}};
      const g=record.body.grant.body,sid=C.label(g.work_order+':'+g.grant_id),gh=C.hash(record.body.grant);
      if(this.registered.has(sid)&&this.registered.get(sid)!==gh)return {status:409,body:{result:'GRANT_CONFLICT'}};
      if(!this.registered.has(sid)){
        const p={sessionId:sid,submitter:this.bridgeAddress,robot:C.label(g.robot),workOrder:C.label(g.work_order),version:g.version,
          issuedAt:g.issued_at,expiresAt:g.expires_at,quota:g.quota,grantHash:gh};
        await this.retain(await this.registry.registerLease(p,g.operations.map(C.label),{gasLimit:2000000}),'register',g.work_order,{policy:p,operations:g.operations.map(C.label)});
        this.registered.set(sid,gh);
      }
      const input=C.recordInput(record,sid);
      const t=await this.retain(await this.connected.submit(input,{gasLimit:2000000}),'submit',g.work_order,{input,record,ack});
      const names=t.events.map(x=>x.name),result=names.includes('RecordAccepted')?'ACCEPTED':names.includes('DuplicateObserved')?'DUPLICATE':'CONFLICT';
      if(this.dropAck){this.dropAck=false;return {drop:true};}
      return {body:{result,record_hash:C.hash(record),tx_hash:t.receipt.transactionHash}};
    }));this.servers.push(this.adapter);
    const relay=target=>serve(async(url,b)=>{
      if(!this.gate.open){await sleep(350);return {status:503,body:{result:'UNAVAILABLE'}};}
      if(this.gate.delay)await sleep(this.gate.delay);
      const r=await request(target.url+url,b,20000);return {status:r.status||502,body:r.body};
    });
    this.authRelay=await relay(this.auth);this.servers.push(this.authRelay);
    this.bridgeRelay=await relay(this.adapter);this.servers.push(this.bridgeRelay);
  }
  async retain(tx,kind,context,payload){
    await tx.wait();const receipt=await this.chain.provider.send('eth_getTransactionReceipt',[tx.hash]);
    assert(receipt&&BigInt(receipt.status)===1n,'transaction failure');
    const t={kind,context,payload,receipt,events:C.decodeEvents(receipt,this.artifact.abi)};this.transactions.push(t);
    fs.appendFileSync(path.join(this.dir,'transactions.jsonl'),JSON.stringify(t)+'\n',{flush:true});return t;
  }
  async worker(role,dir,extra={}){
    fs.mkdirSync(dir,{recursive:true});
    const config={role,mode:'durable',policy:'fixed',db_path:path.join(dir,'working_'+role+'.sqlite'),key_path:path.join(this.temp,role+'.pem'),
      keys:this.keys,auth_url:this.authRelay.url,bridge_url:this.bridgeRelay.url,...extra};
    const child=spawn(process.execPath,[path.join(__dirname,'worker.cjs')],{stdio:['ignore','ignore','pipe','ipc']});
    const log=fs.createWriteStream(path.join(dir,role+'.log'),{flags:'a'});child.stderr.pipe(log);
    const handle={child,config,archive_path:path.join(dir,role+'.sqlite'),events:[],url:null,exit:null};this.children.add(handle);
    child.on('message',m=>{handle.events.push(m);this.events.push({role,...m});});
    child.once('exit',(code,signal)=>{handle.exit={code,signal};this.events.push({type:'EXIT',role,pid:child.pid,code,signal,wall_ms:Date.now()});this.children.delete(handle);});
    const ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error(role+' startup timeout')),15000);
      const listen=m=>{if(m.type==='READY'){clearTimeout(timer);child.off('message',listen);resolve(m);}};
      child.on('message',listen);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',(c,s)=>{clearTimeout(timer);reject(Error(role+' startup exit '+c+'/'+s));});
    });
    child.send({type:'START',config});const m=await ready;handle.url=m.url;return handle;
  }
  async stop(h,force=false){if(!h||h.exit)return;
    const exit=new Promise(r=>h.child.once('exit',(code,signal)=>r({code,signal})));
    const timer=setTimeout(()=>h.child.kill('SIGKILL'),5000);
    if(force){this.events.push({type:'FORCED_TERMINATION',role:h.config.role,pid:h.child.pid,wall_ms:Date.now()});h.child.kill('SIGKILL');}
    else h.child.send({type:'STOP'});
    const out=await exit;clearTimeout(timer);
    if(!force){
      assert(out.code===0,'unclean worker shutdown');
      const closed=h.events.find(x=>x.type==='CLOSED');assert(closed,'missing orderly close evidence');
      if(h.config.mode!=='memory'){
        const fileHash=require('node:crypto').createHash('sha256').update(fs.readFileSync(h.config.db_path)).digest('hex');
        assert(fileHash===closed.file_hash,'child/parent database file mismatch');
        const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(h.config.db_path,{readOnly:true});
        try{const state={grants:db.prepare('SELECT * FROM grants ORDER BY grant_id').all(),ops:db.prepare('SELECT * FROM ops ORDER BY grant_id,seq').all(),robot:db.prepare('SELECT * FROM robot_receipts ORDER BY op_id').all()};
          assert(C.hash(state)===closed.state_hash,'closed database state differs from live state');
        }finally{db.close();}
        // Export the closed DELETE-mode DB as bytes, never by reconstructing rows from
        // JSON. A separate immutable artifact avoids archiving live DB/journal files.
        const bytes=fs.readFileSync(h.config.db_path);
        assert(require('node:crypto').createHash('sha256').update(bytes).digest('hex')===closed.file_hash,'database changed before export');
        const fd=fs.openSync(h.archive_path,'w',0o600);
        try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        this.events.push({type:'DATABASE_EXPORTED',role:h.config.role,pid:h.child.pid,file_hash:closed.file_hash,state_hash:closed.state_hash,
          archive_path:path.relative(this.dir,h.archive_path)});
      }
    }
    return out;
  }
  async killAt(h,promise,phase){
    const deadline=performance.now()+15000;
    while(!h.events.some(x=>x.type==='CHECKPOINT'&&x.phase===phase)&&performance.now()<deadline){assert(!h.exit,'worker exited before checkpoint');await sleep(5);}
    assert(h.events.some(x=>x.type==='CHECKPOINT'&&x.phase===phase),'checkpoint not reached: '+phase);
    await this.stop(h,true);await promise;
  }
  async call(h,url,b,timeout=20000){return request(h.url+url,b,timeout);}
  async issue(h,context,ttl=60000,quota=100){
    const r=await request(this.authRelay.url+'/grant',{context,ttl_ms:ttl,quota},2000);assert(r.status===200,'grant issue failed');
    const installed=await this.call(h,'/install',{grant:r.body.grant});assert(installed.status===200,'install failed');return r.body.grant;
  }
  signed(grant,op,changes={}){const g=grant.body;return C.sign({op_id:op,operation:'diagnose',gateway:g.gateway,robot:g.robot,work_order:g.work_order,
    version:g.version,grant_id:g.grant_id,...changes},this.pairs.subject);}
  async snapshot(h){const r=await this.call(h,'/state');assert(r.status===200,'snapshot failed');return r.body;}
  async liveCheck(){
    // Authoritative export is one atomic snapshot of the actual receipt array retained
    // by the running controller. The append-only stream remains a diagnostic journal.
    C.save(path.join(this.dir,'transactions.json'),this.transactions);
    const entries=new Map(),receipts=[];
    for(const t of this.transactions){
      const r=await this.chain.provider.send('eth_getTransactionReceipt',[t.receipt.transactionHash]);
      assert(r&&r.blockHash===t.receipt.blockHash&&r.status===t.receipt.status,'live receipt mismatch');
      receipts.push({hash:r.transactionHash,blockHash:r.blockHash,status:r.status});
      if(t.kind==='submit'&&t.events.some(x=>x.name==='RecordAccepted'))entries.set(t.payload.input.sessionId+':'+t.payload.input.sequence,t.payload.input);
    }
    for(const input of entries.values()){const e=await this.registry.entries(input.sessionId,input.sequence);assert(e[0]===input.recordHash&&e[2],'live entry mismatch');}
    assert(Number(await this.registry.totalRecords())===entries.size,'live total mismatch');
    const live={success:true,receipts,records:entries.size,conflicts:Number(await this.registry.totalConflicts()),scope:'original node before shutdown; chain restart is not tested'};
    C.save(path.join(this.dir,'live_check.json'),live);return live;
  }
  async close(){for(const h of [...this.children])await this.stop(h).catch(()=>{});for(const s of this.servers.reverse())await s.close();
    if(this.chain)await this.chain.close();if(this.temp)fs.rmSync(this.temp,{recursive:true,force:true});C.save(path.join(this.dir,'process_events.json'),this.events);}
}
module.exports={Harness};
