import assert from 'node:assert/strict';
import { classifyCloudflareFailure, selectInferenceCapacity } from './vone_cloud_inference_policy';

assert.equal(selectInferenceCapacity({cloud:'FREE_AVAILABLE',desktop:'ONLINE'}).target,'CLOUD_FREE');
assert.equal(selectInferenceCapacity({cloud:'FREE_EXHAUSTED',desktop:'ONLINE'}).target,'DESKTOP_LOCAL');
assert.equal(selectInferenceCapacity({cloud:'BUSY',desktop:'ONLINE'}).target,'DESKTOP_LOCAL');
assert.equal(selectInferenceCapacity({cloud:'PAID_BLOCKED',desktop:'OFFLINE'}).target,'HOLD');
assert.equal(selectInferenceCapacity({cloud:'OFFLINE',desktop:'OFFLINE'}).target,'HOLD');

assert.equal(classifyCloudflareFailure(429,'{"errors":[{"code":3036,"message":"daily free allocation"}]}').code,'CLOUD_FREE_EXHAUSTED');
assert.equal(classifyCloudflareFailure(429,'{"errors":[{"code":3040,"message":"Capacity temporarily exceeded"}]}').code,'CLOUD_CAPACITY_BUSY');
assert.equal(classifyCloudflareFailure(403,'{"errors":[{"code":5035,"message":"requires Workers Paid plan"}]}').code,'CLOUD_MODEL_REQUIRES_PAID');
assert.equal(classifyCloudflareFailure(403,'forbidden').code,'CLOUD_AUTH_OR_POLICY_BLOCKED');
assert.equal(classifyCloudflareFailure(500,'internal').code,'CLOUD_INFERENCE_FAILED');

console.log('vone_cloud_inference_policy: all assertions passed');
