import assert from 'node:assert/strict';
import { VOneOwnedExecutorWorker, type MasterWorkerClient, type MasterWorkerJob } from './vone_owned_executor_worker';
import type { VOneCapacitySnapshotR1 } from './vone_capacity_snapshot';

class DurableMasterHarness implements MasterWorkerClient {
  private pending: MasterWorkerJob[] = [];
  private claimed = new Map<string, MasterWorkerJob>();
  public results = new Map<string, unknown>();
  public errors = new Map<string, string>();
  public heartbeats: Readonly<Record<string, unknown>>[] = [];

  enqueue(job: MasterWorkerJob) { this.pending.push(job); }
  get pendingCount() { return this.pending.length; }
  async heartbeat(payload: Readonly<Record<string, unknown>>) { this.heartbeats.push(payload); }
  async claim() {
    const job = this.pending.shift() ?? null;
    if (job) this.claimed.set(job.id, job);
    return job;
  }
  async result(id: string, result: unknown) { this.claimed.delete(id); this.results.set(id, result); }
  async error(id: string, message: string) { this.claimed.delete(id); this.errors.set(id, message); }
}

function snapshot(): VOneCapacitySnapshotR1 {
  const now = Date.now();
  return {
    protocol:'VONE_CAPACITY_SNAPSHOT_R1',generated_at:new Date(now).toISOString(),
    policy_id:'VONE_ZERO_COST_DEFAULT',authority:'VONE_MASTER',
    task:{task_class:'LLM_FAST',privacy_class:'PRIVATE',prefer_local:true,locality:'client'},
    outcome:'ROUTE_SELECTED',
    selected:{route_id:'desktop-worker-01',state:'FREE_AVAILABLE',route:{
      route_id:'desktop-worker-01',kind:'desktop',provider:'ollama',state:'FREE_AVAILABLE',
      cost:{billing_mode:'included',variable_cost_allowed:false,verified_zero_cost:true},
      quota:{remaining_pct:100,reserve_threshold_pct:15,confidence:'verified'},
      capabilities:{task_classes:['LLM_FAST'],models:['v-one-coder:fast']},
      health:{observed_at:new Date(now).toISOString(),ttl_seconds:120},
      security:{trust_zone:'private_worker',allowed_privacy_classes:['PRIVATE']},
    }},
    invariants:{paid_blocked:'INVIOLABLE',unknown_cost:'HOLD',physical_output:'LOCKED'},
  };
}

function job(): MasterWorkerJob {
  return { id:'mission-e2e-001', toolName:'vone_executor_execute', arguments:{
    protocol:'VONE_EXECUTION_CONTRACT_R1', mission_id:'master-e2e',
    task_id:'worker-01-resilience', checkpoint_revision:17,
    objective:'Validate durable Master handoff while desktop worker is replaceable.',
    idempotency_key:'e2e-worker-01-001', capacity_snapshot:snapshot(),
  }};
}

async function main() {
  const master = new DurableMasterHarness();
  master.enqueue(job());

  // Desktop is OFFLINE: no worker exists, therefore Master-owned job remains durable/pending.
  assert.equal(master.pendingCount, 1);
  assert.equal(master.results.size, 0);

  let executions = 0;
  const executor = { async execute(request:{sessionId:string;objective:string;taskId?:string}) {
    executions++;
    return {
      state:{sessionId:request.sessionId,currentObjective:request.objective,stepsHistory:[],status:'DONE' as const,
        checkpointRevision:18,executedActionKeys:{},artifacts:[{step:1,path:'evidence/e2e-worker-01.json',sha256:'e2e-sha-001'}]},
      telemetry:{runId:'run-e2e-001',taskId:request.taskId || 'worker-01-resilience',sessionId:request.sessionId,
        routeId:'desktop-worker-01',model:'v-one-coder:fast',stepCount:1,status:'DONE' as const,elapsedMs:9,
        checkpointRevision:18,artifactHashes:['e2e-sha-001'],gateDecisions:[],errorClass:'None' as const},
    };
  }};

  // Desktop returns: same Master state is claimed and executed.
  const worker = new VOneOwnedExecutorWorker({
    workerId:'desktop-445339e-worker-01', master, executor,
    heartbeatDetails:{identity_protocol:'VONE_WORKER_IDENTITY_R1',provider:'ollama',model:'v-one-coder:fast'},
    capacityValidation:{expectedProviderContains:'ollama',preferredModel:'v-one-coder:fast',maxSnapshotAgeMs:120000},
  });
  await worker.heartbeat();
  assert.equal(master.pendingCount, 1, 'heartbeat must not consume durable job');
  assert.equal(await worker.runOnce(), 'DONE');
  assert.equal(executions, 1);
  assert.equal(master.pendingCount, 0);
  assert.equal(master.errors.size, 0);
  const result = master.results.get('mission-e2e-001') as any;
  assert.equal(result.protocol, 'VONE_EXECUTION_CONTRACT_R1');
  assert.equal(result.status, 'DONE');
  assert.equal(result.checkpoint_revision, 17, 'Master source checkpoint must be preserved');
  assert.equal(result.evidence.local_checkpoint_revision, 18);
  assert.deepEqual(result.artifact_hashes, ['e2e-sha-001']);
  assert.equal(master.heartbeats.at(-1)?.identity_protocol, 'VONE_WORKER_IDENTITY_R1');

  console.log(JSON.stringify({
    test:'VONE_LOCAL_CONTROL_PLANE_E2E_R1', status:'PASS',
    offline_queue_preserved:true, reconnect_claim:true, executor_execute:true,
    evidence_returned:true, source_checkpoint:17, local_checkpoint:18,
    worker:'desktop-445339e-worker-01'
  }));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
