import type { MasterWorkerClient, MasterWorkerJob } from './vone_owned_executor_worker';
import { VOneOwnedExecutorWorker, type OwnedExecutorWorkerOptions } from './vone_owned_executor_worker';
import { VOneMasterInferenceWorker } from './vone_master_inference_worker';
import type { VOneInferenceFailoverExecutor } from './vone_inference_failover_executor';

class SharedClaimMaster implements MasterWorkerClient {
  private current: MasterWorkerJob | null = null;
  constructor(private readonly upstream: MasterWorkerClient) {}
  set(job: MasterWorkerJob) { this.current = job; }
  async heartbeat(_:Readonly<Record<string,unknown>>):Promise<void> {}
  async claim():Promise<MasterWorkerJob|null> { const j=this.current; this.current=null; return j; }
  async result(id:string,result:unknown):Promise<void>{ await this.upstream.result(id,result); }
  async error(id:string,message:string):Promise<void>{ await this.upstream.error(id,message); }
}

export interface DualWorkerOptions {
  readonly workerId:string;
  readonly master:MasterWorkerClient;
  readonly ownedExecutor:Omit<OwnedExecutorWorkerOptions,'workerId'|'master'>;
  readonly inferenceExecutor:Pick<VOneInferenceFailoverExecutor,'execute'>;
  readonly heartbeatDetails?:Readonly<Record<string,unknown>>;
}

export class VOneDualWorker {
  private readonly execMaster:SharedClaimMaster;
  private readonly inferenceMaster:SharedClaimMaster;
  private readonly execWorker:VOneOwnedExecutorWorker;
  private readonly inferenceWorker:VOneMasterInferenceWorker;
  constructor(private readonly options:DualWorkerOptions){
    this.execMaster=new SharedClaimMaster(options.master);
    this.inferenceMaster=new SharedClaimMaster(options.master);
    this.execWorker=new VOneOwnedExecutorWorker({workerId:options.workerId,master:this.execMaster,...options.ownedExecutor});
    this.inferenceWorker=new VOneMasterInferenceWorker(options.workerId,this.inferenceMaster,options.inferenceExecutor);
  }
  async heartbeat():Promise<void>{
    await this.options.master.heartbeat({
      mode:'ONLINE',role:'DUAL_EXECUTOR_INFERENCE',
      capabilities:['vone_executor_execute','vone_inference_execute'],
      execution_contracts:['VONE_EXECUTION_CONTRACT_R1','VONE_MASTER_INFERENCE_R1'],
      ...(this.options.heartbeatDetails??{}),
    });
  }
  async runOnce():Promise<'IDLE'|'DONE'|'HOLD'|'BLOCKED'|'FAILED'>{
    const job=await this.options.master.claim();
    if(!job)return 'IDLE';
    if(job.toolName==='vone_executor_execute'){
      this.execMaster.set(job); return this.execWorker.runOnce();
    }
    if(job.toolName==='vone_inference_execute'){
      this.inferenceMaster.set(job); return this.inferenceWorker.runOnce();
    }
    await this.options.master.error(job.id,'unsupported_tool'); return 'FAILED';
  }
}
