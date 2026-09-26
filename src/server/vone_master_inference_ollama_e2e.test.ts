import assert from 'node:assert/strict';
import type { MasterWorkerClient, MasterWorkerJob } from './vone_owned_executor_worker';
import { VOneMasterInferenceWorker } from './vone_master_inference_worker';
import { VOneInferenceFailoverExecutor, type InferenceBackend } from './vone_inference_failover_executor';
import { BudgetedInferenceRouter } from './vone_budgeted_inference_router';
import { NeuronBudgetManager } from './vone_neuron_budget';
import { OllamaInferenceBackend } from './vone_inference_backends';

class Master implements MasterWorkerClient {
  job:MasterWorkerJob|null=null; resultValue:any=null;
  async heartbeat(_:Readonly<Record<string,unknown>>){}
  async claim(){const j=this.job;this.job=null;return j;}
  async result(_:string,r:unknown){this.resultValue=r;}
  async error(_:string,m:string){throw new Error(m);}
}
async function main(){
  const master=new Master();
  master.job={id:'master-ollama-real-1',toolName:'vone_inference_execute',arguments:{
    protocol:'VONE_MASTER_INFERENCE_R1',mission_id:'master-real',task_id:'ollama-real',checkpoint_revision:35,
    idempotency_key:'master-real:ollama-real:35',prompt:'Responda exatamente: VONE_MASTER_OLLAMA_OK',
    max_tokens:16,estimated_neurons:1,capacity:{cloud:'FREE_EXHAUSTED',desktop:'ONLINE'},
  }};
  const cloud:InferenceBackend={run:async()=>{throw new Error('cloud must not be called');}};
  const failover=new VOneInferenceFailoverExecutor(
    new BudgetedInferenceRouter(new NeuronBudgetManager(10_000,500,new Date())),cloud,new OllamaInferenceBackend(),
  );
  const worker=new VOneMasterInferenceWorker('desktop-445339e-worker-01',master,failover);
  assert.equal(await worker.runOnce(),'DONE');
  assert.equal(master.resultValue.protocol,'VONE_MASTER_INFERENCE_R1');
  assert.equal(master.resultValue.checkpoint_revision,35);
  assert.equal(master.resultValue.target,'DESKTOP_LOCAL');
  assert.equal(master.resultValue.model,'v-one-coder:fast');
  assert.match(master.resultValue.evidence_sha256,/^[a-f0-9]{64}$/);
  console.log(JSON.stringify({test:'VONE_MASTER_OLLAMA_REAL_E2E_R1',status:'PASS',target:master.resultValue.target,model:master.resultValue.model,checkpoint:35,evidence:master.resultValue.evidence_sha256}));
}
main().catch(e=>{console.error(e);process.exit(1);});
