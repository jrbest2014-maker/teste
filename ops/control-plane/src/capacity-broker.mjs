export const CAPACITY_STATES = Object.freeze([
  'FREE_AVAILABLE',
  'FREE_QUEUE',
  'FREE_QUOTA_LOW',
  'FREE_EXHAUSTED',
  'PAID_BLOCKED',
  'OFFLINE'
]);

export const ELIGIBLE_STATES = new Set(['FREE_AVAILABLE','FREE_QUEUE','FREE_QUOTA_LOW']);

export const ZERO_COST_POLICY = Object.freeze({
  id: 'VONE_ZERO_COST_DEFAULT',
  max_variable_cost_usd: 0,
  allow_paid_routes: false,
  unknown_cost_behavior: 'BLOCK',
  no_eligible_route_behavior: 'HOLD',
  quota_reserve_pct: 15,
  require_verified_zero_cost: true,
  require_route_audit: true
});

const ALLOWED_BILLING = new Set(['free','grant','included']);

function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function normalizeCapacityRoute(input = {}) {
  const route = {
    schema_version: '1.0',
    route_id: String(input.route_id || '').slice(0, 128),
    kind: String(input.kind || 'cloud').slice(0, 64),
    provider: String(input.provider || 'unknown').slice(0, 128),
    state: CAPACITY_STATES.includes(input.state) ? input.state : 'OFFLINE',
    cost: {
      billing_mode: String(input.cost?.billing_mode || 'unknown'),
      variable_cost_allowed: Boolean(input.cost?.variable_cost_allowed),
      verified_zero_cost: input.cost?.verified_zero_cost === true,
      verification_source: String(input.cost?.verification_source || '').slice(0, 256),
      verified_at: input.cost?.verified_at || null
    },
    quota: {
      remaining_pct: finiteNumber(input.quota?.remaining_pct) ? Math.max(0, Math.min(100, input.quota.remaining_pct)) : null,
      reserve_threshold_pct: finiteNumber(input.quota?.reserve_threshold_pct)
        ? Math.max(0, Math.min(100, input.quota.reserve_threshold_pct))
        : ZERO_COST_POLICY.quota_reserve_pct,
      reset_at: input.quota?.reset_at || null,
      confidence: ['verified','inferred','unknown'].includes(input.quota?.confidence)
        ? input.quota.confidence : 'unknown'
    },
    capabilities: {
      task_classes: Array.isArray(input.capabilities?.task_classes)
        ? [...new Set(input.capabilities.task_classes.map(String))].slice(0, 64) : [],
      models: Array.isArray(input.capabilities?.models)
        ? [...new Set(input.capabilities.models.map(String))].slice(0, 64) : [],
      modalities: Array.isArray(input.capabilities?.modalities)
        ? [...new Set(input.capabilities.modalities.map(String))].slice(0, 16) : [],
      accelerators: Array.isArray(input.capabilities?.accelerators)
        ? [...new Set(input.capabilities.accelerators.map(String))].slice(0, 32) : [],
      max_context_tokens: finiteNumber(input.capabilities?.max_context_tokens) ? Math.max(1, input.capabilities.max_context_tokens) : null,
      max_input_mb: finiteNumber(input.capabilities?.max_input_mb) ? Math.max(0, input.capabilities.max_input_mb) : null
    },
    health: {
      observed_at: input.health?.observed_at ?? null,
      ttl_seconds: finiteNumber(input.health?.ttl_seconds) ? Math.max(1, Math.floor(input.health.ttl_seconds)) : 60,
      latency_ms_p50: finiteNumber(input.health?.latency_ms_p50) ? Math.max(0, input.health.latency_ms_p50) : null,
      latency_ms_p95: finiteNumber(input.health?.latency_ms_p95) ? Math.max(0, input.health.latency_ms_p95) : null,
      success_rate_15m: finiteNumber(input.health?.success_rate_15m) ? Math.max(0, Math.min(1, input.health.success_rate_15m)) : null,
      queue_depth: finiteNumber(input.health?.queue_depth) ? Math.max(0, Math.floor(input.health.queue_depth)) : null
    },
    security: {
      trust_zone: String(input.security?.trust_zone || 'community'),
      allowed_privacy_classes: Array.isArray(input.security?.allowed_privacy_classes)
        ? [...new Set(input.security.allowed_privacy_classes.map(String))].slice(0, 8) : ['PUBLIC']
    },
    constraints: {
      regions: Array.isArray(input.constraints?.regions)
        ? [...new Set(input.constraints.regions.map(String))].slice(0, 32) : [],
      max_concurrency: finiteNumber(input.constraints?.max_concurrency)
        ? Math.max(1, Math.floor(input.constraints.max_concurrency)) : null,
      requires_user_session: Boolean(input.constraints?.requires_user_session)
    },
    telemetry: input.telemetry && typeof input.telemetry === 'object' ? input.telemetry : {}
  };
  if (!route.route_id) throw new Error('route_id required');
  return route;
}

