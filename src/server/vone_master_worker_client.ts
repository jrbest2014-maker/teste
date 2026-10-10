import type { MasterWorkerClient, MasterWorkerJob } from './vone_owned_executor_worker';

export interface VOneMasterWorkerHttpClientOptions {
    readonly baseUrl: string;
    readonly workerId: string;
    readonly workerToken: string;
    readonly fetchImpl?: typeof fetch;
}

export class VOneMasterWorkerHttpClient implements MasterWorkerClient {
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly options: VOneMasterWorkerHttpClientOptions) {
        this.fetchImpl = options.fetchImpl ?? fetch;
        if (!options.baseUrl.startsWith('https://')) throw new Error('master_base_url_must_be_https');
        if (options.workerToken.length < 32) throw new Error('worker_token_invalid');
    }

    public async heartbeat(statusPayload: Readonly<Record<string, unknown>>): Promise<void> {
        await this.post('/api/worker/heartbeat', {
            workerId: this.options.workerId,
            version: 'VONE_EXECUTION_CONTRACT_R1',
            statusPayload,
        });
    }

    public async claim(): Promise<MasterWorkerJob | null> {
        const payload = await this.post('/api/worker/claim', { workerId: this.options.workerId }) as { job?: MasterWorkerJob | null };
        return payload.job ?? null;
    }

    public async result(jobId: string, result: unknown): Promise<void> {
        await this.post('/api/worker/result', { jobId, workerId: this.options.workerId, result });
    }

    public async error(jobId: string, message: string): Promise<void> {
        await this.post('/api/worker/result', { jobId, workerId: this.options.workerId, error: message.slice(0, 4000) });
    }

    private async post(path: string, body: unknown): Promise<unknown> {
        const response = await this.fetchImpl(this.options.baseUrl + path, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.options.workerToken}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
            throw new Error(`master_http_${response.status}: ${(await response.text()).slice(0, 1000)}`);
        }
        return response.json();
    }
}
