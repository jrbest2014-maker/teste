import type { ModelRoute, RouteState } from './vone_model_router';

const ELIGIBLE_STATES = new Set<RouteState>(['FREE_AVAILABLE', 'FREE_QUEUE', 'FREE_QUOTA_LOW']);
const ALLOWED_BILLING = new Set(['free', 'grant', 'included']);

export interface VOneCapacityRouteSnapshot {
    readonly route_id: string;
    readonly kind: string;
    readonly provider: string;
    readonly state: RouteState;
    readonly cost: {
        readonly billing_mode: string;
        readonly variable_cost_allowed: boolean;
        readonly verified_zero_cost: boolean;
        readonly verification_source?: string;
        readonly verified_at?: string | null;
    };
    readonly quota?: {
        readonly remaining_pct?: number | null;
        readonly reserve_threshold_pct?: number | null;
        readonly reset_at?: string | null;
        readonly confidence?: string;
    };
    readonly capabilities?: {
        readonly task_classes?: readonly string[];
        readonly models?: readonly string[];
        readonly modalities?: readonly string[];
        readonly accelerators?: readonly string[];
    };
    readonly health?: {
        readonly observed_at?: string | null;
        readonly ttl_seconds?: number | null;
    };
    readonly security?: {
        readonly trust_zone?: string;
        readonly allowed_privacy_classes?: readonly string[];
    };
}

export interface VOneCapacitySnapshotR1 {
    readonly protocol: 'VONE_CAPACITY_SNAPSHOT_R1';
    readonly generated_at: string;
    readonly policy_id: string;
    readonly authority: 'VONE_MASTER';
    readonly task: {
        readonly task_class: string;
        readonly privacy_class: string;
        readonly prefer_local?: boolean;
        readonly locality?: string;
    };
    readonly outcome: string;
    readonly selected: {
        readonly route_id: string;
        readonly state: RouteState;
        readonly score?: number | null;
        readonly route: VOneCapacityRouteSnapshot;
    } | null;
    readonly invariants?: {
        readonly paid_blocked?: string;
        readonly unknown_cost?: string;
        readonly physical_output?: string;
    };
}

export class CapacitySnapshotBlockedError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = 'CapacitySnapshotBlockedError';
    }
}

function asObject(value: unknown, code: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CapacitySnapshotBlockedError(code, code);
    }
    return value as Record<string, unknown>;
}

