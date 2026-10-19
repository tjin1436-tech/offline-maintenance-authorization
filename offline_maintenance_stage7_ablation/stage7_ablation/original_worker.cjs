'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
const C = require('./common.cjs');
const {Store} = require('./store.cjs');
const {request,serve,serial,assert,performance} = require('./net.cjs');
let db,server,config,key,clockTrusted = true,stop = false;
const exclusive = serial();
function event(type, extra = {}) { if (process.connected) process.send({type, pid:process.pid, wall_ms:Date.now(), ...extra}); }
async function checkpoint(phase) {
  if (config.checkpoint === phase) { event('CHECKPOINT', {phase}); await new Promise(() => {}); }
}
function robotCommand(op) {
  const b=JSON.parse(op.request).body;
  return {op_id:b.op_id, robot:b.robot, operation:b.operation, grant_id:b.grant_id,
    work_order:b.work_order, version:b.version, request_hash:op.request_hash};
}
function validAck(ack, op) {
  const cmd=robotCommand(op);
  return C.verify(ack, config.keys.robot) && ack.body.op_id === op.op_id &&
    ack.body.command_hash === C.hash(cmd) && ack.body.result === 'DONE' &&
    ack.body.robot === cmd.robot && ack.body.operation === cmd.operation;
}
async function finish(op, ack) {
  assert(validAck(ack,op), 'invalid or mismatched robot receipt');
  const grant=JSON.parse(db.get('SELECT envelope FROM grants WHERE grant_id=?',op.grant_id).envelope);
  const record=C.sign({sequence:op.seq,grant,request:JSON.parse(op.request),executed_at:op.admitted_at,
    previous_hash:op.previous_hash,result:'DONE',receipt_hash:C.hash(ack)},key);
  db.begin();
  try {
    db.run("UPDATE ops SET state='DONE',record=?,ack=? WHERE op_id=? AND state='PENDING'",JSON.stringify(record),JSON.stringify(ack),op.op_id);
    await checkpoint('during_done');
    db.run('UPDATE grants SET last_hash=? WHERE grant_id=?',C.hash(record),op.grant_id);
    db.commit();
  } catch(e) { db.rollback(); throw e; }
  return record;
}
async function gateway(url,body) {
  if(url==='/state') return {body:db.snapshot()};
  if(url==='/install') {
    const g=body.grant;
    if(!C.verify(g,config.keys.issuer)||g.body.subject!==config.keys.subject||g.body.gateway!=='gw-1'||g.body.robot!=='robot-1'||
      !Number.isSafeInteger(g.body.quota)||g.body.quota<1||!Number.isSafeInteger(g.body.issued_at)||!Number.isSafeInteger(g.body.expires_at)||g.body.expires_at<=g.body.issued_at)
      return {status:403,body:{result:'BAD_GRANT'}};
    const old=db.get('SELECT envelope FROM grants WHERE grant_id=?',g.body.grant_id);
    if(old&&C.hash(JSON.parse(old.envelope))!==C.hash(g))return {status:409,body:{result:'GRANT_CONFLICT'}};
    db.run('INSERT OR IGNORE INTO grants(grant_id,envelope) VALUES(?,?)',g.body.grant_id,JSON.stringify(g));
    return {body:{result:old?'EXISTING':'INSTALLED'}};
  }
  if(url==='/execute') {
    const started=performance.now(),r=body.request;
    if(!C.verify(r,config.keys.subject))return {status:403,body:{result:'BAD_SIGNATURE'}};
    const b=r.body,old=db.get('SELECT * FROM ops WHERE op_id=?',b.op_id);
    if(old) return old.request_hash!==C.hash(r)?{status:409,body:{result:'REQUEST_CONFLICT'}}:
      {status:old.state==='DONE'?200:409,body:{result:old.state==='DONE'?'REPLAY':'PENDING',op_id:b.op_id}};
    const gRow=db.get('SELECT * FROM grants WHERE grant_id=?',b.grant_id);
    if(!gRow)return {status:403,body:{result:'UNKNOWN_GRANT'}};
    const grant=JSON.parse(gRow.envelope),g=grant.body;
    if(['grant_id','robot','gateway','work_order','version'].some(k=>b[k]!==g[k])||!g.operations.includes(b.operation))
      return {status:403,body:{result:'BAD_SCOPE'}};
    if(!clockTrusted)return {status:403,body:{result:'CLOCK_UNTRUSTED'}};
    if(config.policy==='online') {
      const v=await request(config.auth_url+'/validate',{grant},config.auth_timeout_ms||200);
      event('VALIDATE',{status:v.status,duration_ms:v.duration_ms});
      if(v.status!==200||!v.body.valid)return {status:403,body:{result:'ONLINE_UNAVAILABLE'}};
    }
    const now=Date.now();
    if(now<g.issued_at||now>=g.expires_at)return {status:403,body:{result:'EXPIRED'}};
    if(db.get("SELECT op_id FROM ops WHERE grant_id=? AND state='PENDING'",g.grant_id))return {status:409,body:{result:'PENDING_BLOCK'}};
    if(gRow.used>=g.quota)return {status:403,body:{result:'QUOTA'}};
    await checkpoint('before_reserve');
    const reserveStart=performance.now();
    db.begin();
    try {
      db.run('UPDATE grants SET used=used+1 WHERE grant_id=?',g.grant_id);
      await checkpoint('during_reserve');
      db.run("INSERT INTO ops(op_id,request_hash,grant_id,seq,state,admitted_at,previous_hash,request) VALUES(?,?,?,?,'PENDING',?,?,?)",
        b.op_id,C.hash(r),g.grant_id,gRow.used+1,now,gRow.last_hash,JSON.stringify(r));
      db.commit();
    } catch(e) {db.rollback();throw e;}
    const reserve_ms=performance.now()-reserveStart;
    await checkpoint('after_reserve');
    const op=db.get('SELECT * FROM ops WHERE op_id=?',b.op_id),robotStart=performance.now();
    const rr=await request(config.robot_url+'/execute',{command:C.sign(robotCommand(op),key)},2000);
    const robot_ms=performance.now()-robotStart;
    if(rr.status!==200||!validAck(rr.body.ack,op))return {status:409,body:{result:'PENDING',reserve_ms,robot_ms}};
    await checkpoint('after_robot');
    const doneStart=performance.now();await finish(op,rr.body.ack);const done_ms=performance.now()-doneStart;
    await checkpoint('after_done');
    return {body:{result:'DONE',op_id:b.op_id,timings:{reserve_ms,robot_ms,done_ms,total_ms:performance.now()-started}}};
  }
  if(url==='/recover') {
    const results=[];
    for(const op of db.all("SELECT * FROM ops WHERE state='PENDING' ORDER BY grant_id,seq")) {
      const rr=await request(config.robot_url+'/receipt',{query:C.sign({op_id:op.op_id,command_hash:C.hash(robotCommand(op))},key)},2000);
      if(rr.status===200&&validAck(rr.body.ack,op)){await finish(op,rr.body.ack);results.push({op_id:op.op_id,result:'RECOVERED'});}
      else results.push({op_id:op.op_id,result:'PENDING'});
    }
    return {body:{results}};
  }
  if(url==='/flush') {
    const results=[];
    for(const op of db.all("SELECT * FROM ops WHERE state='DONE' AND synced=0 ORDER BY grant_id,seq")) {
      const record=JSON.parse(op.record),ack=JSON.parse(op.ack);
      assert(C.preflight(record,config.keys)==='VALID'&&validAck(ack,op),'local evidence invalid');
      const rr=await request(config.bridge_url+'/submit',{record,ack},15000);
      if(rr.status!==200||!['ACCEPTED','DUPLICATE'].includes(rr.body.result)||rr.body.record_hash!==C.hash(record)) {
        results.push({op_id:op.op_id,result:rr.body.result||'UNAVAILABLE'});break;
      }
      await checkpoint('after_chain');
      db.begin();try {db.run('UPDATE ops SET synced=1,tx_hash=? WHERE op_id=?',rr.body.tx_hash,op.op_id);db.commit();}catch(e){db.rollback();throw e;}
      await checkpoint('after_sync');
      results.push({op_id:op.op_id,result:rr.body.result,tx_hash:rr.body.tx_hash});
    }
    return {body:{results}};
  }
  return {status:404,body:{error:'route'}};
}
async function robot(url,body) {
  if(url==='/state')return {body:db.snapshot()};
  if(url==='/receipt') {
    if(!C.verify(body.query,config.keys.gateway))return {status:403,body:{result:'BAD_SIGNATURE'}};
    const old=db.get('SELECT * FROM robot_receipts WHERE op_id=?',body.query.body.op_id);
    if(!old||old.command_hash!==body.query.body.command_hash)return {status:404,body:{result:'UNKNOWN'}};
    return {body:{ack:JSON.parse(old.ack)}};
  }
  if(url==='/execute') {
    const command=body.command;
    if(!C.verify(command,config.keys.gateway))return {status:403,body:{result:'BAD_SIGNATURE'}};
    const b=command.body;
    if(b.robot!=='robot-1'||b.operation!=='diagnose')return {status:403,body:{result:'BAD_SCOPE'}};
    const hash=C.hash(b),old=db.get('SELECT * FROM robot_receipts WHERE op_id=?',b.op_id);
    if(old)return old.command_hash===hash?{body:{ack:JSON.parse(old.ack),duplicate:true}}:{status:409,body:{result:'CONFLICT'}};
    const ack=C.sign({op_id:b.op_id,command_hash:hash,robot:b.robot,operation:b.operation,result:'DONE',received_at:Date.now()},key);
    // The simulated effect and its receipt share one transaction. This is NOT a physical actuator guarantee.
    db.begin();try {db.run('INSERT INTO robot_receipts VALUES(?,?,?,?,1)',b.op_id,hash,JSON.stringify(command),JSON.stringify(ack));db.commit();}catch(e){db.rollback();throw e;}
    event('ROBOT_EFFECT',{op_id:b.op_id});
    await checkpoint('robot_after_commit');
    return {body:{ack,duplicate:false}};
  }
  return {status:404,body:{error:'route'}};
}
async function start(c) {
  config=c;clockTrusted=c.clock_trusted!==false;
  const privateKey=crypto.createPrivateKey(fs.readFileSync(c.key_path));key={privateKey,publicKey:crypto.createPublicKey(privateKey)};
  db=new Store(c.db_path,c.mode||'durable');
  server=await serve((url,body)=>exclusive(()=>c.role==='robot'?robot(url,body):gateway(url,body)));
  event('READY',{url:server.url,settings:db.settings()});
}
async function close(){
  if(stop)return;stop=true;if(server)await server.close();
  if(db){
    const s=db.snapshot(),state_hash=C.hash({grants:s.grants,ops:s.ops,robot:s.robot});db.close();
    let file_hash=null;
    if(config.mode!=='memory'){
      const fd=fs.openSync(config.db_path,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      file_hash=crypto.createHash('sha256').update(fs.readFileSync(config.db_path)).digest('hex');
    }
    if(process.connected)await new Promise((resolve,reject)=>process.send({type:'CLOSED',pid:process.pid,state_hash,file_hash},e=>e?reject(e):resolve()));
  }
  if(process.connected)process.disconnect();
}
process.on('message',m=>{if(m.type==='START')start(m.config).catch(e=>{console.error(e);process.exit(1);});if(m.type==='STOP')close().catch(()=>process.exit(1));});
process.on('disconnect',()=>close().catch(()=>process.exit(1)));
