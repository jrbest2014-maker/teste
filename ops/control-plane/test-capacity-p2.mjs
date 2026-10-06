import assert from 'node:assert/strict';
import { ZERO_COST_POLICY, deriveCapacityState, rankCapacityRoutes } from './src/capacity-broker.mjs';

const now=Date.now(), observed=new Date(now).toISOString();
function route(id,{billing='free',verified=true,p95=1000,success=.99,quota=80,trust='approved_cloud',kind='cloud',pressure='unknown'}={}){
  return {
    schema_version:'1.0',route_id:id,kind,provider:'test',state:'FREE_AVAILABLE',
    cost:{billing_mode:billing,variable_cost_allowed:false,verified_zero_cost:verified},
    quota:{remaining_pct:quota,reserve_threshold_pct:15,confidence:'verified'},
    capabilities:{task_classes:['LLM_FAST'],models:[id+'-model'],modalities:['text'],accelerators:['gpu']},
    health:{observed_at:observed,ttl_seconds:60,latency_ms_p95:p95,success_rate_15m:success,queue_depth:0},
    security:{trust_zone:trust,allowed_privacy_classes:['PUBLIC','INTERNAL']},
    constraints:{max_concurrency:2,requires_user_session:false},
    telemetry:{device_pressure:pressure}
  };
}

const freeFast=route('free-fast',{p95:700,success:.995,quota:90});
const freeSlow=route('free-slow',{p95:5000,success:.95,quota:70});
const paidPerfect=route('paid-perfect',{billing:'paid',verified:false,p95:50,success:1,quota:100});

const ranked=rankCapacityRoutes([freeSlow,paidPerfect,freeFast],{task_class:'LLM_FAST',privacy_class:'PUBLIC'},ZERO_COST_POLICY,now);
assert.equal(ranked.outcome,'ROUTE_SELECTED');
assert.equal(ranked.selected.route_id,'free-fast');
assert.ok(ranked.blocked.some(x=>x.route_id==='paid-perfect'&&x.state==='PAID_BLOCKED'));
assert.ok(!ranked.ranked.some(x=>x.route_id==='paid-perfect'));

const local=route('client-local',{p95:1400,success:.98,quota:100,trust:'client_private',kind:'client',pressure:'normal'});
const localRank=rankCapacityRoutes([freeFast,local],{task_class:'LLM_FAST',privacy_class:'PUBLIC',prefer_local:true},ZERO_COST_POLICY,now);
assert.equal(localRank.selected.route_id,'client-local');

const unknownQuota=route('unknown-quota');
unknownQuota.quota.confidence='unknown';
assert.equal(deriveCapacityState(unknownQuota,now),'PAID_BLOCKED');

console.log('P2_RANKING=PASS');
console.log('PAID_ROUTE_CANNOT_WIN=PASS');
console.log('LOCALITY_PREFERENCE=PASS');
console.log('UNKNOWN_QUOTA_FAIL_CLOSED=PASS');