export function deriveCapacityState(routeInput, nowMs = Date.now()) {
  const route = normalizeCapacityRoute(routeInput);
  const cost = route.cost;
  if (
    cost.variable_cost_allowed ||
    !cost.verified_zero_cost ||
    !ALLOWED_BILLING.has(cost.billing_mode)
  ) return 'PAID_BLOCKED';

  const observedMs = Date.parse(route.health.observed_at);
  if (!Number.isFinite(observedMs) || observedMs > nowMs || nowMs - observedMs > route.health.ttl_seconds * 1000) {
    return 'OFFLINE';
  }

  if (route.quota.confidence !== 'verified') return 'PAID_BLOCKED';

  if (route.quota.remaining_pct !== null) {
    if (route.quota.remaining_pct <= 0) return 'FREE_EXHAUSTED';
    if (route.quota.remaining_pct <= route.quota.reserve_threshold_pct) return 'FREE_QUOTA_LOW';
  }

  if ((route.health.queue_depth || 0) > 0) return 'FREE_QUEUE';
  return 'FREE_AVAILABLE';
}

export function gateCapacityRoute(routeInput, task = {}, policy = ZERO_COST_POLICY, nowMs = Date.now()) {
  const route = normalizeCapacityRoute(routeInput);
  const state = deriveCapacityState(route, nowMs);
  const reasons = [];

  if (!ELIGIBLE_STATES.has(state)) reasons.push('STATE_'+state);
  if (route.cost.variable_cost_allowed) reasons.push('VARIABLE_COST_NOT_ALLOWED');
  if (policy.require_verified_zero_cost && !route.cost.verified_zero_cost) reasons.push('ZERO_COST_NOT_VERIFIED');
  if (!ALLOWED_BILLING.has(route.cost.billing_mode)) reasons.push('BILLING_MODE_BLOCKED');

  const taskClass = String(task.task_class || '');
  if (taskClass && !route.capabilities.task_classes.includes(taskClass)) reasons.push('CAPABILITY_MISMATCH');

  const privacy = String(task.privacy_class || 'PUBLIC');
  if (!route.security.allowed_privacy_classes.includes(privacy)) reasons.push('PRIVACY_MISMATCH');

  if (route.constraints.requires_user_session && task.user_session !== true) {
    reasons.push('USER_SESSION_REQUIRED');
  }

  const eligible = reasons.length === 0;
  return { eligible, state, reasons, route };
}

export function planCapacity(routes = [], task = {}, policy = ZERO_COST_POLICY, nowMs = Date.now()) {
  const decisions = routes.map(route => {
    try {
      const gate = gateCapacityRoute(route, task, policy, nowMs);
      return {
        route_id: gate.route.route_id,
        state: gate.state,
        eligible: gate.eligible,
        reasons: gate.reasons
      };
    } catch (e) {
      return { route_id: String(route?.route_id || ''), state: 'OFFLINE', eligible: false, reasons: ['INVALID_ROUTE', String(e?.message || e)] };
    }
  });
  const eligible = decisions.filter(x => x.eligible);
  return {
    policy_id: policy.id,
    task,
    eligible,
    blocked: decisions.filter(x => !x.eligible),
    outcome: eligible.length ? 'ELIGIBLE_FREE_CAPACITY' : policy.no_eligible_route_behavior
  };
}

export function routeToDb(routeInput, nowMs = Date.now()) {
  const route = normalizeCapacityRoute(routeInput);
  route.state = deriveCapacityState(route, nowMs);
  const observedMs = Date.parse(route.health.observed_at);
  return {
    route,
    row: [
      route.route_id,
      route.kind,
      route.provider,
      route.state,
      JSON.stringify(route.cost),
      JSON.stringify(route.quota),
      JSON.stringify(route.capabilities),
      JSON.stringify(route.health),
      JSON.stringify(route.security),
      JSON.stringify(route.constraints),
      JSON.stringify(route.telemetry),
      nowMs,
      Number.isFinite(observedMs) ? observedMs : 0
    ]
  };
}

