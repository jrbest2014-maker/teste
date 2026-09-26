import * as assert from 'node:assert';
import { BudgetedInferenceRouter } from './vone_budgeted_inference_router';
import { NeuronBudgetManager } from './vone_neuron_budget';

const now = new Date('2026-09-26T12:00:00Z');
const budget = new NeuronBudgetManager(10_000, 500, now);
const router = new BudgetedInferenceRouter(budget);

assert.equal(router.select({ cloud: 'FREE_AVAILABLE', desktop: 'ONLINE' }, 100, now).target, 'CLOUD_FREE');
router.recordCloudUsage(9_450, now);
const local = router.select({ cloud: 'FREE_AVAILABLE', desktop: 'ONLINE' }, 100, now);
assert.equal(local.target, 'DESKTOP_LOCAL');
assert.equal(local.reason, 'cloud_budget_insufficient_local_worker_online');
const hold = router.select({ cloud: 'FREE_AVAILABLE', desktop: 'OFFLINE' }, 100, now);
assert.equal(hold.target, 'HOLD');
assert.equal(hold.reason, 'cloud_budget_insufficient_no_local_capacity');
const busyCloud = new BudgetedInferenceRouter(new NeuronBudgetManager(10_000, 500, now));
assert.equal(busyCloud.select({ cloud: 'BUSY', desktop: 'ONLINE' }, 10, now).target, 'DESKTOP_LOCAL');
assert.equal(busyCloud.select({ cloud: 'BUSY', desktop: 'OFFLINE' }, 10, now).target, 'HOLD');
assert.equal(busyCloud.select({ cloud: 'PAID_BLOCKED', desktop: 'ONLINE' }, 10, now).target, 'DESKTOP_LOCAL');
busyCloud.markCloudFreeExhausted(now);
assert.equal(busyCloud.select({ cloud: 'FREE_AVAILABLE', desktop: 'ONLINE' }, 1, now).target, 'DESKTOP_LOCAL');
const tomorrow = new Date('2026-09-27T00:00:01Z');
assert.equal(busyCloud.select({ cloud: 'FREE_AVAILABLE', desktop: 'OFFLINE' }, 10, tomorrow).target, 'CLOUD_FREE');
console.log('vone_budgeted_inference_router: all assertions passed');
