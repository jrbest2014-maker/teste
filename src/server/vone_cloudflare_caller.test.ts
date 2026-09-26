import assert from 'node:assert/strict';
import { CloudflareWorkersAICaller, type ModelRoute } from './vone_model_router';

/**
 * Contract test for CloudflareWorkersAICaller's HTTP shape and response
 * parsing, using the injectable fetchImpl - no network call, no account,
 * no token. This proves the request/response handling logic is correct;
 * it does NOT prove connectivity against a real Cloudflare account, which
 * remains untested pending real credentials.
 */

interface CapturedRequest {
    url: string;
    method?: string;
    headers: Record<string, string>;
    body: unknown;
}

function fakeFetch(
    handler: (req: CapturedRequest) => { ok: boolean; status?: number; text?: string; json?: unknown },
): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
    const calls: CapturedRequest[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        const captured: CapturedRequest = { url: String(input), method: init?.method, headers, body };
        calls.push(captured);
        const result = handler(captured);
        return {
            ok: result.ok,
            status: result.status ?? (result.ok ? 200 : 500),
            text: async () => result.text ?? '',
            json: async () => result.json ?? {},
        } as Response;
    }) as typeof fetch;
    return { fetchImpl, calls };
}

function route(model = '@cf/meta/llama-3.1-8b-instruct'): ModelRoute {
    return { id: 'r', tier: 'free', model, costPerMTokUsd: 0, state: 'FREE_AVAILABLE', neuronsUsedToday: 0 };
}

function assertRejectsWith(promise: Promise<unknown>, expected: RegExp): Promise<void> {
    return assert.rejects(() => promise, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected);
        return true;
    });
}

async function main(): Promise<void> {
    // Request shape matches Cloudflare's documented contract exactly: URL,
    // auth header, content-type, and body.
    {
        const { fetchImpl, calls } = fakeFetch(() => ({
            ok: true,
            json: { success: true, result: { response: 'hi there' } },
        }));
        const caller = new CloudflareWorkersAICaller({ accountId: 'acc123', apiToken: 'tok456', fetchImpl });

        const result = await caller.run(route(), { prompt: 'hello', maxTokens: 250 });

        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].url,
            'https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/meta/llama-3.1-8b-instruct',
        );
        assert.equal(calls[0].method, 'POST');
        assert.equal(calls[0].headers.authorization, 'Bearer tok456');
        assert.equal(calls[0].headers['content-type'], 'application/json');
        assert.deepEqual(calls[0].body, { messages: [{ role: 'user', content: 'hello' }], max_tokens: 250 });
        assert.equal(result.text, 'hi there');
        assert.equal(result.neuronsUsed, 3); // ceil(250/100)
    }

    // Missing maxTokens falls back to the documented default of 512.
    {
        const { fetchImpl, calls } = fakeFetch(() => ({ ok: true, json: { success: true, result: { response: 'ok' } } }));
        const caller = new CloudflareWorkersAICaller({ accountId: 'a', apiToken: 't', fetchImpl });
        const result = await caller.run(route(), { prompt: 'x' });
        assert.equal((calls[0].body as { max_tokens: number }).max_tokens, 512);
        assert.equal(result.neuronsUsed, 6); // ceil(512/100)
    }

    // HTTP-level failure (non-2xx) rejects with the response status and body text.
    {
        const { fetchImpl } = fakeFetch(() => ({ ok: false, status: 503, text: 'service unavailable' }));
        const caller = new CloudflareWorkersAICaller({ accountId: 'a', apiToken: 't', fetchImpl });
        await assertRejectsWith(caller.run(route(), { prompt: 'x' }), /\[CLOUDFLARE AI ERROR\]: HTTP 503 service unavailable/);
    }

    // API-level failure (200 OK but success:false) rejects with Cloudflare's own error message.
    {
        const { fetchImpl } = fakeFetch(() => ({
            ok: true,
            json: { success: false, errors: [{ message: 'invalid model' }] },
        }));
        const caller = new CloudflareWorkersAICaller({ accountId: 'a', apiToken: 't', fetchImpl });
        await assertRejectsWith(caller.run(route(), { prompt: 'x' }), /\[CLOUDFLARE AI ERROR\]: invalid model/);
    }

    // success:true but no usable result.response is still treated as a
    // failure, never a silent empty success.
    {
        const { fetchImpl } = fakeFetch(() => ({ ok: true, json: { success: true, result: {} } }));
        const caller = new CloudflareWorkersAICaller({ accountId: 'a', apiToken: 't', fetchImpl });
        await assertRejectsWith(caller.run(route(), { prompt: 'x' }), /\[CLOUDFLARE AI ERROR\]/);
    }

    console.log('vone_cloudflare_caller: all assertions passed (HTTP contract only - no live Cloudflare account contacted)');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
