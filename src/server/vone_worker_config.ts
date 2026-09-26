import { inspect } from 'node:util';
import { SUPPORTED_CAPABILITIES } from './vone_execution_contract';

/**
 * The ONLY place the worker reads its environment. Variable names:
 *
 *   VONE_MASTER_URL         base URL of the V-ONE Master / control plane (required)
 *   VONE_WORKER_ID          this worker's identity (required)
 *   VONE_WORKER_TOKEN       worker credential (required; never logged/serialized)
 *   VONE_WORKER_POLL_MS     idle poll interval, default 5000 (optional)
 *   VONE_WORKER_TIMEOUT_MS  per-request timeout, default 15000 (optional)
 *   VONE_WORKER_ROOT        sandbox root for jobs + ledger, default cwd (optional)
 *   VONE_CF_ACCOUNT_ID      Cloudflare account for the free Workers AI route (optional here;
 *   VONE_CF_AI_TOKEN        both-or-neither; the boot entry fails closed without them)
 *
 * Missing/empty required values fail closed here, before any transport is
 * constructed - so no network call can happen without a credential. Error
 * messages and describeWorkerConfig() report only presence, never values.
 */

/**
 * Opaque holder for the worker token. It is not an enumerable property of
 * anything, and JSON.stringify / String() / util.inspect all render a fixed
 * placeholder, so accidentally logging a config object cannot leak it.
 */
export interface WorkerCredential {
    readonly present: true;
    /** The raw token - call only at the point of building an Authorization header. */
    reveal(): string;
    toJSON(): string;
    toString(): string;
}

export function createWorkerCredential(token: string, name = 'VONE_WORKER_TOKEN'): WorkerCredential {
    if (typeof token !== 'string' || token.trim().length === 0) {
        throw new WorkerConfigError([name]);
    }
    const placeholder = `[REDACTED:${name}]`;
    const credential = {
        present: true as const,
        reveal: () => token,
        toJSON: () => placeholder,
        toString: () => placeholder,
        [inspect.custom]: () => placeholder,
    };
    return Object.freeze(credential);
}

export interface WorkerConfig {
    readonly masterUrl: string;
    readonly workerId: string;
    readonly credential: WorkerCredential;
    readonly pollIntervalMs: number;
    readonly requestTimeoutMs: number;
    readonly capabilities: typeof SUPPORTED_CAPABILITIES;
    readonly workRoot: string | null;
    /** null when neither VONE_CF_ACCOUNT_ID nor VONE_CF_AI_TOKEN is set. */
    readonly cloudflareAi: { readonly accountId: string; readonly credential: WorkerCredential } | null;
}

export class WorkerConfigError extends Error {
    constructor(public readonly missingOrInvalid: readonly string[], detail?: string) {
        super(
            `[WORKER CONFIG]: fail-closed - missing or invalid: ${missingOrInvalid.join(', ')}` +
                (detail ? ` (${detail})` : ''),
        );
        this.name = 'WorkerConfigError';
    }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, problems: string[]): number {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        problems.push(name);
        return fallback;
    }
    return value;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
    const problems: string[] = [];
    const details: string[] = [];

    const masterUrl = (env.VONE_MASTER_URL ?? '').trim();
    if (!masterUrl) {
        problems.push('VONE_MASTER_URL');
    } else {
        try {
            const parsed = new URL(masterUrl);
            const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);
            if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
                problems.push('VONE_MASTER_URL');
                details.push('VONE_MASTER_URL must be https (plain http only allowed for loopback)');
            }
            if (parsed.username || parsed.password) {
                problems.push('VONE_MASTER_URL');
                details.push('VONE_MASTER_URL must not embed credentials');
            }
        } catch {
            problems.push('VONE_MASTER_URL');
            details.push('VONE_MASTER_URL is not a valid URL');
        }
    }

    const workerId = (env.VONE_WORKER_ID ?? '').trim();
    if (!workerId || !/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) {
        problems.push('VONE_WORKER_ID');
    }

    const token = env.VONE_WORKER_TOKEN ?? '';
    if (token.trim().length === 0) {
        problems.push('VONE_WORKER_TOKEN');
    }

    const pollIntervalMs = readPositiveInt(env, 'VONE_WORKER_POLL_MS', 5000, problems);
    const requestTimeoutMs = readPositiveInt(env, 'VONE_WORKER_TIMEOUT_MS', 15000, problems);

    const workRoot = (env.VONE_WORKER_ROOT ?? '').trim() || null;

    const cfAccountId = (env.VONE_CF_ACCOUNT_ID ?? '').trim();
    const cfToken = env.VONE_CF_AI_TOKEN ?? '';
    const cfTokenPresent = cfToken.trim().length > 0;
    if ((cfAccountId.length > 0) !== cfTokenPresent) {
        problems.push(cfAccountId ? 'VONE_CF_AI_TOKEN' : 'VONE_CF_ACCOUNT_ID');
        details.push('VONE_CF_ACCOUNT_ID and VONE_CF_AI_TOKEN must be set together');
    }

    if (problems.length > 0) {
        throw new WorkerConfigError([...new Set(problems)], details.length ? details.join('; ') : undefined);
    }

    return Object.freeze({
        masterUrl: masterUrl.replace(/\/+$/, ''),
        workerId,
        credential: createWorkerCredential(token),
        pollIntervalMs,
        requestTimeoutMs,
        capabilities: SUPPORTED_CAPABILITIES,
        workRoot,
        cloudflareAi: cfAccountId
            ? Object.freeze({ accountId: cfAccountId, credential: createWorkerCredential(cfToken, 'VONE_CF_AI_TOKEN') })
            : null,
    });
}

/** Safe-to-log view: the token is reported only as present/absent. */
export function describeWorkerConfig(config: WorkerConfig): Record<string, unknown> {
    return {
        masterUrl: config.masterUrl,
        workerId: config.workerId,
        token: config.credential?.present ? 'present' : 'absent',
        pollIntervalMs: config.pollIntervalMs,
        requestTimeoutMs: config.requestTimeoutMs,
        capabilities: [...config.capabilities],
        workRoot: config.workRoot ?? '(cwd)',
        cloudflareAiToken: config.cloudflareAi ? 'present' : 'absent',
    };
}
