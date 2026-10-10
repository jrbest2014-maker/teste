import assert from 'node:assert/strict';
import {
    CloudflareWorkersAICaller,
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
        assert.throws(() => router.selectRoute({ prompt: 'x' }), (error: unknown) => {
            assert.ok(error instanceof RoutingBlockedError);
            assert.equal(error.category, 'paidBlocked');
            return true;
        });
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
        assert.throws(() => router.selectRoute({ prompt: 'x' }), (error: unknown) => {
            assert.ok(error instanceof RoutingBlockedError);
            assert.equal(error.category, 'unknownCost');
            return true;
        });
    }

    // Requests that target physical hardware are refused while the gate is locked.
    {
        const router = new ModelRouter(createDefaultRoutes(), createDefaultGates(), new StubCaller(10));
        assert.throws(
            () => router.selectRoute({ prompt: 'send gcode', requiresPhysicalOutput: true }),
            (error: unknown) => {
                assert.ok(error instanceof RoutingBlockedError);
                assert.equal(error.category, 'physicalOutputLocked');
                return true;
            },
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

    // Cloudflare HTTP contract: validates request construction and parsing without network access.
    {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const fetchImpl: typeof fetch = async (input, init) => {
            calls.push({ url: String(input), init });
            return new Response(JSON.stringify({ success: true, result: { response: 'ok' } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        };
        const caller = new CloudflareWorkersAICaller({
            accountId: 'acct-test',
            apiToken: 'token-test',
            fetchImpl,
        });
        const route = createDefaultRoutes()[0];
        const result = await caller.run(route, { prompt: 'contract-check', maxTokens: 250 });
        assert.equal(result.text, 'ok');
        assert.equal(result.neuronsUsed, 3);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/acct-test/ai/run/${route.model}`);
        assert.equal(calls[0].init?.method, 'POST');
        const headers = calls[0].init?.headers as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer token-test');
        assert.equal(headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
            messages: [{ role: 'user', content: 'contract-check' }],
            max_tokens: 250,
        });
    }

    // Default token budget and error contracts remain fail-closed.
    {
        const route = createDefaultRoutes()[0];
        let body = '';
        const okFetch: typeof fetch = async (_input, init) => {
            body = String(init?.body);
            return new Response(JSON.stringify({ success: true, result: { response: 'default-ok' } }), { status: 200 });
        };
        const caller = new CloudflareWorkersAICaller({ accountId: 'a', apiToken: 't', fetchImpl: okFetch });
        const result = await caller.run(route, { prompt: 'default-budget' });
        assert.equal(JSON.parse(body).max_tokens, 512);
        assert.equal(result.neuronsUsed, 6);

        const httpFail: typeof fetch = async () => new Response('denied', { status: 403 });
        await assert.rejects(
            () => new CloudflareWorkersAICaller({ accountId: 'a', apiToken: 't', fetchImpl: httpFail }).run(route, { prompt: 'x' }),
            /HTTP 403/,
        );

        const apiFail: typeof fetch = async () =>
            new Response(JSON.stringify({ success: false, errors: [{ message: 'bad request' }] }), { status: 200 });
        await assert.rejects(
            () => new CloudflareWorkersAICaller({ accountId: 'a', apiToken: 't', fetchImpl: apiFail }).run(route, { prompt: 'x' }),
            /bad request/,
        );

        const emptySuccess: typeof fetch = async () =>
            new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
        await assert.rejects(
            () => new CloudflareWorkersAICaller({ accountId: 'a', apiToken: 't', fetchImpl: emptySuccess }).run(route, { prompt: 'x' }),
            /unknown error/,
        );
    }

    console.log('vone_model_router: all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
