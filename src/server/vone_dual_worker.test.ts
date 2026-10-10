import assert from 'node:assert/strict';
import type { MasterWorkerClient,MasterWorkerJob } from './vone_owned_executor_worker';
import { VOneDualWorker } from './vone_dual_worker';
class M implements MasterWorkerClient{
 jobs:MasterWorkerJob[]=[]; results=new Map<string,any>(); errors=new Map<string,string>(); hb:any[]=[];
 async heartbeat(p:Readonly<Record<string,unknown>>){this.hb.push(p)} async claim(){return this.jobs.shift()??null}
 async result(id:string,r:unknown){this.results.set(id,r)} async error(id:string,m:string){this.errors.set(id,m)}
}
const snap:any={protocol:'VONE_CAPACITY_SNAPSHOT_R1',generated_at:new Date().toISOString(),policy_id:'x',authority:'VONE_MASTER',
 task:{task_class:'LLM_FAST',privacy_class:'PRIVATE',prefer_local:true,locality:'client'},outcome:'ROUTE_SELECTED',
 selected:{route_id:'local',state:'FREE_AVAILABLE',route:{route_id:'local',kind:'desktop',provider:'ollama',state:'FREE_AVAILABLE',
 cost:{billing_mode:'included',variable_cost_allowed:false,verified_zero_cost:true},quota:{remaining_pct:100,reserve_threshold_pct:15,confidence:'verified'},
 capabilities:{task_classes:['LLM_FAST'],models:['v-one-coder:fast']},health:{observed_at:new Date().toISOString(),ttl_seconds:120},
 security:{trust_zone:'private_worker',allowed_privacy_classes:['PRIVATE']}}},invariants:{paid_blocked:'INVIOLABLE',unknown_cost:'HOLD',physical_output:'LOCKED'}};
async function main(){
 const m=new M(); let execCalls=0,infCalls=0;
 const owned:any={execute:async(r:any)=>{execCalls++;return {state:{sessionId:r.sessionId,status:'DONE',checkpointRevision:2,artifacts:[]},
 telemetry:{runId:'r',routeId:'local',model:'v-one-coder:fast',stepCount:1,elapsedMs:1,artifactHashes:[],gateDecisions:[],errorClass:'None'}}}};
 const inf:any={execute:async()=>{infCalls++;return {status:'DONE',target:'DESKTOP_LOCAL',reason:'local',model:'v-one-coder:fast',evidenceSha256:'b'.repeat(64)}}};
 const w=new VOneDualWorker({workerId:'w',master:m,ownedExecutor:{executor:owned,capacityValidation:{expectedProviderContains:'ollama'}},inferenceExecutor:inf});
 await w.heartbeat(); assert.deepEqual(m.hb[0].capabilities,['vone_executor_execute','vone_inference_execute']);
 m.jobs.push({id:'e',toolName:'vone_executor_execute',arguments:{protocol:'VONE_EXECUTION_CONTRACT_R1',mission_id:'m',task_id:'e',checkpoint_revision:1,objective:'x',idempotency_key:'e1',capacity_snapshot:snap}});
 assert.equal(await w.runOnce(),'DONE'); assert.equal(execCalls,1);
 m.jobs.push({id:'i',toolName:'vone_inference_execute',arguments:{protocol:'VONE_MASTER_INFERENCE_R1',mission_id:'m',task_id:'i',checkpoint_revision:2,idempotency_key:'i2',prompt:'x',estimated_neurons:1,capacity:{cloud:'FREE_EXHAUSTED',desktop:'ONLINE'}}});
 assert.equal(await w.runOnce(),'DONE'); assert.equal(infCalls,1); assert.equal(m.results.get('i').evidence_sha256,'b'.repeat(64));
 console.log('vone_dual_worker: all assertions passed');
} main().catch(e=>{console.error(e);process.exit(1)});
