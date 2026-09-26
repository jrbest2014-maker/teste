export type NeuronBudgetState = 'FREE_AVAILABLE' | 'FREE_QUOTA_LOW' | 'FREE_EXHAUSTED';

export interface NeuronBudgetSnapshot {
  readonly protocol: 'VONE_NEURON_BUDGET_R1';
  readonly dayUtc: string;
  readonly limit: number;
  readonly reserve: number;
  readonly used: number;
  readonly availableForDispatch: number;
  readonly state: NeuronBudgetState;
}

export class NeuronBudgetManager {
  private dayUtc: string;
  private used = 0;

  constructor(
    private readonly limit = 10_000,
    private readonly reserve = 500,
    now = new Date(),
  ) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('invalid neuron limit');
    if (!Number.isFinite(reserve) || reserve < 0 || reserve >= limit) throw new Error('invalid neuron reserve');
    this.dayUtc = this.utcDay(now);
  }

  public canDispatch(estimatedNeurons: number, now = new Date()): boolean {
    this.rollover(now);
    if (!Number.isFinite(estimatedNeurons) || estimatedNeurons <= 0) return false;
    return this.used + estimatedNeurons <= this.limit - this.reserve;
  }

  public recordActual(neurons: number, now = new Date()): NeuronBudgetSnapshot {
    this.rollover(now);
    if (!Number.isFinite(neurons) || neurons < 0) throw new Error('invalid neuron usage');
    this.used = Math.min(this.limit, this.used + neurons);
    return this.snapshot(now);
  }

  public markExhausted(now = new Date()): NeuronBudgetSnapshot {
    this.rollover(now);
    this.used = this.limit;
    return this.snapshot(now);
  }

  public snapshot(now = new Date()): NeuronBudgetSnapshot {
    this.rollover(now);
    const dispatchCeiling = this.limit - this.reserve;
    const availableForDispatch = Math.max(0, dispatchCeiling - this.used);
    const ratio = this.used / this.limit;
    const state: NeuronBudgetState =
      this.used >= dispatchCeiling ? 'FREE_EXHAUSTED' :
      ratio >= 0.9 ? 'FREE_QUOTA_LOW' :
      'FREE_AVAILABLE';
    return { protocol: 'VONE_NEURON_BUDGET_R1', dayUtc: this.dayUtc, limit: this.limit, reserve: this.reserve, used: this.used, availableForDispatch, state };
  }

  private rollover(now: Date): void {
    const day = this.utcDay(now);
    if (day !== this.dayUtc) { this.dayUtc = day; this.used = 0; }
  }
  private utcDay(now: Date): string { return now.toISOString().slice(0, 10); }
}
