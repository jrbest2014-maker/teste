import assert from 'node:assert/strict';
import { ZERO_COST_POLICY, rankCapacityRoutes } from './src/capacity-broker.mjs';

const now=Date.now(), observed=new Date(now).toISOString();
function mk(id,kind,p95,billing='free',verified=true,quota=80){
  return {
    schema_version:'1.0',route_id:id,kind,provider:'mesh-test',state:'FREE_AVAILABLE',
    cost:{billing_mode:billing,variable_cost_allowed:false,verified_zero_cost:verified},
    quota:{remaining_pct:quota,reserve_threshold_pct:15,confidence:'verified'},
    capabilities:{task_classes:['LLM_FAST'],models:[id+'-model'],modalities:['text'],accelerators:['gpu']},
    health:{observed_at:observed,ttl_seconds:60,latency_ms_p95:p95,success_rate_15m:.99,queue_depth:0},
    security:{trust_zone:kind==='community'?'community':'approved_cloud',allowed_privacy_classes:['PUBLIC']},
    constraints:{max_concurrency:1,requires_user_session:false},
    telemetry:{device_pressure:'normal'}
  };
}
const primary=mk('cloud-primary','cloud',100);
const backup=mk('community-backup','community',600);
const paid=mk('paid-perfect','cloud',1,'paid',false,100);

const before=rankCapacityRoutes([backup,paid,primary],{task_class:'LLM_FAST',privacy_class:'PUBLIC'},ZERO_COST_POLICY,now);
assert.equal(before.selected.route_id,'cloud-primary');

primary.quota.remaining_pct=0;
const after=rankCapacityRoutes([backup,paid,primary],{task_class:'LLM_FAST',privacy_class:'PUBLIC'},ZERO_COST_POLICY,now);
assert.equal(after.selected.route_id,'community-backup');
assert.ok(after.blocked.some(x=>x.route_id==='cloud-primary'&&x.state==='FREE_EXHAUSTED'));
assert.ok(after.blocked.some(x=>x.route_id==='paid-perfect'&&x.state==='PAID_BLOCKED'));

console.log('P4_MESH_PRIMARY=PASS');
console.log('P4_EXHAUSTION_REROUTE=PASS');
console.log('P4_PAID_STILL_BLOCKED=PASS');
