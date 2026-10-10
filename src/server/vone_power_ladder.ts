export type PowerProfile = 'FAST' | 'SMART' | 'MAX';
export type PowerRouteState = 'AVAILABLE' | 'HOLD' | 'OFFLINE' | 'PAID_BLOCKED' | 'UNKNOWN';

export interface PowerRoute {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly capabilityB: number | null;
  readonly speedRank: number;
  readonly zeroCostVerified: boolean;
  readonly state: PowerRouteState;
  readonly external: boolean;
}

export interface PowerLadderPolicy {
  readonly profile: PowerProfile;
  readonly privacy: 'PUBLIC' | 'INTERNAL' | 'PRIVATE';
  readonly allowExternalBurst: boolean;
  readonly currentCapabilityB?: number;
  readonly strictUpgrade?: boolean;
}

export interface PowerLadderDecision {
  readonly protocol: 'VONE_POWER_LADDER_R1';
  readonly outcome: 'ROUTE_SELECTED' | 'HOLD';
  readonly selected: PowerRoute | null;
  readonly requiredCapabilityB: number;
  readonly strictUpgrade: boolean;
  readonly skipped: ReadonlyArray<{ id: string; reason: string }>;
  readonly invariant: 'ZERO_COST_MONOTONIC_NO_DOWNGRADE';
}

const PROFILE_FLOOR_B: Record<PowerProfile, number> = {
  FAST: 20,
  SMART: 70,
  MAX: 120,
};

function skipReason(route: PowerRoute, policy: PowerLadderPolicy, requiredCapabilityB: number, strictUpgrade: boolean): string | null {
  if (route.state === 'PAID_BLOCKED') return 'paid_route_blocked';
  if (route.state !== 'AVAILABLE') return 'route_not_available';
  if (!route.zeroCostVerified) return 'zero_cost_not_verified';
  if (route.external && policy.privacy === 'PRIVATE') return 'private_external_blocked';
  if (route.external && !policy.allowExternalBurst) return 'external_burst_not_allowed';
  if (route.capabilityB === null || !Number.isFinite(route.capabilityB)) return 'capability_unknown_hold';
  if (strictUpgrade && route.capabilityB <= requiredCapabilityB) return 'not_strictly_more_capable';
  if (!strictUpgrade && route.capabilityB < requiredCapabilityB) return 'below_capability_floor';
  return null;
}

export function profileFloorB(profile: PowerProfile): number {
  return PROFILE_FLOOR_B[profile];
}

export function selectMonotonicPowerRoute(routes: readonly PowerRoute[], policy: PowerLadderPolicy): PowerLadderDecision {
  const floor = profileFloorB(policy.profile);
  const hasCurrent = Number.isFinite(policy.currentCapabilityB);
  const requiredCapabilityB = hasCurrent ? Math.max(floor, Number(policy.currentCapabilityB)) : floor;
  const strictUpgrade = policy.strictUpgrade !== false && hasCurrent;
  const skipped: Array<{ id: string; reason: string }> = [];
  const eligible: PowerRoute[] = [];

  for (const route of routes) {
    const reason = skipReason(route, policy, requiredCapabilityB, strictUpgrade);
    if (reason) skipped.push({ id: route.id, reason });
    else eligible.push(route);
  }

  eligible.sort((a, b) => {
    const capabilityDelta = Number(a.capabilityB) - Number(b.capabilityB);
    if (capabilityDelta !== 0) return capabilityDelta;
    return b.speedRank - a.speedRank;
  });

  return {
    protocol: 'VONE_POWER_LADDER_R1',
    outcome: eligible.length ? 'ROUTE_SELECTED' : 'HOLD',
    selected: eligible[0] || null,
    requiredCapabilityB,
    strictUpgrade,
    skipped,
    invariant: 'ZERO_COST_MONOTONIC_NO_DOWNGRADE',
  };
}
