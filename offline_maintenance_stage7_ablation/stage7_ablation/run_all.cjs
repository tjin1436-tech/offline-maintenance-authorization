'use strict';
const {spawnSync}=require('node:child_process');const path=require('node:path');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major!==24||minor<15){console.error('Use Node.js 24.15.0 or newer 24.x, matching the stage6 environment.');process.exit(1);}
const args=process.argv.slice(2);let output='stage7_results';
for(let i=0;i<args.length;i++)if(args[i]==='--output')output=args[++i];
for(const [script,extra] of [['run_ablation.cjs',args],['audit_ablation.cjs',[output]],['test_audit.cjs',[output]]]){
  const r=spawnSync(process.execPath,[path.join(__dirname,script),...extra],{stdio:'inherit'});
  if(r.error||r.status!==0){console.error('Stopped at '+script,r.error||r.status);process.exit(r.status||1);}
}
console.log('All steps completed. Experiment outcomes and audit checks are in '+path.resolve(output));
