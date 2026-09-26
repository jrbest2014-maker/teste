import assert from 'node:assert/strict';
import {
    assertVerifiedCapacitySnapshot,
    CapacitySnapshotBlockedError,
    modelRouteFromCapacitySnapshot,
    type VOneCapacitySnapshotR1,
} from './vone_capacity_snapshot';

function validSnapshot(now = Date.now()): VOneCapacitySnapshotR1 {
    return {
        protocol: 'VONE_CAPACITY_SNAPSHOT_R1',
        generated_at: new Date(now).toISOString(),
        policy_id: 'VONE_ZERO_COST_DEFAULT',
        authority: 'VONE_MASTER',
        task: {
            task_class: 'LLM_FAST',
            privacy_class: 'PRIVATE',
            prefer_local: true,
            locality: 'client',
        },
        outcome: 'ROUTE_SELECTED',
        selected: {
            route_id: 'local-ollama-vone-fallback',
            state: 'FREE_AVAILABLE',
            score: 90,
            route: {
                route_id: 'local-ollama-vone-fallback',
                kind: 'desktop',
                provider: 'ollama',
                state: 'FREE_AVAILABLE',
                cost: {
                    billing_mode: 'included',
                    variable_cost_allowed: false,
                    verified_zero_cost: true,
                    verification_source: 'owned-capacity',
                    verified_at: new Date(now).toISOString(),
                },
                quota: {
                    remaining_pct: 100,
                    reserve_threshold_pct: 15,
                    confidence: 'verified',
                },
                capabilities: {
                    task_classes: ['LLM_FAST', 'LLM_LARGE_REASONING'],
                    models: ['qwen2.5-coder:3b'],
                    modalities: ['text'],
                },
                health: {
                    observed_at: new Date(now).toISOString(),
                    ttl_seconds: 60,
                },
                security: {
                    trust_zone: 'private_worker',
                    allowed_privacy_classes: ['PUBLIC', 'INTERNAL', 'PRIVATE'],
                },
            },
        },
        invariants: {
            paid_blocked: 'INVIOLABLE',
            unknown_cost: 'HOLD',
            physical_output: 'LOCKED',
        },
    };
}

function expectBlocked(value: unknown, code: string, options: Parameters<typeof assertVerifiedCapacitySnapshot>[1] = {}): void {
    assert.throws(
        () => assertVerifiedCapacitySnapshot(value, options),
        (error: unknown) => error instanceof CapacitySnapshotBlockedError && error.code === code,
    );
}

function main(): void {
    const now = Date.now();
    const snapshot = validSnapshot(now);

    assertVerifiedCapacitySnapshot(snapshot, {
        nowMs: now,
        expectedProviderContains: 'ollama',
        preferredModel: 'qwen2.5-coder:3b',
    });

    const route = modelRouteFromCapacitySnapshot(snapshot, 'qwen2.5-coder:3b');
    assert.equal(route.id, 'local-ollama-vone-fallback');
    assert.equal(route.tier, 'free');
    assert.equal(route.costPerMTokUsd, 0);
    assert.equal(route.model, 'qwen2.5-coder:3b');

    expectBlocked(null, 'capacity_snapshot_required');

    const stale = validSnapshot(now - 180_000);
    expectBlocked(stale, 'capacity_snapshot_stale', { nowMs: now, maxSnapshotAgeMs: 120_000 });

    const paid = structuredClone(snapshot) as any;
    paid.selected!.route.cost.variable_cost_allowed = true;
    expectBlocked(paid, 'capacity_snapshot_paid_blocked', { nowMs: now });

    const unknown = structuredClone(snapshot) as any;
    unknown.selected!.route.cost.verified_zero_cost = false;
    expectBlocked(unknown, 'capacity_snapshot_unknown_cost', { nowMs: now });

    expectBlocked(snapshot, 'capacity_snapshot_provider_mismatch', {
        nowMs: now,
        expectedProviderContains: 'cloudflare',
    });

    expectBlocked(snapshot, 'capacity_snapshot_model_mismatch', {
        nowMs: now,
        preferredModel: 'not-approved-model',
    });

    const capabilityMismatch = structuredClone(snapshot) as any;
    capabilityMismatch.task.task_class = 'VISION';
    expectBlocked(capabilityMismatch, 'capacity_snapshot_capability_mismatch', { nowMs: now });

    const weakened = structuredClone(snapshot) as any;
    weakened.invariants!.unknown_cost = 'ALLOW';
    expectBlocked(weakened, 'capacity_snapshot_invariants_invalid', { nowMs: now });

    console.log('vone_capacity_snapshot: all assertions passed');
}

main();
