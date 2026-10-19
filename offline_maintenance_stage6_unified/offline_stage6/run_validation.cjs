'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const C=require('./common.cjs');const {Harness}=require('./harness.cjs');
const {assert,sleep,performance}=require('./net.cjs');
const CASES=[
  ['U01','before_reserve','reserve_not_started'],['U02','during_reserve','reserve_transaction_rollback'],
  ['U03','after_reserve','unknown_stays_pending'],['U04','after_robot','receipt_recovers_done'],
  ['U05','during_done','done_transaction_rollback'],['U06','after_done','done_before_reply'],
  ['U07','after_chain','chain_accept_before_local_mark'],['U08',null,'lost_bridge_response'],
  ['U09','after_chain','two_record_resume'],['U10','after_sync','synced_before_reply'],
  ['U11',null,'robot_receipt_survives_restart'],['U12','after_done','untrusted_clock_restart']
];
function options(){const o={output:'stage6_results',repeats:3,soakSeconds:120,mode:'full'};
  const a=process.argv.slice(2);for(let i=0;i<a.length;i++){
    if(a[i]==='--output')o.output=a[++i];else if(a[i]==='--repeats')o.repeats=Number(a[++i]);
    else if(a[i]==='--soak-seconds')o.soakSeconds=Number(a[++i]);else if(a[i]==='--mode')o.mode=a[++i];else throw Error('Unknown option '+a[i]);}
  assert(Number.isInteger(o.repeats)&&o.repeats>=1&&o.repeats<=30,'repeats 1..30');
  assert(['full','smoke'].includes(o.mode),'mode full/smoke');assert(o.soakSeconds>=0&&o.soakSeconds<=3600,'soak 0..3600');return o;}
