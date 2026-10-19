'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const C=require('./common.cjs');
const {Harness}=require('./harness.cjs');
const {assert}=require('./net.cjs');
const VARIANTS=['full','late_reserve','retry_pending'];
const SCENARIOS=[['no_fault',null],['before_dispatch','after_reserve'],['after_effect','after_robot'],['during_done','during_done']];
const SOURCES=['run_ablation.cjs','audit_ablation.cjs','worker.cjs','store.cjs','harness.cjs','net.cjs','common.cjs','chain_node.cjs','contracts/OfflineRegistry.sol','package-lock.json','original_worker.cjs','stage6_source_hashes.json'];
async function runCase(h,base,variant,scenario,phase,repeat){
  const id=`${scenario}-${variant}-r${repeat}`,dir=path.join(base,'cases',id);
  const out={id,variant,scenario,repeat,checkpoint:phase,actions:[],pids:[]};let robot,gw;
  const act=async(name,endpoint,body)=>{const response=await h.call(gw,endpoint,body);out.actions.push({name,endpoint,response});assert(response.status!==0&&response.status<500,`${id}: transport/server error at ${name}`);return response;};
  try{
    robot=await h.worker('robot',dir);out.robot_pid=robot.child.pid;
    const start=async(checkpoint)=>{const x=await h.worker('gateway',dir,{robot_url:robot.url,ablation:variant,checkpoint});out.pids.push(x.child.pid);return x;};
    gw=await start(phase);out.grant=await h.issue(gw,id,120000,1);
    const first=h.signed(out.grant,id+'-op1'),second=h.signed(out.grant,id+'-op2');out.requests={first,second};
    if(phase){
      const pending=h.call(gw,'/execute',{request:first});
      await h.killAt(gw,pending,phase);out.interrupted_response=await pending;
      gw=await start(null);
    }else await act('initial','/execute',{request:first});
    out.after_restart={gateway:await h.snapshot(gw),robot:await h.snapshot(robot)};
    await act('recover','/recover',{});
    out.after_recover={gateway:await h.snapshot(gw),robot:await h.snapshot(robot)};
    await act('new_request_same_grant','/execute',{request:second});
    await act('replay_first','/execute',{request:first});
    await act('flush','/flush',{});
    out.final={gateway:await h.snapshot(gw),robot:await h.snapshot(robot)};
    // Successful execution of the experiment is distinct from a safe system outcome.
    out.completed=true;
  }catch(e){out.completed=false;out.error=String(e);throw e;}
  finally{
    try{await h.stop(gw);await h.stop(robot);}finally{C.save(path.join(dir,'case.json'),out);}
  }
  console.log(id,'recorded');return id;
}
async function main(){
  let output='stage7_results',repeats=3;
  const args=process.argv.slice(2);for(let i=0;i<args.length;i++){
    if(args[i]==='--output')output=args[++i];else if(args[i]==='--repeats')repeats=Number(args[++i]);else throw Error('Unknown option '+args[i]);
  }
  assert(Number.isInteger(repeats)&&repeats>=1&&repeats<=30,'repeats must be 1..30');
  const base=path.resolve(output);assert(!fs.existsSync(base)||fs.readdirSync(base).length===0,'Use a NEW empty output directory');fs.mkdirSync(base,{recursive:true});
  const protocol={version:'stage7-recovery-ablation-v1',created_at:new Date().toISOString(),repeats,
    variants:VARIANTS,scenarios:SCENARIOS,expected_cases:12*repeats,quota:1,grant_ttl_ms:120000,
    environments:{node:process.version,platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model},
    source_sha256:Object.fromEntries(SOURCES.map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,n))).digest('hex')])),
    design:{full:'Unchanged stage6 gateway behavior plus common observation events.',
      late_reserve:'Move the atomic quota reservation AND PENDING insert from before dispatch to after a verified robot reply. Keep SQLite durability, signatures, robot deduplication, completion transaction and EVM unchanged.',
      retry_pending:'Keep reservation unchanged; on /recover resend the identical signed command for PENDING instead of querying /receipt. Robot durable deduplication remains enabled.',
      schedule:'Initial op1; kill at selected checkpoint; restart; recover once; attempt distinct op2 under the SAME quota-one grant; replay op1; flush completed evidence. Rotate variant order by repeat.',
      endpoints:'Checkpoint before_dispatch is after reservation for full/retry_pending, before any reservation for late_reserve, immediately before the same robot HTTP dispatch.',
      outcome:'Safety violations in ablated variants are measured outcomes, not runner/audit failures. No significance or latency claims from these controlled repetitions.'},
    limits:['Single host loopback; simulated atomic effect+durable receipt, NOT physical robot actions.',
      'Forced process termination, NOT power loss; robot is not killed in this stage.',
      'Trusted clock, storage and receipt endpoint. No expiry/revocation/network-loss injection.',
      'late_reserve removes the pre-execution reservation/intent pair as a unit; it does not identify the independent contribution of counter vs intent.',
      'retry_pending remains protected by robot-side durable deduplication; lack of duplicates is conditional on that protection.',
      'No long-duration, throughput, centralized-backend or blockchain-benefit comparison. Keep Linux and Windows batches separate.']};
  C.save(path.join(base,'protocol.json'),protocol);
  const h=new Harness(base),ids=[];let status={completed:false};
  try{
    await h.start();
    for(let repeat=1;repeat<=repeats;repeat++)for(const [scenario,phase] of SCENARIOS)
      for(let i=0;i<VARIANTS.length;i++)ids.push(await runCase(h,base,VARIANTS[(i+repeat-1)%3],scenario,phase,repeat));
    const live=await h.liveCheck();status={completed:true,cases:ids.length,case_ids:ids,chain_records:live.records,transactions:h.transactions.length};
  }catch(e){status.error=String(e);throw e;}
  finally{
    try{await h.close();}catch(e){status.completed=false;status.cleanup_error=String(e);throw e;}
    finally{C.save(path.join(base,'completion.json'),status);}
  }
  console.log('Measurements completed. Run audit_ablation.cjs to independently derive the outcomes.');
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
