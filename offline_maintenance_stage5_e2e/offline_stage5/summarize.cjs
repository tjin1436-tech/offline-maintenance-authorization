const fs=require('node:fs'),path=require('node:path');const C=require('./common.cjs');
function csv(file,rows){const keys=Object.keys(rows[0]);const cell=x=>JSON.stringify(x===null?'':String(x));fs.writeFileSync(file,'\ufeff'+keys.map(cell).join(',')+'\n'+rows.map(r=>keys.map(k=>cell(r[k])).join(',')).join('\n')+'\n');}
function write(dir){const runs=JSON.parse(fs.readFileSync(path.join(dir,'runs.json')));
 const rows=runs.map(r=>({run_id:r.id,repeat:r.repeat,scenario:r.scenario,policy:r.policy,injected_delay_ms:r.delay_ms,...r.metrics}));csv(path.join(dir,'run_summary.csv'),rows);
 const commands=runs.flatMap(r=>r.attempts.map(a=>({run_id:r.id,op_id:a.op_id,phase:a.phase,status:a.status,result:a.body.result||a.body.reason||a.body.error||'',duration_ms:a.end_ms-a.begin_ms,begin_ms:a.begin_ms,end_ms:a.end_ms})));csv(path.join(dir,'commands.csv'),commands);
 const auth=runs.flatMap(r=>r.auth_samples.map(a=>({run_id:r.id,kind:a.kind,status:a.status,duration_ms:a.end_ms-a.begin_ms,begin_ms:a.begin_ms,end_ms:a.end_ms})));csv(path.join(dir,'authorization_requests.csv'),auth);
 const groups=new Map();for(const r of runs){const key=[r.delay_ms,r.scenario,r.policy].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
 const fields=['command_p50_ms','command_p95_ms','denied_p50_ms','denied_p95_ms','detection_ms','recovery_detection_ms','flush_ms','restoration_to_flush_ms','authorization_http_requests'];
 const summary=[...groups.values()].map(g=>{const out={injected_delay_ms:g[0].delay_ms,scenario:g[0].scenario,policy:g[0].policy,n_runs:g.length,attempts:g.reduce((a,r)=>a+r.metrics.commands,0),accepted:g.reduce((a,r)=>a+r.metrics.accepted,0),offline_attempts:g.reduce((a,r)=>a+r.metrics.offline_commands,0),offline_accepted:g.reduce((a,r)=>a+r.metrics.offline_accepted,0)};
 for(const f of fields){const v=g.map(r=>r.metrics[f]).filter(x=>x!==null).sort((a,b)=>a-b);out[f+'_n']=v.length;out[f+'_median']=v.length?(v[Math.floor((v.length-1)/2)]+v[Math.floor(v.length/2)])/2:null;}return out;});
 C.save(path.join(dir,'summary.json'),summary);csv(path.join(dir,'summary.csv'),summary);return summary;
}
module.exports={write};if(require.main===module)write(path.resolve(process.argv[2]||'stage5_results'));
