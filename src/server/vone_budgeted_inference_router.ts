import { InferenceCapacity, CapacityDecision, selectInferenceCapacity } from './vone_cloud_inference_policy';
import { NeuronBudgetManager, NeuronBudgetSnapshot } from './vone_neuron_budget';

export interface BudgetedRoutingDecision extends CapacityDecision {
  readonly budget: NeuronBudgetSnapshot;
  readonly estimatedNeurons: number;
}

export class BudgetedInferenceRouter {
  constructor(private readonly budget: NeuronBudgetManager) {}

  public select(
    capacity: InferenceCapacity,
    estimatedNeurons: number,
    now = new Date(),
  ): BudgetedRoutingDecision {
    const budget = this.budget.snapshot(now);
    const cloudBudgetAvailable = this.budget.canDispatch(estimatedNeurons, now);
    const effective: InferenceCapacity = {
      ...capacity,
      cloud: capacity.cloud === 'FREE_AVAILABLE' && !cloudBudgetAvailable
        ? 'FREE_EXHAUSTED'
        : capacity.cloud,
    };
    const decision = selectInferenceCapacity(effective);
    return {
      ...decision,
      reason: capacity.cloud === 'FREE_AVAILABLE' && !cloudBudgetAvailable
        ? decision.target === 'DESKTOP_LOCAL'
          ? 'cloud_budget_insufficient_local_worker_online'
          : 'cloud_budget_insufficient_no_local_capacity'
        : decision.reason,
      budget: this.budget.snapshot(now),
      estimatedNeurons,
    };
  }

  public recordCloudUsage(actualNeurons: number, now = new Date()): NeuronBudgetSnapshot {
    return this.budget.recordActual(actualNeurons, now);
  }

  public markCloudFreeExhausted(now = new Date()): NeuronBudgetSnapshot {
    return this.budget.markExhausted(now);
  }
}
