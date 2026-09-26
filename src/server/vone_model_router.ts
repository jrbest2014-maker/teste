export type RouteTier = 'free' | 'paid';

export type RouteState =
    | 'FREE_AVAILABLE'
    | 'FREE_QUEUE'
    | 'FREE_QUOTA_LOW'
    | 'FREE_EXHAUSTED'
    | 'PAID_BLOCKED'
    | 'OFFLINE';

export interface ModelRoute {
    readonly id: string;
    readonly tier: RouteTier;
    readonly model: string;
    readonly costPerMTokUsd: number | null;
    state: RouteState;
    neuronsUsedToday: number;
}

export interface RoutingGates {
    readonly paidBlocked: 'INVIOLABLE';
    readonly unknownCost: 'HOLD';
    readonly physicalOutput: 'LOCKED' | 'UNLOCKED';
}

export interface InferenceRequest {
    readonly prompt: string;
    readonly maxTokens?: number;
    readonly requiresPhysicalOutput?: boolean;
}

export interface InferenceResult {
    readonly routeId: string;
    readonly model: string;
    readonly text: string;
    readonly neuronsUsed: number;
}

export interface ModelCaller {
    run(route: ModelRoute, request: InferenceRequest): Promise<{ text: string; neuronsUsed: number }>;
}

export type RoutingBlockReason = 'physicalOutputLocked' | 'paidBlocked' | 'unknownCost' | 'noCapacity';

export class RoutingBlockedError extends Error {
    constructor(
        public readonly reason: string,
        public readonly category: RoutingBlockReason,
    ) {
        super(`[ROUTING BLOCKED]: ${reason}`);
        this.name = 'RoutingBlockedError';
    }
}

const DEFAULT_DAILY_NEURON_HARD_CAP = 5000;
const QUOTA_LOW_THRESHOLD = 0.9;
const SELECTABLE_STATES: ReadonlySet<RouteState> = new Set(['FREE_AVAILABLE', 'FREE_QUEUE']);

/**
 * Routes inference requests across model tiers while enforcing V-ONE's
 * zero-cost-by-default policy: paid routes are never chosen while the
 * paid-blocked gate holds, a route with unknown per-token cost is treated
 * as un-routable rather than assumed free, and any request that would
 * produce physical hardware output (e.g. G-code) is refused while that
 * gate is locked. Gate state is fixed at construction time - this router
 * never unlocks a gate on its own.
 */
export class ModelRouter {
    constructor(
        private readonly routes: ModelRoute[],
        private readonly gates: RoutingGates,
        private readonly caller: ModelCaller,
        private readonly dailyNeuronHardCap: number = DEFAULT_DAILY_NEURON_HARD_CAP,
    ) {}

    public listRoutes(): readonly ModelRoute[] {
        return this.routes.map((route) => ({ ...route }));
    }

    public selectRoute(request: InferenceRequest): ModelRoute {
        if (request.requiresPhysicalOutput && this.gates.physicalOutput === 'LOCKED') {
            throw new RoutingBlockedError(
                'physical_output gate is LOCKED; refusing a request that targets physical hardware.',
                'physicalOutputLocked',
            );
        }

        let anyPaidFiltered = false;
        let anyUnknownCostFiltered = false;

        const candidates = this.routes.filter((route) => {
            if (route.tier === 'paid' && this.gates.paidBlocked === 'INVIOLABLE') {
                anyPaidFiltered = true;
                return false;
            }
            if (route.costPerMTokUsd === null && this.gates.unknownCost === 'HOLD') {
                anyUnknownCostFiltered = true;
                return false;
            }
            return SELECTABLE_STATES.has(route.state);
        });

        if (candidates.length === 0) {
            // Priority reflects which gate a caller could act on first: a paid
            // route becoming free-tier changes nothing while cost stays unknown,
            // but an unknown-cost route becoming known-cost immediately helps -
            // so unknown cost is surfaced whenever both are in play.
            const category: RoutingBlockReason = anyUnknownCostFiltered
                ? 'unknownCost'
                : anyPaidFiltered
                  ? 'paidBlocked'
                  : 'noCapacity';
            throw new RoutingBlockedError(
                'No route is both cost-known and in a selectable capacity state under the current gates.',
                category,
            );
        }

        candidates.sort(
            (a, b) => a.neuronsUsedToday / this.dailyNeuronHardCap - b.neuronsUsedToday / this.dailyNeuronHardCap,
        );
        return candidates[0];
    }

