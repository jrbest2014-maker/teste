import assert from 'node:assert/strict';
import { VOneLocalChatServer } from './vone_local_chat_server';
import type { FailoverExecutionResult } from './vone_inference_failover_executor';

function stubExecutor(result: FailoverExecutionResult | Error) {
    let calls = 0;
    let lastArgs: unknown;
    return {
        calls: () => calls,
        lastArgs: () => lastArgs,
        execute: async (args: unknown) => {
            calls++;
            lastArgs = args;
            if (result instanceof Error) throw result;
            return result;
        },
    };
}

function doneResult(overrides: Partial<FailoverExecutionResult> = {}): FailoverExecutionResult {
    return {
        protocol: 'VONE_INFERENCE_FAILOVER_R1',
        status: 'DONE',
        target: 'DESKTOP_LOCAL',
        reason: 'cloud_unavailable_local_worker_online',
        text: 'VONE_LOCAL_CHAT_OK',
        model: 'v-one-coder:fast',
        neurons: 3,
        evidenceSha256: 'a'.repeat(64),
        ...overrides,
    };
}

async function postChat(port: number, token: string, body: unknown): Promise<{ status: number; json: any }> {
    const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
}

async function main() {
    // Caminho feliz: executor resolve DONE, resposta 200 com o shape certo.
    {
        const exec = stubExecutor(doneResult());
        const server = new VOneLocalChatServer(exec, { port: 0, authToken: 'secret-token' });
        await server.start();
        const port = server.getAddress().port;
        try {
            const { status, json } = await postChat(port, 'secret-token', { prompt: 'oi', max_tokens: 64 });
            assert.equal(status, 200);
            assert.equal(json.status, 'DONE');
            assert.equal(json.target, 'DESKTOP_LOCAL');
            assert.equal(json.text, 'VONE_LOCAL_CHAT_OK');
            assert.equal(exec.calls(), 1);
            const args = exec.lastArgs() as any;
            assert.equal(args.prompt, 'oi');
            assert.deepEqual(args.capacity, { cloud: 'FREE_AVAILABLE', desktop: 'ONLINE' });
        } finally {
            await server.close();
        }
    }

    // HOLD do executor vira 503, não 200 - nunca mascarar bloqueio como sucesso.
    {
        const exec = stubExecutor(doneResult({ status: 'HOLD', target: 'HOLD', text: undefined, model: undefined }));
        const server = new VOneLocalChatServer(exec, { port: 0, authToken: 'secret-token' });
        await server.start();
        try {
            const { status, json } = await postChat(server.getAddress().port, 'secret-token', { prompt: 'oi' });
            assert.equal(status, 503);
            assert.equal(json.status, 'HOLD');
        } finally {
            await server.close();
        }
    }

    // Token errado -> 401, executor nunca chamado.
    {
        const exec = stubExecutor(doneResult());
        const server = new VOneLocalChatServer(exec, { port: 0, authToken: 'secret-token' });
        await server.start();
        try {
            const { status } = await postChat(server.getAddress().port, 'wrong-token', { prompt: 'oi' });
            assert.equal(status, 401);
            assert.equal(exec.calls(), 0);
        } finally {
            await server.close();
        }
    }

    // Sem prompt -> 400, executor nunca chamado.
    {
        const exec = stubExecutor(doneResult());
        const server = new VOneLocalChatServer(exec, { port: 0, authToken: 'secret-token' });
        await server.start();
        try {
            const { status } = await postChat(server.getAddress().port, 'secret-token', {});
            assert.equal(status, 400);
            assert.equal(exec.calls(), 0);
        } finally {
            await server.close();
        }
    }

    // Erro do executor -> 500 com mensagem, não derruba o servidor.
    {
        const exec = stubExecutor(new Error('ollama_unreachable'));
        const server = new VOneLocalChatServer(exec, { port: 0, authToken: 'secret-token' });
        await server.start();
        try {
            const { status, json } = await postChat(server.getAddress().port, 'secret-token', { prompt: 'oi' });
            assert.equal(status, 500);
            assert.equal(json.message, 'ollama_unreachable');
        } finally {
            await server.close();
        }
    }

    // /health não exige auth.
    {
        const exec = stubExecutor(doneResult());
        const server = new VOneLocalChatServer(exec, { port: 0, authToken: 'secret-token' });
        await server.start();
        try {
            const response = await fetch(`http://127.0.0.1:${server.getAddress().port}/health`);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { ok: true, service: 'vone-local-chat' });
        } finally {
            await server.close();
        }
    }

    // Host não-loopback é recusado na construção (mesma postura do IPC bridge).
    {
        const exec = stubExecutor(doneResult());
        assert.throws(() => new VOneLocalChatServer(exec, { host: '0.0.0.0', port: 0 }), /non-loopback/);
    }

    console.log(JSON.stringify({
        test: 'VONE_LOCAL_CHAT_SERVER_R1', status: 'PASS',
        happy_path: true, hold_maps_to_503: true, auth_enforced: true, prompt_required: true,
        executor_error_maps_to_500: true, health_no_auth: true, loopback_only_enforced: true,
    }));
}

main().catch((e) => { console.error(e); process.exit(1); });
