import assert from 'node:assert/strict';
import {
  normalizeCapacityRoute, deriveCapacityState, dbRowToRoute, routeToDb,
  rankCapacityRoutes, ZERO_COST_POLICY
} from './src/capacity-broker.mjs';

const now = Date.now();
const base = {
  route_id: 'verified-free-worker', kind: 'desktop', provider: 'owned-test',
  state: 'FREE_AVAILABLE',
  cost: { billing_mode: 'included', variable_cost_allowed: false, verified_zero_cost: true },
  quota: { remaining_pct: 80, confidence: 'verified' },
  capabilities: { task_classes: ['LLM_FAST'] },
  health: { observed_at: new Date(now).toISOString(), ttl_seconds: 60, queue_depth: 0 },
  security: { trust_zone: 'private_worker', allowed_privacy_classes: ['PRIVATE'] },
  constraints: { requires_user_session: false }
};
const task = { task_class: 'LLM_FAST', privacy_class: 'PRIVATE' };
function withObservation(value) {
  return { ...structuredClone(base), health: { ...base.health, observed_at: value } };
}

// A registration claim cannot substitute for observed worker health.
for (const missing of [undefined, null, '']) {
  const route = withObservation(missing);
  if (missing === undefined) delete route.health.observed_at;
  assert.equal(deriveCapacityState(route, now), 'OFFLINE');
  assert.equal(deriveCapacityState(normalizeCapacityRoute(route), now), 'OFFLINE');
  const plan = rankCapacityRoutes([route], task, ZERO_COST_POLICY, now);
  assert.equal(plan.outcome, 'HOLD');
  assert.equal(plan.selected, null);
  assert.equal(routeToDb(route, now).row.at(-1), 0);
}
assert.equal(normalizeCapacityRoute(withObservation(undefined)).health.observed_at, null);
assert.equal(deriveCapacityState({ ...base, health: {} }, now), 'OFFLINE');

for (const observation of ['invalid-date', new Date(now + 1).toISOString(), new Date(now + 86_400_000).toISOString()]) {
  const route = withObservation(observation);
  assert.equal(deriveCapacityState(route, now), 'OFFLINE');
  assert.equal(rankCapacityRoutes([route], task, ZERO_COST_POLICY, now).outcome, 'HOLD');
}
assert.equal(routeToDb(withObservation('invalid-date'), now).row.at(-1), 0);

// Valid heartbeats retain the existing availability and TTL boundary.
assert.equal(deriveCapacityState(base, now), 'FREE_AVAILABLE');
assert.equal(rankCapacityRoutes([base], task, ZERO_COST_POLICY, now).selected.route_id, base.route_id);
assert.equal(deriveCapacityState(withObservation(new Date(now - 60_000).toISOString()), now), 'FREE_AVAILABLE');
assert.equal(deriveCapacityState(withObservation(new Date(now - 60_001).toISOString()), now), 'OFFLINE');
assert.equal(routeToDb(base, now).row.at(-1), now);
assert.equal(routeToDb(withObservation('1970-01-01T00:00:00.000Z'), now).row.at(-1), 0);

// Database reconstruction must not manufacture a heartbeat from missing JSON.
const db = routeToDb(base, now).route;
const row = {
  ...db, cost_json: JSON.stringify(db.cost), quota_json: JSON.stringify(db.quota),
  capabilities_json: JSON.stringify(db.capabilities), security_json: JSON.stringify(db.security),
  constraints_json: JSON.stringify(db.constraints), health_json: '{}'
};
assert.equal(dbRowToRoute(row, now).state, 'OFFLINE');
assert.equal(rankCapacityRoutes([dbRowToRoute(row, now)], task, ZERO_COST_POLICY, now).outcome, 'HOLD');

console.log('HEARTBEAT_EVIDENCE_CONTRACT=PASS');