export function dbRowToRoute(row = {}, nowMs = Date.now()) {
  const parse = v => { try { return v ? JSON.parse(v) : {}; } catch { return {}; } };
  const route = normalizeCapacityRoute({
    route_id: row.route_id,
    kind: row.kind,
    provider: row.provider,
    state: row.state,
    cost: parse(row.cost_json),
    quota: parse(row.quota_json),
    capabilities: parse(row.capabilities_json),
    health: parse(row.health_json),
    security: parse(row.security_json),
    constraints: parse(row.constraints_json),
    telemetry: parse(row.telemetry_json)
  });
  route.state = deriveCapacityState(route, nowMs);
  return route;
}


export function scoreCapacityRoute(routeInput, task = {}, policy = ZERO_COST_POLICY, nowMs = Date.now()) {
  const gate = gateCapacityRoute(routeInput, task, policy, nowMs);
  if (!gate.eligible) {
    return {
      route_id: gate.route.route_id,
      state: gate.state,
      eligible: false,
      score: null,
      reasons: gate.reasons,
      breakdown: null,
      route: gate.route
    };
  }

  const route = gate.route;
  const p95 = route.health.latency_ms_p95;
  const latency = p95 === null ? 8 : p95 <= 1000 ? 20 : p95 <= 3000 ? 16 : p95 <= 8000 ? 10 : 4;

  const sr = route.health.success_rate_15m;
  const reliability = sr === null ? 8 : Math.round(sr * 15 * 100) / 100;

  let quota = 12;
  if (route.quota.remaining_pct !== null) {
    const q = route.quota.remaining_pct;
    quota = q >= 75 ? 15 : q >= 40 ? 12 : q > route.quota.reserve_threshold_pct ? 8 : 3;
  }

  const trustMap = { client_private: 10, private_worker: 9, approved_cloud: 7, community: 3 };
  const trust = trustMap[route.security.trust_zone] ?? 2;

  const localKind = ['client','desktop','notebook'].includes(route.kind);
  const wantsLocal = task.prefer_local === true || task.locality === 'client';
  const locality = wantsLocal ? (localKind ? 5 : 1) : 3;

  const pressure = String(route.telemetry?.device_pressure || 'unknown').toLowerCase();
  const resource = pressure === 'normal' ? 5 : pressure === 'elevated' ? 2 : pressure === 'high' ? 0 : 3;

  const capability = 30;
  const statePenalty = gate.state === 'FREE_QUEUE' ? 8 : gate.state === 'FREE_QUOTA_LOW' ? 5 : 0;
  const score = Math.max(0, Math.round((capability + latency + reliability + quota + trust + locality + resource - statePenalty) * 100) / 100);

  return {
    route_id: route.route_id,
    state: gate.state,
    eligible: true,
    score,
    reasons: [],
    breakdown: { capability, latency, reliability, quota, trust, locality, resource, state_penalty: statePenalty },
    route
  };
}

export function rankCapacityRoutes(routes = [], task = {}, policy = ZERO_COST_POLICY, nowMs = Date.now()) {
  const scored = routes.map(route => {
    try {
      return scoreCapacityRoute(route, task, policy, nowMs);
    } catch (e) {
      return {
        route_id: String(route?.route_id || ''),
        state: 'OFFLINE',
        eligible: false,
        score: null,
        reasons: ['INVALID_ROUTE', String(e?.message || e)],
        breakdown: null,
        route: null
      };
    }
  });

  const eligible = scored.filter(x => x.eligible).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const a95 = a.route?.health?.latency_ms_p95 ?? Number.MAX_SAFE_INTEGER;
    const b95 = b.route?.health?.latency_ms_p95 ?? Number.MAX_SAFE_INTEGER;
    if (a95 !== b95) return a95 - b95;
    return a.route_id.localeCompare(b.route_id);
  });

  return {
    policy_id: policy.id,
    task,
    ranked: eligible,
    blocked: scored.filter(x => !x.eligible),
    selected: eligible[0] || null,
    outcome: eligible.length ? 'ROUTE_SELECTED' : policy.no_eligible_route_behavior
  };
}

