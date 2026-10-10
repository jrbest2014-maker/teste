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
  readonly hubChat?: (prompt:string,maxTokens:number)=>Promise<{text:string;model:string;routeId:string}>;
  readonly heartbeatDetails?:Readonly<Record<string,unknown>> | (() => Readonly<Record<string,unknown>> | Promise<Readonly<Record<string,unknown>>>);
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
    const configured = this.options.heartbeatDetails;
    const details = typeof configured === 'function' ? await configured() : (configured ?? {});
    await this.options.master.heartbeat({
      mode:'ONLINE',role:'DUAL_EXECUTOR_INFERENCE',
      capabilities:['vone_executor_execute','vone_inference_execute','vone_hub_chat','CODE_REVIEW'],
      task_classes:['CODE_REVIEW'],
      execution_contracts:['VONE_EXECUTION_CONTRACT_R1','VONE_MASTER_INFERENCE_R1','VONE_HUB_CHAT_R1'],
      ...details,
    });
  }
  async runOnce():Promise<'IDLE'|'DONE'|'HOLD'|'BLOCKED'|'FAILED'>{
    const job=await this.options.master.claim();
    if(!job)return 'IDLE';
    if(job.toolName==='vone_hub_chat'){
      const a=job.arguments as Record<string,unknown>;
      if(!this.options.hubChat || a?.protocol!=='VONE_HUB_CHAT_R1' || typeof a.prompt!=='string' || !a.prompt.trim() || typeof a.task_id!=='string'){
        await this.options.master.error(job.id,'hub_chat_contract_invalid');return 'FAILED';
      }
      try {
        const out=await this.options.hubChat(a.prompt,Math.max(64,Math.min(1400,Number(a.max_tokens)||512)));
        await this.options.master.result(job.id,{protocol:'VONE_HUB_CHAT_R1',status:'DONE',task_id:a.task_id,text:out.text,model:out.model,route_id:out.routeId,worker_id:this.options.workerId});
        return 'DONE';
      }catch(error){await this.options.master.error(job.id,String(error instanceof Error?error.message:error).slice(0,200));return 'FAILED';}
    }
    if(job.toolName==='vone_executor_execute'){
      this.execMaster.set(job); return this.execWorker.runOnce();
    }
    if(job.toolName==='vone_inference_execute'){
      this.inferenceMaster.set(job); return this.inferenceWorker.runOnce();
    }
    await this.options.master.error(job.id,'unsupported_tool'); return 'FAILED';
  }
}
