import { createHash } from 'node:crypto';
import type { MasterWorkerClient } from './vone_owned_executor_worker';
import type { InferenceCapacity } from './vone_cloud_inference_policy';
import type { VOneInferenceFailoverExecutor } from './vone_inference_failover_executor';

export interface MasterInferenceRequest {
  readonly protocol: 'VONE_MASTER_INFERENCE_R1';
  readonly mission_id: string;
  readonly task_id: string;
  readonly checkpoint_revision: number;
  readonly idempotency_key: string;
  readonly prompt: string;
  readonly max_tokens?: number;
  readonly estimated_neurons: number;
  readonly capacity: InferenceCapacity;
}

export interface MasterInferenceResult {
  readonly protocol: 'VONE_MASTER_INFERENCE_R1';
  readonly status: 'DONE' | 'HOLD';
  readonly mission_id: string;
  readonly task_id: string;
  readonly checkpoint_revision: number;
  readonly idempotency_key: string;
  readonly target: 'CLOUD_FREE' | 'DESKTOP_LOCAL' | 'HOLD';
  readonly reason: string;
  readonly model?: string;
  readonly neurons?: number;
  readonly evidence_sha256: string;
}

function assertRequest(value: unknown): asserts value is MasterInferenceRequest {
  if (!value || typeof value !== 'object') throw new Error('inference_request_required');
  const v = value as Record<string, unknown>;
  if (v.protocol !== 'VONE_MASTER_INFERENCE_R1') throw new Error('unsupported_inference_contract');
  for (const k of ['mission_id','task_id','idempotency_key','prompt'] as const)
    if (typeof v[k] !== 'string' || !(v[k] as string).trim()) throw new Error(`${k}_required`);
  if (!Number.isInteger(v.checkpoint_revision) || Number(v.checkpoint_revision) < 0) throw new Error('checkpoint_revision_invalid');
  if (typeof v.estimated_neurons !== 'number' || !Number.isFinite(v.estimated_neurons) || v.estimated_neurons <= 0)
    throw new Error('estimated_neurons_invalid');
}

export class VOneMasterInferenceWorker {
  private readonly completed = new Map<string, MasterInferenceResult>();
  constructor(
    private readonly workerId: string,
    private readonly master: MasterWorkerClient,
    private readonly executor: Pick<VOneInferenceFailoverExecutor, 'execute'>,
  ) {}

  async heartbeat(): Promise<void> {
    await this.master.heartbeat({ mode:'ONLINE', role:'INFERENCE_FAILOVER', capabilities:['vone_inference_execute'], execution_contracts:['VONE_MASTER_INFERENCE_R1'] });
  }

  async runOnce(): Promise<'IDLE'|'DONE'|'HOLD'|'FAILED'> {
    const job = await this.master.claim();
    if (!job) return 'IDLE';
    if (job.toolName !== 'vone_inference_execute') { await this.master.error(job.id,'unsupported_tool'); return 'FAILED'; }
    try {
      assertRequest(job.arguments);
      const request = job.arguments;
      const cached = this.completed.get(request.idempotency_key);
      if (cached) { await this.master.result(job.id, cached); return cached.status; }
      const out = await this.executor.execute({
        prompt:request.prompt, maxTokens:request.max_tokens, estimatedNeurons:request.estimated_neurons, capacity:request.capacity,
      });
      const result: MasterInferenceResult = {
        protocol:'VONE_MASTER_INFERENCE_R1', status:out.status, mission_id:request.mission_id, task_id:request.task_id,
        checkpoint_revision:request.checkpoint_revision, idempotency_key:request.idempotency_key,
        target:out.target, reason:out.reason, model:out.model, neurons:out.neurons, evidence_sha256:out.evidenceSha256,
      };
      this.completed.set(request.idempotency_key, result);
      await this.master.result(job.id,result);
      return result.status;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'inference_worker_failure';
      await this.master.error(job.id,message); return 'FAILED';
    }
  }
}

export function masterInferenceResultHash(result: MasterInferenceResult): string {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}
