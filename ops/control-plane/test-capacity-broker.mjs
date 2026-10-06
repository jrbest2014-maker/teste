import assert from 'node:assert/strict';
import { ZERO_COST_POLICY, deriveCapacityState, gateCapacityRoute, planCapacity } from './src/capacity-broker.mjs';

const now = Date.now();
const iso = new Date(now).toISOString();
const base = {
  schema_version:'1.0', route_id:'free-good', kind:'cloud', provider:'test', state:'FREE_AVAILABLE',
  cost:{billing_mode:'free',variable_cost_allowed:false,verified_zero_cost:true},
  quota:{remaining_pct:80,reserve_threshold_pct:15,confidence:'verified'},
  capabilities:{task_classes:['LLM_FAST'],models:['test-model'],modalities:['text'],accelerators:['gpu']},
  health:{observed_at:iso,ttl_seconds:60,queue_depth:0},
  security:{trust_zone:'approved_cloud',allowed_privacy_classes:['PUBLIC','INTERNAL']},
  constraints:{requires_user_session:false}, telemetry:{}
};

assert.equal(deriveCapacityState(base, now), 'FREE_AVAILABLE');

const paid = structuredClone(base);
paid.route_id='paid';
paid.cost={billing_mode:'paid',variable_cost_allowed:false,verified_zero_cost:false};
assert.equal(deriveCapacityState(paid, now), 'PAID_BLOCKED');
assert.equal(gateCapacityRoute(paid,{task_class:'LLM_FAST',privacy_class:'PUBLIC'},ZERO_COST_POLICY,now).eligible,false);

const unknown=structuredClone(base);
unknown.route_id='unknown';
unknown.cost={billing_mode:'unknown',variable_cost_allowed:false,verified_zero_cost:false};
assert.equal(deriveCapacityState(unknown, now),'PAID_BLOCKED');

const exhausted=structuredClone(base);
exhausted.route_id='exhausted';
exhausted.quota.remaining_pct=0;
assert.equal(deriveCapacityState(exhausted, now),'FREE_EXHAUSTED');

const low=structuredClone(base);
low.route_id='low';
low.quota.remaining_pct=10;
assert.equal(deriveCapacityState(low, now),'FREE_QUOTA_LOW');

const queued=structuredClone(base);
queued.route_id='queued';
queued.health.queue_depth=3;
assert.equal(deriveCapacityState(queued, now),'FREE_QUEUE');

const stale=structuredClone(base);
stale.route_id='stale';
stale.health.observed_at=new Date(now-120000).toISOString();
assert.equal(deriveCapacityState(stale, now),'OFFLINE');

const privacy=gateCapacityRoute(base,{task_class:'LLM_FAST',privacy_class:'PRIVATE'},ZERO_COST_POLICY,now);
assert.equal(privacy.eligible,false);
assert.ok(privacy.reasons.includes('PRIVACY_MISMATCH'));

const plan=planCapacity([paid,exhausted,stale,base],{task_class:'LLM_FAST',privacy_class:'PUBLIC'},ZERO_COST_POLICY,now);
assert.equal(plan.outcome,'ELIGIBLE_FREE_CAPACITY');
assert.deepEqual(plan.eligible.map(x=>x.route_id),['free-good']);
assert.ok(!plan.eligible.some(x=>x.route_id==='paid'));

const hold=planCapacity([paid,exhausted,stale],{task_class:'LLM_FAST',privacy_class:'PUBLIC'},ZERO_COST_POLICY,now);
assert.equal(hold.outcome,'HOLD');
assert.equal(hold.eligible.length,0);

console.log('P0_CONTRACT=PASS');
console.log('PAID_BLOCKED_NEVER_ELIGIBLE=PASS');
console.log('HOLD_WHEN_NO_FREE_ROUTE=PASS');