export function assertVerifiedCapacitySnapshot(
    value: unknown,
    options: {
        readonly nowMs?: number;
        readonly maxSnapshotAgeMs?: number;
        readonly expectedProviderContains?: string;
        readonly preferredModel?: string;
    } = {},
): asserts value is VOneCapacitySnapshotR1 {
    const root = asObject(value, 'capacity_snapshot_required');
    if (root.protocol !== 'VONE_CAPACITY_SNAPSHOT_R1') {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_protocol_invalid', 'Expected VONE_CAPACITY_SNAPSHOT_R1.');
    }
    if (root.authority !== 'VONE_MASTER') {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_authority_invalid', 'Capacity authority must be VONE_MASTER.');
    }

    const nowMs = options.nowMs ?? Date.now();
    const generatedMs = Date.parse(String(root.generated_at ?? ''));
    const maxAge = options.maxSnapshotAgeMs ?? 120_000;
    if (!Number.isFinite(generatedMs) || generatedMs > nowMs + 30_000 || nowMs - generatedMs > maxAge) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_stale', 'Capacity snapshot is stale or has an invalid timestamp.');
    }

    const selected = asObject(root.selected, 'capacity_snapshot_no_selected_route');
    const route = asObject(selected.route, 'capacity_snapshot_route_missing');
    const routeId = String(route.route_id ?? '');
    if (!routeId || routeId !== String(selected.route_id ?? '')) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_route_mismatch', 'Selected route id does not match route payload.');
    }

    const state = String(selected.state ?? route.state ?? '') as RouteState;
    if (!ELIGIBLE_STATES.has(state)) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_state_blocked', `Route state ${state || 'UNKNOWN'} is not eligible.`);
    }

    const cost = asObject(route.cost, 'capacity_snapshot_cost_missing');
    if (cost.variable_cost_allowed === true) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_paid_blocked', 'Variable-cost capacity is not allowed.');
    }
    if (cost.verified_zero_cost !== true) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_unknown_cost', 'Zero cost is not verified.');
    }
    if (!ALLOWED_BILLING.has(String(cost.billing_mode ?? ''))) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_billing_blocked', 'Billing mode is not approved for zero-cost execution.');
    }

    const quota = route.quota && typeof route.quota === 'object' ? route.quota as Record<string, unknown> : {};
    if (quota.confidence !== undefined && quota.confidence !== 'verified') {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_quota_unverified', 'Quota state is not verified.');
    }

    const task = asObject(root.task, 'capacity_snapshot_task_missing');
    const capabilities = route.capabilities && typeof route.capabilities === 'object'
        ? route.capabilities as Record<string, unknown>
        : {};
    const taskClasses = Array.isArray(capabilities.task_classes) ? capabilities.task_classes.map(String) : [];
    const taskClass = String(task.task_class ?? '');
    if (!taskClass || !taskClasses.includes(taskClass)) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_capability_mismatch', 'Selected route does not support the requested task class.');
    }

    const security = route.security && typeof route.security === 'object'
        ? route.security as Record<string, unknown>
        : {};
    const allowedPrivacy = Array.isArray(security.allowed_privacy_classes)
        ? security.allowed_privacy_classes.map(String)
        : [];
    const privacyClass = String(task.privacy_class ?? 'PRIVATE');
    if (!allowedPrivacy.includes(privacyClass)) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_privacy_mismatch', 'Selected route does not allow the requested privacy class.');
    }

    const health = route.health && typeof route.health === 'object' ? route.health as Record<string, unknown> : {};
    const observedMs = Date.parse(String(health.observed_at ?? ''));
    const ttlSeconds = Number(health.ttl_seconds ?? 0);
    if (!Number.isFinite(observedMs) || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || nowMs - observedMs > ttlSeconds * 1000) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_route_stale', 'Selected route health is stale.');
    }

    if (options.expectedProviderContains) {
        const provider = String(route.provider ?? '').toLowerCase();
        if (!provider.includes(options.expectedProviderContains.toLowerCase())) {
            throw new CapacitySnapshotBlockedError('capacity_snapshot_provider_mismatch', 'Selected route provider does not match this worker.');
        }
    }

    if (options.preferredModel) {
        const models = Array.isArray(capabilities.models) ? capabilities.models.map(String) : [];
        if (models.length > 0 && !models.includes(options.preferredModel)) {
            throw new CapacitySnapshotBlockedError('capacity_snapshot_model_mismatch', 'Configured model is not approved by the Master snapshot.');
        }
    }

    const invariants = root.invariants && typeof root.invariants === 'object'
        ? root.invariants as Record<string, unknown>
        : {};
    if (invariants.paid_blocked !== 'INVIOLABLE' || invariants.unknown_cost !== 'HOLD' || invariants.physical_output !== 'LOCKED') {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_invariants_invalid', 'Master safety/cost invariants are missing or weakened.');
    }
}

export function modelRouteFromCapacitySnapshot(
    snapshot: VOneCapacitySnapshotR1,
    preferredModel?: string,
): ModelRoute {
    const route = snapshot.selected?.route;
    if (!route) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_no_selected_route', 'No selected route.');
    }
    const models = route.capabilities?.models?.map(String) ?? [];
    const model = preferredModel || models[0];
    if (!model) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_model_missing', 'No model is approved for the selected route.');
    }
    if (preferredModel && models.length > 0 && !models.includes(preferredModel)) {
        throw new CapacitySnapshotBlockedError('capacity_snapshot_model_mismatch', 'Configured model is not approved by the Master snapshot.');
    }

    return {
        id: route.route_id,
        tier: 'free',
        model,
        costPerMTokUsd: 0,
        state: route.state,
        neuronsUsedToday: 0,
    };
}
