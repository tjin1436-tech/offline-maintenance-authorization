'use strict';
const {spawnSync}=require('node:child_process');const path=require('node:path');
const a=process.argv.slice(2),o={output:'stage6_results',repeats:'3',soak:'120'};
for(let i=0;i<a.length;i++){if(a[i]==='--output')o.output=a[++i];else if(a[i]==='--repeats')o.repeats=a[++i];else if(a[i]==='--soak-seconds')o.soak=a[++i];else throw Error('Unknown option '+a[i]);}
const steps=[['run_validation.cjs','--repeats',o.repeats,'--soak-seconds',o.soak,'--output',o.output],
  ...['audit.cjs','test_audit.cjs','replay_chain.cjs','summarize.cjs'].map(s=>[s,'--input',o.output])];
for(const [file,...args]of steps){console.log('\nRUN',file,...args);const r=spawnSync(process.execPath,[path.join(__dirname,file),...args],{stdio:'inherit'});
  if(r.error)throw r.error;if(r.status!==0){console.error('Stopped after failed step:',file);process.exit(r.status||1);}}
console.log('All steps completed. Results:',path.resolve(o.output));
