import assert from 'node:assert/strict';
import { VOneOwnedExecutorWorker, type MasterWorkerClient, type MasterWorkerJob } from './vone_owned_executor_worker';
import type { VOneCapacitySnapshotR1 } from './vone_capacity_snapshot';

class FakeMaster implements MasterWorkerClient {
    public heartbeatPayload: Readonly<Record<string, unknown>> | null = null;
    public completed: Array<{ id: string; result: unknown }> = [];
    public failed: Array<{ id: string; message: string }> = [];
    constructor(private job: MasterWorkerJob | null) {}
    async heartbeat(payload: Readonly<Record<string, unknown>>) { this.heartbeatPayload = payload; }
    async claim() { const j=this.job; this.job=null; return j; }
    async result(id: string, result: unknown) { this.completed.push({id,result}); }
    async error(id: string, message: string) { this.failed.push({id,message}); }
}

function capacitySnapshot(now=Date.now()): VOneCapacitySnapshotR1 {
    return {
        protocol:'VONE_CAPACITY_SNAPSHOT_R1',
        generated_at:new Date(now).toISOString(),
        policy_id:'VONE_ZERO_COST_DEFAULT',
        authority:'VONE_MASTER',
        task:{task_class:'LLM_FAST',privacy_class:'PRIVATE',prefer_local:true,locality:'client'},
        outcome:'ROUTE_SELECTED',
        selected:{
            route_id:'local-ollama-vone-fallback',
            state:'FREE_AVAILABLE',
            route:{
                route_id:'local-ollama-vone-fallback',
                kind:'desktop',
                provider:'ollama',
                state:'FREE_AVAILABLE',
                cost:{billing_mode:'included',variable_cost_allowed:false,verified_zero_cost:true},
                quota:{remaining_pct:100,reserve_threshold_pct:15,confidence:'verified'},
                capabilities:{task_classes:['LLM_FAST'],models:['qwen2.5-coder:3b']},
                health:{observed_at:new Date(now).toISOString(),ttl_seconds:60},
                security:{trust_zone:'private_worker',allowed_privacy_classes:['PRIVATE']},
            },
        },
        invariants:{paid_blocked:'INVIOLABLE',unknown_cost:'HOLD',physical_output:'LOCKED'},
    };
}

function executorResult(sessionId:string, checkpointRevision=4) {
    return {
        state:{
            sessionId,currentObjective:'work',stepsHistory:[],status:'DONE' as const,
            checkpointRevision,executedActionKeys:{},artifacts:[{step:0,path:'out.txt',sha256:'abc'}],
        },
        telemetry:{
            runId:'run-1',taskId:'task-1',sessionId,routeId:'owned-local',model:'qwen2.5-coder:3b',
            stepCount:1,status:'DONE' as const,elapsedMs:12,checkpointRevision,artifactHashes:['abc'],
            gateDecisions:[],errorClass:'None' as const,
        },
    };
}

function job(id:string, revision=3, snapshot: VOneCapacitySnapshotR1 | null = capacitySnapshot()): MasterWorkerJob {
    return {
        id,
        toolName:'vone_executor_execute',
        arguments:{
            protocol:'VONE_EXECUTION_CONTRACT_R1',
            mission_id:'vone-master',
            task_id:'task-'+id,
            checkpoint_revision:revision,
            objective:'do the work',
            idempotency_key:'idem-'+id,
            capacity_snapshot:snapshot,
        },
    };
}

async function main() {
    const master = new FakeMaster(job('1'));
    let seenSession = '';
    const executor = {
        async execute(request: {sessionId:string; objective:string; taskId?:string}) {
            seenSession = request.sessionId;
            return executorResult(request.sessionId,4);
        },
    };
    const worker = new VOneOwnedExecutorWorker({
        workerId:'worker-1',
        executor,
        master,
        heartbeatDetails:{backend:'ollama'},
        capacityValidation:{expectedProviderContains:'ollama',preferredModel:'qwen2.5-coder:3b'},
    });
    await worker.heartbeat();
    assert.deepEqual(master.heartbeatPayload?.capabilities,['vone_executor_execute']);
    assert.equal(master.heartbeatPayload?.active_job_id,null);
    assert.equal(master.heartbeatPayload?.backend,'ollama');

    assert.equal(await worker.runOnce(),'DONE');
    assert.equal(seenSession,'idem-1');
    assert.equal(master.completed.length,1);
    const payload=master.completed[0].result as Record<string,unknown>;
    assert.equal(payload.protocol,'VONE_EXECUTION_CONTRACT_R1');
    assert.equal(payload.status,'DONE');
    assert.equal(payload.checkpoint_revision,3);
    assert.equal((payload.evidence as Record<string,unknown>).local_checkpoint_revision,4);

    const sourceRevisionMaster = new FakeMaster(job('2',9));
    const sourceRevisionWorker = new VOneOwnedExecutorWorker({
        workerId:'worker-1',executor,master:sourceRevisionMaster,
        capacityValidation:{expectedProviderContains:'ollama',preferredModel:'qwen2.5-coder:3b'},
    });
    assert.equal(await sourceRevisionWorker.runOnce(),'DONE');
    const sourceRevisionPayload=sourceRevisionMaster.completed[0].result as Record<string,unknown>;
    assert.equal(sourceRevisionPayload.checkpoint_revision,9);
    assert.equal((sourceRevisionPayload.evidence as Record<string,unknown>).local_checkpoint_revision,4);

    const missingMaster = new FakeMaster(job('3',3,null));
    const missingWorker = new VOneOwnedExecutorWorker({workerId:'worker-1',executor,master:missingMaster});
    assert.equal(await missingWorker.runOnce(),'BLOCKED');
    assert.equal(missingMaster.failed.length,0);
    const blocked = missingMaster.completed[0].result as Record<string,unknown>;
    assert.equal(blocked.status,'BLOCKED');
    assert.equal(blocked.error_class,'capacity_snapshot_required');

    const providerMaster = new FakeMaster(job('4'));
    const providerWorker = new VOneOwnedExecutorWorker({
        workerId:'worker-1',executor,master:providerMaster,
        capacityValidation:{expectedProviderContains:'cloudflare'},
    });
    assert.equal(await providerWorker.runOnce(),'BLOCKED');
    const providerBlocked = providerMaster.completed[0].result as Record<string,unknown>;
    assert.equal(providerBlocked.error_class,'capacity_snapshot_provider_mismatch');

    let release!: (value: ReturnType<typeof executorResult>) => void;
    const activeMaster = new FakeMaster(job('5'));
    const slowExecutor = {
        async execute(request:{sessionId:string;objective:string;taskId?:string}) {
            return await new Promise<ReturnType<typeof executorResult>>((resolve)=>{release=resolve;});
        },
    };
    const activeWorker = new VOneOwnedExecutorWorker({workerId:'worker-1',executor:slowExecutor,master:activeMaster});
    const activeRun = activeWorker.runOnce();
    await new Promise((resolve)=>setTimeout(resolve,0));
    await activeWorker.heartbeat();
    assert.equal(activeMaster.heartbeatPayload?.active_job_id,'5');
    release(executorResult('idem-5',4));
    assert.equal(await activeRun,'DONE');
    await activeWorker.heartbeat();
    assert.equal(activeMaster.heartbeatPayload?.active_job_id,null);

    console.log('vone_owned_executor_worker: all assertions passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
