import assert from 'node:assert/strict';
import {
    ModelRouter,
    RoutingBlockedError,
    createDefaultGates,
    createDefaultRoutes,
    type InferenceRequest,
    type ModelCaller,
    type ModelRoute,
} from './vone_model_router';

class StubCaller implements ModelCaller {
    public calls: Array<{ route: ModelRoute; request: InferenceRequest }> = [];
    constructor(private readonly neuronsUsed: number) {}

    public async run(route: ModelRoute, request: InferenceRequest) {
        this.calls.push({ route, request });
        return { text: `stub-response-from-${route.id}`, neuronsUsed: this.neuronsUsed };
    }
}

async function main(): Promise<void> {
    // A paid route is never selected while paidBlocked stays INVIOLABLE, even
    // if every free route is exhausted and the paid route reports available.
    {
        const routes = createDefaultRoutes();
        routes[0].state = 'FREE_EXHAUSTED';
        routes[1].state = 'FREE_AVAILABLE';
        const router = new ModelRouter(routes, createDefaultGates(), new StubCaller(10));
        assert.throws(() => router.selectRoute({ prompt: 'x' }), RoutingBlockedError);
    }

    // A route with unknown per-token cost is held rather than treated as free.
    {
        const routes: ModelRoute[] = [
            {
                id: 'mystery-route',
                tier: 'free',
                model: 'unknown-model',
                costPerMTokUsd: null,
                state: 'FREE_AVAILABLE',
                neuronsUsedToday: 0,
            },
        ];
        const router = new ModelRouter(routes, createDefaultGates(), new StubCaller(10));
        assert.throws(() => router.selectRoute({ prompt: 'x' }), RoutingBlockedError);
    }

    // Requests that target physical hardware are refused while the gate is locked.
    {
        const router = new ModelRouter(createDefaultRoutes(), createDefaultGates(), new StubCaller(10));
        assert.throws(
            () => router.selectRoute({ prompt: 'send gcode', requiresPhysicalOutput: true }),
            RoutingBlockedError,
        );
    }

    // Happy path: dispatches to the free route and records neuron usage.
    {
        const caller = new StubCaller(10);
        const router = new ModelRouter(createDefaultRoutes(), createDefaultGates(), caller, 20);
        const result = await router.dispatch({ prompt: 'hello' });
        assert.equal(result.routeId, 'cloudflare-free-llama');
        assert.equal(caller.calls.length, 1);
    }

    // Crossing the daily neuron cap flips the route to FREE_EXHAUSTED and the
    // next dispatch is held rather than silently spilling onto the paid route.
    {
        const caller = new StubCaller(12);
        const router = new ModelRouter(createDefaultRoutes(), createDefaultGates(), caller, 20);
        await router.dispatch({ prompt: 'first' }); // 12/20 -> still FREE_AVAILABLE
        await router.dispatch({ prompt: 'second' }); // 24/20 -> FREE_EXHAUSTED
        await assert.rejects(() => router.dispatch({ prompt: 'third' }), RoutingBlockedError);
    }

    console.log('vone_model_router: all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