export function planParallelVerification(routes = [], task = {}, options = {}, policy = ZERO_COST_POLICY, nowMs = Date.now()) {
  const ranked = rankCapacityRoutes(routes, task, policy, nowMs);
  const requested = Math.max(2, Math.min(Number(options.copies || 2), 4));
  const readOnly = task.side_effects !== true;
  if (!readOnly) {
    return { outcome: 'SINGLE_AUTHORITATIVE_ROUTE', reason: 'SIDE_EFFECTS_REQUIRE_SINGLE_LEASE', routes: ranked.selected ? [ranked.selected] : [] };
  }
  const selected = [];
  const providers = new Set();
  for (const candidate of ranked.ranked) {
    if (selected.length >= requested) break;
    const provider = candidate.route?.provider || candidate.route_id;
    if (providers.has(provider) && ranked.ranked.length > requested) continue;
    selected.push(candidate);
    providers.add(provider);
  }
  if (selected.length < 2) {
    return { outcome: ranked.outcome === 'HOLD' ? 'HOLD' : 'SINGLE_ROUTE_ONLY', reason: 'INSUFFICIENT_FREE_DIVERSITY', routes: selected };
  }
  return { outcome: 'PARALLEL_VERIFY', reason: 'READ_ONLY_FREE_CAPACITY', routes: selected };
}

export function resolveVerificationEvidence(evidence = []) {
  const valid = evidence.filter(x => x && typeof x === 'object' && x.route_id && ['PASS','FAIL','HOLD'].includes(x.verdict));
  if (!valid.length) return { outcome: 'HOLD', reason: 'NO_VALID_EVIDENCE', consensus: null, evidence: [] };
  const pass = valid.filter(x => x.verdict === 'PASS');
  const fail = valid.filter(x => x.verdict === 'FAIL');
  const hold = valid.filter(x => x.verdict === 'HOLD');
  const fingerprints = new Set(valid.map(x => String(x.fingerprint || '')).filter(Boolean));
  if (pass.length && fail.length) {
    return { outcome: 'HOLD', reason: 'CONFLICTING_VERDICTS', consensus: null, evidence: valid };
  }
  if (fingerprints.size > 1 && valid.length > 1) {
    return { outcome: 'HOLD', reason: 'OUTPUT_DIVERGENCE', consensus: null, evidence: valid };
  }
  if (fail.length) return { outcome: 'FAIL', reason: 'VERIFIED_FAILURE', consensus: 'FAIL', evidence: valid };
  if (pass.length >= 2) return { outcome: 'PASS', reason: 'CROSS_VERIFIED', consensus: 'PASS', evidence: valid };
  if (hold.length) return { outcome: 'HOLD', reason: 'VERIFIER_HOLD', consensus: null, evidence: valid };
  return { outcome: 'HOLD', reason: 'INSUFFICIENT_INDEPENDENT_EVIDENCE', consensus: null, evidence: valid };
}


export function canonicalizeVerificationValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalizeVerificationValue);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalizeVerificationValue(value[key]);
  }
  return out;
}

export function canonicalVerificationJson(value) {
  return JSON.stringify(canonicalizeVerificationValue(value));
}

export function evaluateVerificationHashes(members = [], expectedResults = 2) {
  const expected = Math.max(2, Math.min(Number(expectedResults || 2), 8));
  const terminal = members.filter(x => x && (x.status === 'COMPLETED' || x.status === 'FAILED'));
  const completed = terminal.filter(x => x.status === 'COMPLETED' && typeof x.result_hash === 'string' && x.result_hash.length > 0);
  const failed = terminal.filter(x => x.status === 'FAILED');

  if (terminal.length < expected) {
    return {
      status: 'WAITING',
      expected_results: expected,
      terminal_results: terminal.length,
      completed_results: completed.length,
      failed_results: failed.length,
      consensus_hash: null,
      reason: 'AWAITING_RESULTS'
    };
  }

  if (failed.length > 0 || completed.length < expected) {
    return {
      status: 'HOLD_VALIDATION_REQUIRED',
      expected_results: expected,
      terminal_results: terminal.length,
      completed_results: completed.length,
      failed_results: failed.length,
      consensus_hash: null,
      reason: failed.length ? 'MEMBER_FAILURE' : 'INSUFFICIENT_COMPLETED_RESULTS'
    };
  }

  const hashes = completed.slice(0, expected).map(x => x.result_hash);
  const unique = [...new Set(hashes)];
  if (unique.length === 1) {
    return {
      status: 'CONSENSUS',
      expected_results: expected,
      terminal_results: expected,
      completed_results: expected,
      failed_results: 0,
      consensus_hash: unique[0],
      reason: 'ALL_RESULTS_MATCH'
    };
  }

  return {
    status: 'HOLD_VALIDATION_REQUIRED',
    expected_results: expected,
    terminal_results: expected,
    completed_results: expected,
    failed_results: 0,
    consensus_hash: null,
    reason: 'RESULT_DIVERGENCE',
    distinct_hashes: unique.length
  };
}
