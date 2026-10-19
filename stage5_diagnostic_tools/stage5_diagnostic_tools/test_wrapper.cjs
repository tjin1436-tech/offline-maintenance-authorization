const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');const {launch}=require('./run_diagnostic.cjs');
(async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'stage5-diag-test-')),results=[];try{
 const common=`const fs=require('fs'),a=process.argv.slice(2),out=a[a.indexOf('--output')+1];fs.mkdirSync(out,{recursive:true});`;
 for(const kind of ['complete','early_zero_exit','throw','timeout']){
  const base=path.join(root,kind);fs.mkdirSync(base);let script=common;
  if(kind==='complete')script+=`for(const n of ['transactions.json','live_check.json','summary.json'])fs.writeFileSync(out+'/'+n,'{}');fs.writeFileSync(out+'/scope.json',JSON.stringify({runs:18,repeats:1}));fs.writeFileSync(out+'/runs.json',JSON.stringify(Array(18).fill({})));console.log('Completed runs: 18');`;
  if(kind==='early_zero_exit')script+=`fs.writeFileSync(out+'/runs.json',JSON.stringify(Array(12).fill({})));console.log('r1-d50-connected-adaptive {}');`;
  if(kind==='throw')script+=`throw Error('fixture failure');`;
  if(kind==='timeout')script+=`setInterval(()=>{},1000);`;
  fs.writeFileSync(path.join(base,'fixture.cjs'),script);
  const r=await launch({base,benchmark:path.join(base,'fixture.cjs'),output:'result',repeats:1,idleSeconds:kind==='timeout'?1:5});
  assert.equal(r.diagnostic_status,kind==='complete'?'COMPLETED':'INCOMPLETE');
  if(kind==='early_zero_exit'){assert.equal(r.exit_code,0);assert.equal(r.completed_runs,12);}
  if(kind==='throw')assert.ok(fs.readFileSync(r.console_log,'utf8').includes('fixture failure'));
  if(kind==='timeout')assert.equal(r.timeout,true);
  results.push({case:kind,passed:true});
 }
 console.log(JSON.stringify({tests:results}));
 fs.writeFileSync(path.join(__dirname,'validation.json'),JSON.stringify({scope:'synthetic wrapper controls; no benchmark performance claim',tests:results},null,2));
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
