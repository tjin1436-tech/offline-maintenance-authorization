const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
function atomic(file,value){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2));fs.renameSync(temp,file);}
function launch(options={}){
 const base=options.base||__dirname,repeats=options.repeats||1,idleSeconds=options.idleSeconds||120;
 const benchmark=options.benchmark||path.join(base,'run_benchmark.cjs');
 const output=path.resolve(base,options.output||'stage5_diagnostic_run');
 if(!fs.existsSync(benchmark))throw Error('Put both diagnostic .cjs files beside run_benchmark.cjs');
 if(fs.existsSync(output)&&fs.readdirSync(output).length)throw Error('Output folder is not empty; choose a new --output');
 const log=output+'.console.log',probe=output+'.probe.jsonl',report=output+'.diagnostic.json';
 for(const p of [log,probe,report])if(fs.existsSync(p))throw Error('Diagnostic files already exist; choose a new --output');
 const fd=fs.openSync(log,'wx'),expected=repeats*18;let lastOutput=Date.now(),lastCompleted=null,marker=null,timedOut=false,interrupt=null,spawnError=null;
 let buffer='';const started=new Date().toISOString();
 const args=['--trace-uncaught','--trace-exit','--require',path.join(__dirname,'diagnostic_probe.cjs'),benchmark,'--repeats',String(repeats),'--output',output];
 const child=spawn(process.execPath,args,{cwd:base,stdio:['ignore','pipe','pipe'],env:{...process.env,STAGE5_DIAGNOSTIC_PROBE_FILE:probe},shell:false});
 function retain(data,stream){lastOutput=Date.now();fs.writeSync(fd,data);process[stream].write(data);if(stream==='stdout'){buffer+=data.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);const m=line.match(/^r\d+-d\d+-\S+/);if(m)lastCompleted=m[0];const done=line.match(/Completed runs:\s*(\d+)/);if(done)marker=Number(done[1]);}}}
 child.stdout.on('data',d=>retain(d,'stdout'));child.stderr.on('data',d=>retain(d,'stderr'));child.once('error',e=>{spawnError=String(e);});
 const timer=setInterval(()=>{if(Date.now()-lastOutput>idleSeconds*1000&&!timedOut){timedOut=true;const msg='\nDIAGNOSTIC: no stdout/stderr for '+idleSeconds+' seconds; stopping this benchmark child.\n';fs.writeSync(fd,msg);process.stderr.write(msg);child.kill('SIGTERM');}},Math.min(1000,idleSeconds*1000));
 const stop=signal=>{interrupt=signal;child.kill(signal);};const onInt=()=>stop('SIGINT'),onTerm=()=>stop('SIGTERM');process.once('SIGINT',onInt);process.once('SIGTERM',onTerm);
 return new Promise(resolve=>child.once('close',(code,signal)=>{
  clearInterval(timer);process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm);fs.fsyncSync(fd);fs.closeSync(fd);
  function read(name){try{return JSON.parse(fs.readFileSync(path.join(output,name)));}catch{return null;}}const scope=read('scope.json'),rows=read('runs.json');
  const required=['scope.json','runs.json','transactions.json','live_check.json','summary.json'];const missing=required.filter(n=>!fs.existsSync(path.join(output,n)));
  const complete=code===0&&!signal&&!timedOut&&!interrupt&&!spawnError&&marker===expected&&scope?.runs===expected&&scope?.repeats===repeats&&rows?.length===expected&&missing.length===0;
  const result={diagnostic_status:complete?'COMPLETED':'INCOMPLETE',started_at:started,ended_at:new Date().toISOString(),node:process.version,expected_runs:expected,completed_runs:rows?.length??null,last_completed_stdout:lastCompleted,completion_marker:marker,exit_code:code,signal,timeout:timedOut,idle_timeout_seconds:idleSeconds,user_interrupt:interrupt,spawn_error:spawnError,missing_files:missing,output,console_log:log,probe_log:probe,scope:'diagnostic wrapper and probe add overhead; discard these timings for publication; this is not a security audit'};
  atomic(report,result);console.log('\nDiagnostic status:',result.diagnostic_status,'\nReport:',report,'\nConsole log:',log,'\nProbe log:',probe);resolve(result);
 }));
}
async function main(){const args=process.argv.slice(2),o={};for(let i=0;i<args.length;i++){if(args[i]==='--repeats')o.repeats=Number(args[++i]);else if(args[i]==='--output')o.output=args[++i];else if(args[i]==='--idle-seconds')o.idleSeconds=Number(args[++i]);else throw Error('Unknown argument '+args[i]);}if(o.repeats!==undefined&&(!Number.isInteger(o.repeats)||o.repeats<1||o.repeats>30))throw Error('repeats must be 1..30');if(o.idleSeconds!==undefined&&(!Number.isInteger(o.idleSeconds)||o.idleSeconds<1||o.idleSeconds>600))throw Error('idle-seconds must be 1..600');const r=await launch(o);if(r.diagnostic_status!=='COMPLETED')process.exitCode=1;}
module.exports={launch};if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
