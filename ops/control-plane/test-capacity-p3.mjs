import assert from 'node:assert/strict';
import { ZERO_COST_POLICY, rankCapacityRoutes } from './src/capacity-broker.mjs';

const now=Date.now(), observed=new Date(now).toISOString();
const browser={
  schema_version:'1.0',route_id:'browser-session',kind:'client',provider:'test',state:'FREE_AVAILABLE',
  cost:{billing_mode:'free',variable_cost_allowed:false,verified_zero_cost:true},
  quota:{remaining_pct:100,reserve_threshold_pct:10,confidence:'verified'},
  capabilities:{task_classes:['PARSE'],models:[],modalities:['text'],accelerators:['js']},
  health:{observed_at:observed,ttl_seconds:60,latency_ms_p95:20,success_rate_15m:1,queue_depth:0},
  security:{trust_zone:'client_private',allowed_privacy_classes:['PUBLIC','PRIVATE']},
  constraints:{max_concurrency:1,requires_user_session:true},
  telemetry:{device_pressure:'normal'}
};
const desktop=structuredClone(browser);
desktop.route_id='desktop';
desktop.kind='desktop';
desktop.constraints.requires_user_session=false;
desktop.health.latency_ms_p95=30;

const noSession=rankCapacityRoutes([browser,desktop],{task_class:'PARSE',privacy_class:'PRIVATE',prefer_local:true,user_session:false},ZERO_COST_POLICY,now);
assert.equal(noSession.selected.route_id,'desktop');
assert.ok(noSession.blocked.some(x=>x.route_id==='browser-session'&&x.reasons.includes('USER_SESSION_REQUIRED')));

const withSession=rankCapacityRoutes([browser,desktop],{task_class:'PARSE',privacy_class:'PRIVATE',prefer_local:true,user_session:true},ZERO_COST_POLICY,now);
assert.equal(withSession.selected.route_id,'browser-session');

console.log('P3_SESSION_GATE=PASS');
console.log('P3_BROWSER_ELIGIBLE_WITH_SESSION=PASS');
