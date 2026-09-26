import assert from 'node:assert/strict';
import type { MasterWorkerClient, MasterWorkerJob } from './vone_owned_executor_worker';
import { VOneMasterInferenceWorker } from './vone_master_inference_worker';

class MasterHarness implements MasterWorkerClient {
  jobs: MasterWorkerJob[]=[]; results=new Map<string,unknown>(); errors=new Map<string,string>(); heartbeats: unknown[]=[];
  async heartbeat(p:Readonly<Record<string,unknown>>){this.heartbeats.push(p);}
  async claim(){return this.jobs.shift()??null;}
  async result(id:string,r:unknown){this.results.set(id,r);}
  async error(id:string,m:string){this.errors.set(id,m);}
}
function request() { return {
  protocol:'VONE_MASTER_INFERENCE_R1' as const, mission_id:'mission-1', task_id:'task-1', checkpoint_revision:34,
  idempotency_key:'mission-1:task-1:34', prompt:'return marker', max_tokens:16, estimated_neurons:2,
  capacity:{cloud:'FREE_EXHAUSTED' as const,desktop:'ONLINE' as const},
};}
async function main(){
  const master=new MasterHarness(); let calls=0;
  const executor={execute:async()=>{calls++; return {
    protocol:'VONE_INFERENCE_FAILOVER_R1' as const,status:'DONE' as const,target:'DESKTOP_LOCAL' as const,
    reason:'cloud_unavailable_local_worker_online',text:'VONE_MASTER_OLLAMA_OK',model:'v-one-coder:fast',
    evidenceSha256:'a'.repeat(64),
  };}};
  const worker=new VOneMasterInferenceWorker('desktop-01',master,executor as any);
  await worker.heartbeat();
  assert.deepEqual((master.heartbeats[0] as any).capabilities,['vone_inference_execute']);
  master.jobs.push({id:'job-1',toolName:'vone_inference_execute',arguments:request()});
  assert.equal(await worker.runOnce(),'DONE');
  const first=master.results.get('job-1') as any;
  assert.equal(first.checkpoint_revision,34); assert.equal(first.idempotency_key,'mission-1:task-1:34');
  assert.equal(first.target,'DESKTOP_LOCAL'); assert.equal(first.evidence_sha256,'a'.repeat(64)); assert.equal(calls,1);

  master.jobs.push({id:'job-retry',toolName:'vone_inference_execute',arguments:request()});
  assert.equal(await worker.runOnce(),'DONE');
  assert.equal(calls,1,'same idempotency key must not execute twice');
  assert.deepEqual(master.results.get('job-retry'),first);

  master.jobs.push({id:'bad',toolName:'vone_inference_execute',arguments:{...request(),estimated_neurons:0}});
  assert.equal(await worker.runOnce(),'FAILED'); assert.equal(master.errors.get('bad'),'estimated_neurons_invalid');
  console.log(JSON.stringify({test:'VONE_MASTER_INFERENCE_R1',status:'PASS',checkpoint_preserved:true,idempotent_retry:true,evidence_returned:true}));
}
main().catch(e=>{console.error(e);process.exit(1);});