const result=r=>r.body.result;
async function faultCase(h,base,def,rep){
  const [id,phase,label]=def,context=id+'-r'+rep,dir=path.join(base,'faults',context);let robot,gw;
  const outcome={id,repeat:rep,label,context,expected:{done:id==='U03'?0:id==='U09'?2:1,
    used:id==='U09'?2:1,robot_effects:id==='U03'?0:id==='U09'?2:1,synced:id==='U03'?0:id==='U09'?2:1},checks:[],actions:[],snapshots:{}};
  const check=(name,ok)=>{outcome.checks.push({name,passed:!!ok});assert(ok,context+': '+name);};
  const act=async(name,url,b)=>{const r=await h.call(gw,url,b);outcome.actions.push({name,response:r});return r;};
  const start=async(extra={})=>h.worker('gateway',dir,{robot_url:robot.url,checkpoint:phase,...extra});
  try{
    robot=await h.worker('robot',dir,id==='U11'?{checkpoint:'robot_after_commit'}:{});gw=await start();
    const grant=await h.issue(gw,context,60000,['U03','U09','U12'].includes(id)?2:1);outcome.grant=grant;
    const r1=h.signed(grant,context+'-op1'),r2=h.signed(grant,context+'-op2');
    const restart=async(extra={})=>{gw=await start({checkpoint:null,...extra});};
    if(['U07','U08','U09','U10'].includes(id)){
      check('initial DONE',result(await act('execute','/execute',{request:r1}))==='DONE');
      if(id==='U09')check('second DONE',result(await act('execute2','/execute',{request:r2}))==='DONE');
      if(id==='U08'){h.dropAck=true;const a=await act('lost_ack_flush','/flush',{});check('lost ack remains unconfirmed',a.body.results[0].result==='UNAVAILABLE');await h.stop(gw,true);}
      else await h.killAt(gw,h.call(gw,'/flush',{}),phase);
      await restart();outcome.snapshots.after_restart=await h.snapshot(gw);
      const upload=await act('resume_flush','/flush',{}),got=upload.body.results.map(x=>x.result);
      check('expected retry results',JSON.stringify(got)===JSON.stringify(id==='U10'?[]:id==='U09'?['DUPLICATE','ACCEPTED']:['DUPLICATE']));
      check('request replay',result(await act('replay','/execute',{request:r1}))==='REPLAY');
    }else if(id==='U11'){
      const running=h.call(gw,'/execute',{request:r1});await h.killAt(robot,running,'robot_after_commit');
      await h.stop(gw,true);robot=await h.worker('robot',dir);await restart();
      outcome.snapshots.after_restart=await h.snapshot(gw);
      check('PENDING before receipt recovery',outcome.snapshots.after_restart.ops[0].state==='PENDING');
      check('receipt survives robot restart',(await act('recover','/recover',{})).body.results[0].result==='RECOVERED');
      check('request replay',result(await act('replay','/execute',{request:r1}))==='REPLAY');await act('flush','/flush',{});
    }else{
      await h.killAt(gw,h.call(gw,'/execute',{request:r1}),phase);
      await restart(id==='U12'?{clock_trusted:false}:{});outcome.snapshots.after_restart=await h.snapshot(gw);
      const s=outcome.snapshots.after_restart;
      if(['U01','U02'].includes(id)){
        check('reservation fully absent',s.grants[0].used===0&&s.ops.length===0);
        check('retry accepted once',result(await act('retry','/execute',{request:r1}))==='DONE');
      }else if(id==='U03'){
        check('reservation retained',s.grants[0].used===1&&s.ops[0].state==='PENDING');
        check('receipt unknown',(await act('recover','/recover',{})).body.results[0].result==='PENDING');
        check('same request not resent',result(await act('retry','/execute',{request:r1}))==='PENDING');
        check('next operation blocked',result(await act('next','/execute',{request:r2}))==='PENDING_BLOCK');
      }else if(['U04','U05'].includes(id)){
        check('PENDING persisted',s.ops[0].state==='PENDING');
        check('recovered from receipt',(await act('recover','/recover',{})).body.results[0].result==='RECOVERED');
        check('request replay',result(await act('replay','/execute',{request:r1}))==='REPLAY');
      }else{
        check('DONE persisted',s.ops[0].state==='DONE');
        check('request replay',result(await act('replay','/execute',{request:r1}))==='REPLAY');
        check('new request denied',result(await act('next','/execute',{request:r2}))===(id==='U12'?'CLOCK_UNTRUSTED':'QUOTA'));
      }
      await act('flush','/flush',{});
    }
    outcome.gateway=await h.snapshot(gw);outcome.robot=await h.snapshot(robot);
    const obs={done:outcome.gateway.ops.filter(x=>x.state==='DONE').length,used:outcome.gateway.grants.reduce((s,x)=>s+x.used,0),
      robot_effects:outcome.robot.robot.reduce((s,x)=>s+x.effect_count,0),synced:outcome.gateway.ops.filter(x=>x.synced).length};outcome.observed=obs;
    check('final counts',JSON.stringify(obs)===JSON.stringify(outcome.expected));outcome.passed=true;
    return outcome;
  }catch(e){outcome.passed=false;outcome.error=String(e);throw e;}
  finally{C.save(path.join(dir,'case.json'),outcome);await h.stop(gw);await h.stop(robot);}
}
async function functional(h,base){
  const dir=path.join(base,'functional'),checks=[];const ck=(name,ok)=>{checks.push({name,passed:!!ok});assert(ok,name);};
  let robot,gw;
  try{
    robot=await h.worker('robot',dir);gw=await h.worker('gateway',dir,{robot_url:robot.url});
    const g=await h.issue(gw,'functional',60000,2),a=h.signed(g,'functional-a');
    const bad=structuredClone(a);bad.signature=Buffer.alloc(64).toString('base64');
    ck('bad subject signature rejected',result(await h.call(gw,'/execute',{request:bad}))==='BAD_SIGNATURE');
    ck('wrong robot rejected',result(await h.call(gw,'/execute',{request:h.signed(g,'wrong-scope',{robot:'robot-other'})}))==='BAD_SCOPE');
    const duplicate=await Promise.all([h.call(gw,'/execute',{request:a}),h.call(gw,'/execute',{request:a})]);
    ck('concurrent exact duplicates execute once',JSON.stringify(duplicate.map(result).sort())===JSON.stringify(['DONE','REPLAY']));
    ck('same id changed request rejected',result(await h.call(gw,'/execute',{request:h.signed(g,'functional-a',{operation:'other'})}))==='REQUEST_CONFLICT');
    ck('grant reinstall preserves quota',result(await h.call(gw,'/install',{grant:g}))==='EXISTING');
    const next=await Promise.all([h.call(gw,'/execute',{request:h.signed(g,'functional-b')}),h.call(gw,'/execute',{request:h.signed(g,'functional-c')})]);
    ck('last quota slot serialized',JSON.stringify(next.map(result).sort())===JSON.stringify(['DONE','QUOTA']));
    const expired=C.sign({...g.body,grant_id:'expired-functional',issued_at:Date.now()-1000,expires_at:Date.now()-1},h.pairs.issuer);
    await h.call(gw,'/install',{grant:expired});ck('expired grant rejected',result(await h.call(gw,'/execute',{request:h.signed(expired,'expired-op')}))==='EXPIRED');
    const s=await h.snapshot(gw),op=s.ops[0],record=JSON.parse(op.record),ack=JSON.parse(op.ack);
    const wrongAck=C.sign({...ack.body,command_hash:'0x'+'0'.repeat(64)},h.pairs.robot);
    const mismatched=C.sign({...record.body,receipt_hash:C.hash(wrongAck)},h.pairs.gateway);
    const invalid=await require('./net.cjs').request(h.adapter.url+'/submit',{record:mismatched,ack:wrongAck});
    ck('signed but mismatched receipt rejected by adapter',invalid.status===403);
    const flush=await h.call(gw,'/flush',{});ck('valid queue drains',flush.body.results.length===2&&flush.body.results.every(x=>x.result==='ACCEPTED'));
    const out={checks,passed:checks.every(x=>x.passed),gateway:await h.snapshot(gw),robot:await h.snapshot(robot)};C.save(path.join(dir,'functional.json'),out);return out;
  }finally{await h.stop(gw);await h.stop(robot);}
}
async function benchmark(h,base,repeats,smoke){
  const runs=[];
  for(let repeat=1;repeat<=repeats;repeat++)for(const delay of smoke?[0]:[0,50])for(const scenario of smoke?['connected']:['connected','short_outage','long_outage'])
    for(const mode of repeat%2?['memory','durable']:['durable','memory'])for(let pi=0;pi<3;pi++){
      const policy=['online','fixed','adaptive'][(pi+repeat-1)%3],context=`bench-r${repeat}-d${delay}-${scenario}-${mode}-${policy}`;
      const dir=path.join(base,'benchmark',context);let robot,gw;
      const run={context,repeat,delay_ms:delay,scenario,mode,policy,attempts:[],grants:[],history_ms:[500,500,750,750,500,750,500,500]};
      try{
        h.gate={open:true,delay};robot=await h.worker('robot',dir);gw=await h.worker('gateway',dir,{robot_url:robot.url,mode,policy});
        const getGrant=async()=>{const sorted=[...run.history_ms].slice(-20).sort((a,b)=>a-b);
          const ttl=policy==='online'?1000:policy==='fixed'?4000:Math.min(6000,Math.max(1000,Math.ceil(2*(sorted[Math.ceil(.9*sorted.length)-1]+250))));
          const begin=performance.now(),g=await h.issue(gw,context,ttl);run.grants.push({grant:g,ttl_ms:ttl,history_ms:[...run.history_ms],preparation_ms:performance.now()-begin});return g;};
        let grant=await getGrant();
        const duration=scenario==='short_outage'?1500:scenario==='long_outage'?4500:0;
        const start=performance.now();run.outage_begin_wall_ms=duration?Date.now():null;if(duration)h.gate.open=false;
        const offsets=duration?[0,.2,.4,.6,.8].map(x=>x*duration):[0,100,200,300,400];
        for(let k=0;k<5;k++){
          const remain=start+offsets[k]-performance.now();if(remain>0)await sleep(remain);
          if(policy==='online'&&!duration)grant=await getGrant();
          const signed=h.signed(grant,context+'-op'+k),wall=Date.now();
          const r=await h.call(gw,'/execute',{request:signed},3000);run.attempts.push({phase:duration?'offline':'connected',signed,wall_ms:wall,planned_offset_ms:offsets[k],...r});
        }
        if(duration){const remain=start+duration-performance.now();if(remain>0)await sleep(remain);h.gate.open=true;
          run.outage_end_wall_ms=Date.now();run.measured_outage_ms=performance.now()-start;run.history_ms.push(run.measured_outage_ms);}
        grant=await getGrant();const signed=h.signed(grant,context+'-recovery');const r=await h.call(gw,'/execute',{request:signed});
        run.attempts.push({phase:'recovery',signed,wall_ms:Date.now(),...r});assert(result(r)==='DONE','recovery command failed');
        const flushStart=performance.now();run.flush=await h.call(gw,'/flush',{});run.flush_ms=performance.now()-flushStart;
        run.gateway=await h.snapshot(gw);run.robot=await h.snapshot(robot);
        const accepted=run.attempts.filter(a=>result(a)==='DONE');
        assert(accepted.length===run.gateway.ops.length&&run.gateway.ops.every(o=>o.synced===1),'queue/count mismatch');
        assert(run.robot.robot.length===accepted.length,'robot count mismatch');
        run.accepted=accepted.length;run.offline_accepted=accepted.filter(a=>a.phase==='offline').length;
        run.passed=true;runs.push(run);console.log(context,`accepted=${run.accepted}, offline=${run.offline_accepted}`);
      }catch(e){run.passed=false;run.error=String(e);throw e;}
      finally{h.gate={open:true,delay:0};C.save(path.join(dir,'run.json'),run);await h.stop(gw);await h.stop(robot);}
      C.save(path.join(base,'benchmark.json'),runs);
    }
  return runs;
}
async function soak(h,base,seconds){
  const dir=path.join(base,'soak');let robot,gw;const out={planned_seconds:seconds,attempts:[],flushes:[],grants:[]};
  try{
    robot=await h.worker('robot',dir);gw=await h.worker('gateway',dir,{robot_url:robot.url});
    let grant=await h.issue(gw,'soak',30000,10000);out.grants.push(grant);
    const start=performance.now();out.start_wall_ms=Date.now();let count=0;
    while(performance.now()-start<seconds*1000){
      if(Date.now()+2000>=grant.body.expires_at){grant=await h.issue(gw,'soak',30000,10000);out.grants.push(grant);}
      const signed=h.signed(grant,'soak-op'+(++count)),r=await h.call(gw,'/execute',{request:signed});
      out.attempts.push({signed,...r});assert(result(r)==='DONE','soak command failed');
      if(count%20===0){out.flushes.push(await h.call(gw,'/flush',{},60000));console.log('soak',count,Math.round((performance.now()-start)/1000)+'s');}
      await sleep(50);
    }
    out.flushes.push(await h.call(gw,'/flush',{},60000));out.elapsed_seconds=(performance.now()-start)/1000;out.end_wall_ms=Date.now();
    out.gateway=await h.snapshot(gw);out.robot=await h.snapshot(robot);
    assert(out.gateway.ops.length===count&&out.gateway.ops.every(x=>x.synced===1)&&out.robot.robot.length===count,'soak counts');
    out.passed=true;return out;
  }catch(e){out.passed=false;out.error=String(e);throw e;}
  finally{C.save(path.join(dir,'soak.json'),out);await h.stop(gw);await h.stop(robot);}
}
async function main(){
  const opt=options(),base=path.resolve(opt.output);assert(!fs.existsSync(base)||fs.readdirSync(base).length===0,'Use a new empty output directory');fs.mkdirSync(base,{recursive:true});
  const protocol={version:'stage6-unified-v1',...opt,created_at:new Date().toISOString(),fault_cases:CASES,
    expected_fault_cases:CASES.length*opt.repeats,expected_benchmark_runs:opt.mode==='smoke'?6*opt.repeats:36*opt.repeats,
    environments:{node:process.version,platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,total_memory:os.totalmem()},
    source_sha256:Object.fromEntries(['worker.cjs','store.cjs','harness.cjs','run_validation.cjs','audit.cjs','net.cjs','common.cjs','contracts/OfflineRegistry.sol'].map(f=>[f,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname,f))).digest('hex')])),
    limits:['Loopback HTTP, software robot and one ephemeral Ganache node','Gateway and robot are separate processes; issuer/adapter/relays share controller',
      'SIGKILL/TerminateProcess, not power loss or disk failure','Trusted local clock, keys, adapter, unrolled-back storage','Single serialized gateway; no shared multi-gateway quota',
      'Memory comparator uses identical SQL and protocol but an in-memory gateway database; robot remains durable','This is not a rerun of stage5 or a centralized registry baseline',
      'No automatic resend of unknown actions; PENDING may block indefinitely','No claim that Linux soak repairs or explains prior Windows Node crash']};
  C.save(path.join(base,'protocol.json'),protocol);
  const h=new Harness(base),faults=[];let status={completed:false};
  try{
    await h.start();for(let rep=1;rep<=opt.repeats;rep++)for(const def of CASES){faults.push(await faultCase(h,base,def,rep));C.save(path.join(base,'faults.json'),faults);console.log(def[0],rep,'PASS');}
    const func=await functional(h,base);const runs=await benchmark(h,base,opt.repeats,opt.mode==='smoke');
    const sr=opt.soakSeconds?await soak(h,base,opt.soakSeconds):null;
    const live=await h.liveCheck();status={completed:true,fault_cases:faults.length,functional_checks:func.checks.length,benchmark_runs:runs.length,
      soak_commands:sr?.attempts.length||0,chain_records:live.records,transactions:h.transactions.length};
  }catch(e){status.error=String(e);throw e;}
  finally{
    try{await h.close();}catch(e){status.completed=false;status.cleanup_error=String(e);throw e;}
    finally{C.save(path.join(base,'completion.json'),status);}
  }
  console.log(JSON.stringify(status));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={CASES};
