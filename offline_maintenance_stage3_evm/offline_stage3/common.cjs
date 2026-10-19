const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {JsonRpcProvider, Interface, sha256, toUtf8Bytes, ZeroHash} = require('ethers');
const solc = require('solc');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const hash = value => sha256(toUtf8Bytes(canonical(value)));
const label = value => sha256(toUtf8Bytes(value));
function save(filename, value) {
  const temporary=filename+'.tmp-'+process.pid;
  const fd=fs.openSync(temporary,'w',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2));fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  fs.renameSync(temporary,filename);
}
const keypair = () => crypto.generateKeyPairSync('ed25519');
const pub = pair => pair.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64');
const sign = (body,pair) => ({body, signature:crypto.sign(null,Buffer.from(canonical(body)),pair.privateKey).toString('base64')});
function verify(envelope, rawPublic) {
  try {
    const der=Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(rawPublic,'base64')]);
    return crypto.verify(null,Buffer.from(canonical(envelope.body)),crypto.createPublicKey({key:der,type:'spki',format:'der'}),Buffer.from(envelope.signature,'base64'));
  } catch { return false; }
}
function preflight(record, keys) {
  if (!verify(record,keys.gateway)) return 'BAD_GATEWAY_SIGNATURE';
  const b=record.body,g=b.grant.body,r=b.request.body;
  if (!verify(b.grant,keys.issuer)) return 'BAD_ISSUER_SIGNATURE';
  if (g.subject !== keys.subject || !verify(b.request,keys.subject)) return 'BAD_SUBJECT_SIGNATURE';
  if (['gateway','robot','work_order','version','grant_id'].some(k=>r[k] !== g[k])) return 'BAD_SCOPE';
  if (!g.operations.includes(r.operation)) return 'BAD_OPERATION';
  if (!(g.issued_at <= b.executed_at && b.executed_at < g.expires_at)) return 'BAD_DECLARED_TIME';
  if (!(Number.isInteger(b.sequence) && b.sequence >= 1 && b.sequence <= g.quota)) return 'BAD_QUOTA';
  if (b.result !== 'DONE') return 'PENDING';
  return 'VALID';
}
function recordInput(record,sessionId) {
  const b=record.body,r=b.request.body;
  return {sessionId,sequence:b.sequence,previousHash:b.previous_hash==='GENESIS'?ZeroHash:(b.previous_hash.startsWith('0x')?b.previous_hash:'0x'+b.previous_hash),
    recordHash:hash(record),requestId:label(r.op_id),robot:label(r.robot),workOrder:label(r.work_order),
    version:r.version,operation:label(r.operation),executedAt:b.executed_at};
}
function compile() {
  const source=fs.readFileSync(path.join(__dirname,'contracts','OfflineRegistry.sol'),'utf8');
  const input={language:'Solidity',sources:{'OfflineRegistry.sol':{content:source}},settings:{
    optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'shanghai',
    outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
  const output=JSON.parse(solc.compile(JSON.stringify(input)));
  const errors=(output.errors||[]).filter(e=>e.severity==='error');
  if(errors.length) throw Error(errors.map(e=>e.formattedMessage).join('\n'));
  const c=output.contracts['OfflineRegistry.sol'].OfflineRegistry;
  return {abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,compiler:solc.version(),sourceSha256:label(source),settings:input.settings};
}
async function startChain(dbPath,logFile) {
  fs.mkdirSync(dbPath,{recursive:true});
  const child=spawn(process.execPath,[path.join(__dirname,'chain_node.cjs'),dbPath],{stdio:['ignore','pipe','pipe','ipc']});
  const log=fs.createWriteStream(logFile,{flags:'a'});
  child.stderr.pipe(log,{end:false});
  const info=await new Promise((resolve,reject)=>{
    let text='';
    const timer=setTimeout(()=>reject(Error('EVM node startup timed out')),20000);
    child.stdout.on('data',chunk=>{text+=chunk.toString();let i;while((i=text.indexOf('\n'))>=0){
      const line=text.slice(0,i);text=text.slice(i+1);log.write(line+'\n');
      try{const obj=JSON.parse(line);if(obj.type==='READY'){clearTimeout(timer);resolve(obj);}}catch{}
    }});
    child.once('exit',code=>{clearTimeout(timer);reject(Error('EVM node exited: '+code));});
    child.once('error',err=>{clearTimeout(timer);reject(err);});
  }).catch(err=>{child.kill();log.end();throw err;});
  const provider=new JsonRpcProvider(info.url,undefined,{cacheTimeout:-1,batchMaxCount:1});
  provider.pollingInterval=100;
  async function close(){
    provider.destroy();
    if(child.exitCode===null){
      const exited=new Promise(resolve=>child.once('exit',resolve));
      const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
      if(child.connected)child.send('STOP');else child.kill('SIGTERM');
      await exited;clearTimeout(timer);
    }
    log.end();
  }
  return {child,provider,url:info.url,close};
}
function decodeEvents(receipt,abi) {
  const iface=new Interface(abi);
  return receipt.logs.flatMap(log=>{try{const e=iface.parseLog(log);return [{name:e.name,args:Array.from(e.args).map(v=>typeof v==='bigint'?v.toString():v)}];}catch{return [];}});
}
module.exports={canonical,hash,label,save,keypair,pub,sign,verify,preflight,recordInput,compile,startChain,decodeEvents};
