export type CloudInferenceBlockCode =
  | 'CLOUD_FREE_EXHAUSTED'
  | 'CLOUD_CAPACITY_BUSY'
  | 'CLOUD_MODEL_REQUIRES_PAID'
  | 'CLOUD_AUTH_OR_POLICY_BLOCKED'
  | 'CLOUD_INFERENCE_FAILED';

export class CloudInferenceBlockedError extends Error {
  constructor(public readonly code: CloudInferenceBlockCode, message: string) {
    super(message);
    this.name = 'CloudInferenceBlockedError';
  }
}

export function classifyCloudflareFailure(status: number, body: string): CloudInferenceBlockedError {
  const normalized = body.toLowerCase();
  if (status === 429 && (normalized.includes('3036') || normalized.includes('daily free allocation'))) {
    return new CloudInferenceBlockedError('CLOUD_FREE_EXHAUSTED', 'Workers AI free allocation exhausted');
  }
  if (status === 429 && (normalized.includes('3040') || normalized.includes('capacity'))) {
    return new CloudInferenceBlockedError('CLOUD_CAPACITY_BUSY', 'Workers AI capacity unavailable');
  }
  if (status === 403 && (normalized.includes('5035') || normalized.includes('paid plan'))) {
    return new CloudInferenceBlockedError('CLOUD_MODEL_REQUIRES_PAID', 'Workers AI model requires paid plan');
  }
  if (status === 401 || status === 403) {
    return new CloudInferenceBlockedError('CLOUD_AUTH_OR_POLICY_BLOCKED', 'Workers AI authorization/policy blocked');
  }
  return new CloudInferenceBlockedError('CLOUD_INFERENCE_FAILED', 'Workers AI inference failed');
}

export type InferenceCapacity = {
  cloud: 'FREE_AVAILABLE' | 'FREE_EXHAUSTED' | 'BUSY' | 'OFFLINE' | 'PAID_BLOCKED';
  desktop: 'ONLINE' | 'OFFLINE' | 'BUSY';
};

export type CapacityDecision = {
  target: 'CLOUD_FREE' | 'DESKTOP_LOCAL' | 'HOLD';
  reason: string;
};

export function selectInferenceCapacity(capacity: InferenceCapacity): CapacityDecision {
  // Always-on cloud is preferred only while it is verified free and available.
  if (capacity.cloud === 'FREE_AVAILABLE') return { target: 'CLOUD_FREE', reason: 'verified_free_cloud_available' };
  if (capacity.desktop === 'ONLINE') return { target: 'DESKTOP_LOCAL', reason: 'cloud_unavailable_local_worker_online' };
  return { target: 'HOLD', reason: 'no_verified_free_capacity' };
}
