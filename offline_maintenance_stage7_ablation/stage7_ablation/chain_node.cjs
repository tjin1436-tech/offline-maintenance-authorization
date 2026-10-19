const ganache=require('ganache');
const dbPath=process.argv[2];
const server=ganache.server({chain:{chainId:1337,networkId:1337,hardfork:'shanghai'},
  wallet:{deterministic:true,totalAccounts:5},logging:{quiet:true},
  miner:{blockTime:0},server:{host:'127.0.0.1'}});
async function main(){await server.listen(0,'127.0.0.1');console.log(JSON.stringify({type:'READY',url:'http://127.0.0.1:'+server.address().port}));}
let stopping=false;
async function stop(){if(stopping)return;stopping=true;const drained=server.provider.once('disconnect');await server.close();await drained;console.log(JSON.stringify({type:'STOPPED',provider_disconnected:true}));if(process.connected)process.disconnect();}
process.on('SIGTERM',()=>stop().catch(()=>process.exit(1)));
process.on('SIGINT',()=>stop().catch(()=>process.exit(1)));
process.on('message',message=>{if(message==='STOP')stop().catch(()=>process.exit(1));});
process.on('disconnect',()=>stop().catch(()=>process.exit(1)));
main().catch(e=>{console.error(e);process.exit(1);});
