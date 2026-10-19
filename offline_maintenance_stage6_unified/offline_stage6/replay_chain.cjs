'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ContractFactory}=require('ethers');const C=require('./common.cjs');const {audit}=require('./audit.cjs');
async function main(){const i=process.argv.indexOf('--input'),dir=path.resolve(i<0?'stage6_results':process.argv[i+1]);audit(dir);
  const txs=JSON.parse(fs.readFileSync(path.join(dir,'transactions.json'),'utf8'));
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'stage6-replay-'));let chain;
  try{chain=await C.startChain(path.join(temp,'ephemeral'),path.join(dir,'replay_node.log'));
    const owner=await chain.provider.getSigner(0),bridge=await chain.provider.getSigner(1),artifact=C.compile();
    const registry=await new ContractFactory(artifact.abi,artifact.bytecode,owner).deploy();await registry.waitForDeployment();
    let count=0;const replay=[];
    for(const t of txs){const tx=t.kind==='register'?await registry.registerLease(t.payload.policy,t.payload.operations,{gasLimit:2000000}):
      await registry.connect(bridge).submit(t.payload.input,{gasLimit:2000000});await tx.wait();
      const receipt=await chain.provider.send('eth_getTransactionReceipt',[tx.hash]);const events=C.decodeEvents(receipt,artifact.abi);
      if(C.canonical(events)!==C.canonical(t.events))throw Error('replay event mismatch '+count);
      replay.push({source_tx:t.receipt.transactionHash,replay_tx:tx.hash,events});count++;if(count%200===0)console.log('replayed',count);}
    const records=Number(await registry.totalRecords()),expected=JSON.parse(fs.readFileSync(path.join(dir,'live_check.json'))).records;
    if(records!==expected)throw Error('replay total mismatch');
    const result={success:true,transactions:count,records,scope:'fresh-node re-execution; not original chain database restart',replay};
    C.save(path.join(dir,'chain_replay.json'),result);console.log(JSON.stringify({success:true,transactions:count,records}));
  }finally{if(chain)await chain.close();fs.rmSync(temp,{recursive:true,force:true});}}
main().catch(e=>{console.error(e);process.exitCode=1;});