    public async dispatch(request: InferenceRequest): Promise<InferenceResult> {
        const route = this.selectRoute(request);
        const result = await this.caller.run(route, request);

        route.neuronsUsedToday += result.neuronsUsed;
        this.refreshState(route);

        return { routeId: route.id, model: route.model, text: result.text, neuronsUsed: result.neuronsUsed };
    }

    private refreshState(route: ModelRoute): void {
        if (route.tier !== 'free') return;
        const usageRatio = route.neuronsUsedToday / this.dailyNeuronHardCap;
        if (usageRatio >= 1) {
            route.state = 'FREE_EXHAUSTED';
        } else if (usageRatio >= QUOTA_LOW_THRESHOLD) {
            route.state = 'FREE_QUOTA_LOW';
        }
    }
}

export interface CloudflareWorkersAIOptions {
    readonly accountId: string;
    readonly apiToken: string;
    readonly fetchImpl?: typeof fetch;
}

interface CloudflareAIRunResponse {
    success: boolean;
    result?: { response?: string };
    errors?: Array<{ message: string }>;
}

/**
 * Calls Cloudflare Workers AI, the free-tier route V-ONE routes to by
 * default. Neuron usage isn't returned by the run endpoint, so it's
 * estimated from the requested token budget purely to keep the router's
 * local quota tracking conservative - swap in the account's real usage
 * figure once it is available from Cloudflare.
 */
export class CloudflareWorkersAICaller implements ModelCaller {
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly options: CloudflareWorkersAIOptions) {
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    public async run(
        route: ModelRoute,
        request: InferenceRequest,
    ): Promise<{ text: string; neuronsUsed: number }> {
        const url = `https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}/ai/run/${route.model}`;
        const response = await this.fetchImpl(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.options.apiToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: request.prompt }],
                max_tokens: request.maxTokens ?? 512,
            }),
        });

        if (!response.ok) {
            throw new Error(`[CLOUDFLARE AI ERROR]: HTTP ${response.status} ${await response.text()}`);
        }

        const payload = (await response.json()) as CloudflareAIRunResponse;
        if (!payload.success || !payload.result?.response) {
            const message = payload.errors?.map((e) => e.message).join('; ') ?? 'unknown error';
            throw new Error(`[CLOUDFLARE AI ERROR]: ${message}`);
        }

        return {
            text: payload.result.response,
            neuronsUsed: estimateNeurons(request.maxTokens ?? 512),
        };
    }
}

function estimateNeurons(maxTokens: number): number {
    return Math.max(1, Math.ceil(maxTokens / 100));
}

export function createDefaultRoutes(): ModelRoute[] {
    return [
        {
            id: 'cloudflare-free-llama',
            tier: 'free',
            model: '@cf/meta/llama-3.1-8b-instruct',
            costPerMTokUsd: 0,
            state: 'FREE_AVAILABLE',
            neuronsUsedToday: 0,
        },
        {
            id: 'anthropic-paid-fallback',
            tier: 'paid',
            model: 'claude-sonnet-5',
            costPerMTokUsd: 2,
            state: 'PAID_BLOCKED',
            neuronsUsedToday: 0,
        },
    ];
}

export function createDefaultGates(): RoutingGates {
    return { paidBlocked: 'INVIOLABLE', unknownCost: 'HOLD', physicalOutput: 'LOCKED' };
}
