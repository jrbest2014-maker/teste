import assert from 'node:assert/strict';
import { VOneOwnedExecutorWorker, type MasterWorkerClient, type MasterWorkerJob } from './vone_owned_executor_worker';

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

async function main() {
    const master = new FakeMaster({
        id:'job-1',
        toolName:'vone_executor_execute',
        arguments:{
            protocol:'VONE_EXECUTION_CONTRACT_R1',
            mission_id:'vone-master',
            task_id:'task-1',
            checkpoint_revision:3,
            objective:'do the work',
            idempotency_key:'idem-0001',
            capacity_snapshot:null,
        },
    });
    const executor = {
        async execute(request: {sessionId:string; objective:string; taskId?:string}) {
            return {
                state:{
                    sessionId:request.sessionId,currentObjective:request.objective,stepsHistory:[],status:'DONE' as const,
                    checkpointRevision:4,executedActionKeys:{},artifacts:[{step:0,path:'out.txt',sha256:'abc'}],
                },
                telemetry:{
                    runId:'run-1',taskId:'task-1',sessionId:request.sessionId,routeId:'owned-local',model:'test',
                    stepCount:1,status:'DONE' as const,elapsedMs:12,checkpointRevision:4,artifactHashes:['abc'],
                    gateDecisions:[],errorClass:'None' as const,
                },
            };
        },
    };
    const worker = new VOneOwnedExecutorWorker({workerId:'worker-1',executor,master});
    await worker.heartbeat();
    assert.deepEqual(master.heartbeatPayload?.capabilities,['vone_executor_execute']);
    assert.equal(await worker.runOnce(),'DONE');
    assert.equal(master.completed.length,1);
    const payload=master.completed[0].result as Record<string,unknown>;
    assert.equal(payload.protocol,'VONE_EXECUTION_CONTRACT_R1');
    assert.equal(payload.status,'DONE');
    assert.equal(payload.checkpoint_revision,4);

    const staleMaster = new FakeMaster({
        id:'job-2', toolName:'vone_executor_execute',
        arguments:{protocol:'VONE_EXECUTION_CONTRACT_R1',mission_id:'vone-master',task_id:'task-2',checkpoint_revision:9,objective:'x',idempotency_key:'idem-0002'}
    });
    const staleWorker = new VOneOwnedExecutorWorker({workerId:'worker-1',executor,master:staleMaster});
    assert.equal(await staleWorker.runOnce(),'FAILED');
    assert.equal(staleMaster.failed[0].message,'stale_executor_checkpoint');

    console.log('vone_owned_executor_worker: all assertions passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
