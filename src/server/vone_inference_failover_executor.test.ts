import * as assert from 'node:assert';
import { NeuronBudgetManager } from './vone_neuron_budget';
import { BudgetedInferenceRouter } from './vone_budgeted_inference_router';
import { VOneInferenceFailoverExecutor, InferenceBackend } from './vone_inference_failover_executor';
import { CloudInferenceBlockedError } from './vone_cloud_inference_policy';

async function main(): Promise<void> {
  const now = new Date('2026-09-26T12:00:00Z');
  const cloud: InferenceBackend = { run: async () => ({ text: 'cloud-ok', model: 'cloud', neurons: 3.1 }) };
  const local: InferenceBackend = { run: async () => ({ text: 'local-ok', model: 'ollama' }) };
  const budget = new NeuronBudgetManager(10_000, 500, now);
  const exec = new VOneInferenceFailoverExecutor(new BudgetedInferenceRouter(budget), cloud, local);
  const a = await exec.execute({ prompt: 'x', estimatedNeurons: 4, capacity: { cloud: 'FREE_AVAILABLE', desktop: 'ONLINE' }, now });
  assert.equal(a.target, 'CLOUD_FREE'); assert.equal(a.status, 'DONE'); assert.equal(budget.snapshot(now).used, 3.1);

  const exhausted = new NeuronBudgetManager(10_000, 500, now); exhausted.recordActual(9_500, now);
  const b = await new VOneInferenceFailoverExecutor(new BudgetedInferenceRouter(exhausted), cloud, local).execute({ prompt: 'x', estimatedNeurons: 1, capacity: { cloud: 'FREE_AVAILABLE', desktop: 'ONLINE' }, now });
  assert.equal(b.target, 'DESKTOP_LOCAL');

  const failing: InferenceBackend = { run: async () => { throw new Error('cloud down'); } };
  const c = await new VOneInferenceFailoverExecutor(new BudgetedInferenceRouter(new NeuronBudgetManager(10_000,500,now)), failing, local).execute({ prompt: 'x', estimatedNeurons: 1, capacity: { cloud: 'FREE_AVAILABLE', desktop: 'ONLINE' }, now });
  assert.equal(c.target, 'DESKTOP_LOCAL'); assert.equal(c.reason, 'cloud_execution_failed_local_fallback');

  const d = await new VOneInferenceFailoverExecutor(new BudgetedInferenceRouter(new NeuronBudgetManager(10_000,500,now)), failing, local).execute({ prompt: 'x', estimatedNeurons: 1, capacity: { cloud: 'FREE_AVAILABLE', desktop: 'OFFLINE' }, now });
  assert.equal(d.status, 'HOLD');

  const missingUsage: InferenceBackend = { run: async () => ({ text: 'x', model: 'cloud' }) };
  const e = await new VOneInferenceFailoverExecutor(new BudgetedInferenceRouter(new NeuronBudgetManager(10_000,500,now)), missingUsage, local).execute({ prompt: 'x', estimatedNeurons: 1, capacity: { cloud: 'FREE_AVAILABLE', desktop: 'ONLINE' }, now });
  assert.equal(e.status, 'HOLD'); assert.equal(e.reason, 'cloud_usage_missing_fail_closed');
  assert.match(a.evidenceSha256, /^[a-f0-9]{64}$/);

  const quotaBudget = new NeuronBudgetManager(10_000, 500, now);
  const quotaCloud: InferenceBackend = { run: async () => {
    throw new CloudInferenceBlockedError('CLOUD_FREE_EXHAUSTED', 'free quota exhausted');
  }};
  const quotaExec = new VOneInferenceFailoverExecutor(new BudgetedInferenceRouter(quotaBudget), quotaCloud, local);
  const f = await quotaExec.execute({ prompt: 'x', estimatedNeurons: 1, capacity: { cloud: 'FREE_AVAILABLE', desktop: 'ONLINE' }, now });
  assert.equal(f.target, 'DESKTOP_LOCAL');
  assert.equal(quotaBudget.snapshot(now).state, 'FREE_EXHAUSTED');
  console.log('vone_inference_failover_executor: all assertions passed');
}
main().catch((error) => { console.error(error); process.exit(1); });
