import { createHash } from 'node:crypto';
import { BudgetedInferenceRouter } from './vone_budgeted_inference_router';
import { CloudInferenceBlockedError, InferenceCapacity } from './vone_cloud_inference_policy';

export interface InferenceBackendResult {
  readonly text: string;
  readonly model: string;
  readonly neurons?: number;
}
export interface InferenceBackend {
  run(prompt: string, maxTokens: number): Promise<InferenceBackendResult>;
}
export interface FailoverExecutionResult {
  readonly protocol: 'VONE_INFERENCE_FAILOVER_R1';
  readonly status: 'DONE' | 'HOLD';
  readonly target: 'CLOUD_FREE' | 'DESKTOP_LOCAL' | 'HOLD';
  readonly reason: string;
  readonly text?: string;
  readonly model?: string;
  readonly neurons?: number;
  readonly evidenceSha256: string;
}

export class VOneInferenceFailoverExecutor {
  constructor(
    private readonly router: BudgetedInferenceRouter,
    private readonly cloud: InferenceBackend,
    private readonly local: InferenceBackend,
  ) {}

  public async execute(args: {
    prompt: string;
    maxTokens?: number;
    estimatedNeurons: number;
    capacity: InferenceCapacity;
    now?: Date;
  }): Promise<FailoverExecutionResult> {
    const now = args.now ?? new Date();
    const decision = this.router.select(args.capacity, args.estimatedNeurons, now);
    if (decision.target === 'HOLD') return this.result('HOLD', 'HOLD', decision.reason);

    if (decision.target === 'CLOUD_FREE') {
      try {
        const out = await this.cloud.run(args.prompt, args.maxTokens ?? 512);
        if (typeof out.neurons !== 'number' || !Number.isFinite(out.neurons) || out.neurons < 0) {
          return this.result('HOLD', 'HOLD', 'cloud_usage_missing_fail_closed');
        }
        this.router.recordCloudUsage(out.neurons, now);
        return this.result('DONE', 'CLOUD_FREE', decision.reason, out);
      } catch (error) {
        if (error instanceof CloudInferenceBlockedError && error.code === 'CLOUD_FREE_EXHAUSTED') {
          this.router.markCloudFreeExhausted(now);
        }
        if (args.capacity.desktop === 'ONLINE') {
          const out = await this.local.run(args.prompt, args.maxTokens ?? 512);
          return this.result('DONE', 'DESKTOP_LOCAL', 'cloud_execution_failed_local_fallback', out);
        }
        return this.result('HOLD', 'HOLD', 'cloud_execution_failed_no_local_capacity');
      }
    }

    const out = await this.local.run(args.prompt, args.maxTokens ?? 512);
    return this.result('DONE', 'DESKTOP_LOCAL', decision.reason, out);
  }

  private result(
    status: 'DONE' | 'HOLD',
    target: 'CLOUD_FREE' | 'DESKTOP_LOCAL' | 'HOLD',
    reason: string,
    out?: InferenceBackendResult,
  ): FailoverExecutionResult {
    const canonical = JSON.stringify({ status, target, reason, text: out?.text, model: out?.model, neurons: out?.neurons });
    return { protocol: 'VONE_INFERENCE_FAILOVER_R1', status, target, reason, text: out?.text, model: out?.model, neurons: out?.neurons, evidenceSha256: createHash('sha256').update(canonical).digest('hex') };
  }
}
