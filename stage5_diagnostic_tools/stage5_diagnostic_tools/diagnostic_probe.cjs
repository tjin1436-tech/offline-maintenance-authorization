// Diagnostic instrumentation only. Do not use diagnostic timings as paper results.
const fs=require('node:fs'),path=require('node:path');
const traceFile=process.env.STAGE5_DIAGNOSTIC_PROBE_FILE;
if(traceFile){
 const fd=fs.openSync(traceFile,'a');let activeRun=null,completedRuns=0;
 const pending=new Map();let serial=0;
 function trace(event){try{fs.writeSync(fd,JSON.stringify({time:new Date().toISOString(),pid:process.pid,active_run:activeRun,completed_runs:completedRuns,...event})+'\n');}catch{}}
 trace({event:'PROBE_STARTED',node:process.version,args:process.execArgv,node_options_present:Boolean(process.env.NODE_OPTIONS)});
 const base=path.dirname(path.resolve(process.argv[1]));
 const commonPath=path.join(base,'common.cjs');
 if(fs.existsSync(commonPath)){
  try{
   const C=require(commonPath),sign=C.sign,save=C.save,start=C.startChain;
   C.sign=function(body,...args){if(body&&body.grant_id&&body.issued_at!==undefined){const id=body.grant_id.replace(/-g\d+$/,'');if(id!==activeRun){activeRun=id;trace({event:'RUN_FIRST_GRANT'});}}return sign.call(this,body,...args);};
   C.save=function(file,value){const result=save.call(this,file,value);if(path.basename(file)==='runs.json'){completedRuns=value.length;trace({event:'RUNS_SAVED',last_completed_run:value.at(-1)?.id});}else if(path.basename(file)==='scope.json')trace({event:'SCOPE_SAVED',runs:value.runs});return result;};
   C.startChain=async function(...args){trace({event:'CHAIN_START'});const chain=await start.apply(this,args);trace({event:'CHAIN_READY',child_pid:chain.child.pid});chain.child.once('exit',(code,signal)=>trace({event:'CHAIN_EXIT',code,signal}));return chain;};
   const {JsonRpcProvider}=require(require.resolve('ethers',{paths:[base]}));const send=JsonRpcProvider.prototype.send;
   JsonRpcProvider.prototype.send=function(method,args){const id=++serial,begin=Date.now();pending.set(id,{method,begin});let promise;try{promise=send.call(this,method,args);}catch(e){pending.delete(id);trace({event:'RPC_ERROR',method,error:String(e)});throw e;}
    return Promise.resolve(promise).then(x=>{pending.delete(id);return x;},e=>{pending.delete(id);trace({event:'RPC_ERROR',method,error:String(e)});throw e;});};
  }catch(e){trace({event:'PROBE_SETUP_ERROR',error:String(e),stack:e.stack});}
 }
 const heartbeat=setInterval(()=>trace({event:'PROBE_HEARTBEAT',pending_rpc:[...pending.values()].map(x=>({method:x.method,age_ms:Date.now()-x.begin}))}),10000);heartbeat.unref();
 process.on('uncaughtExceptionMonitor',e=>trace({event:'UNCAUGHT_EXCEPTION',error:String(e),stack:e.stack}));
 process.on('exit',code=>{trace({event:'PROCESS_EXIT',code,pending_rpc:[...pending.values()].map(x=>({method:x.method,age_ms:Date.now()-x.begin}))});try{fs.fsyncSync(fd);fs.closeSync(fd);}catch{}});
}
