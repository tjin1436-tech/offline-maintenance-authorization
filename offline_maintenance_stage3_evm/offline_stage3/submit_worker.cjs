const fs=require('node:fs');
const readline=require('node:readline');
const {JsonRpcProvider,Contract}=require('ethers');
const {save}=require('./common.cjs');
async function main(){
  const config=JSON.parse(await new Promise(resolve=>{
    const input=readline.createInterface({input:process.stdin});
    input.once('line',line=>{input.close();process.stdin.pause();resolve(line);});
  }));
  const provider=new JsonRpcProvider(config.url,undefined,{cacheTimeout:-1,batchMaxCount:1});provider.pollingInterval=100;
  try{
    const signer=await provider.getSigner(1);
    const contract=new Contract(config.address,config.abi,signer);
    const tx=await contract.submit(config.input,{gasLimit:2000000});await tx.wait();
    const receipt=await provider.send('eth_getTransactionReceipt',[tx.hash]);
    if(config.pause){
      console.log(JSON.stringify({type:'CHECKPOINT',phase:'after_evm_commit',receipt}));
      setInterval(()=>{},1000);
      await new Promise(()=>{});
    }
    const queue=JSON.parse(fs.readFileSync(config.queuePath,'utf8'));queue.synced=true;save(config.queuePath,queue);
    console.log(JSON.stringify({type:'RESULT',receipt}));
  }finally{provider.destroy();}
}
main().catch(e=>{console.error(e);process.exit(1);});
