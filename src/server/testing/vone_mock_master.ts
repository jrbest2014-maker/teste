import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    R1_HTTP_PATHS,
    R1_NOT_OWNED_ERROR,
    TransportError,
    WORKER_AUTH_MARKER,
    claimToWire,
    contractErrorToTransportError,
    heartbeatToWire,
    parseR1ClaimResponse,
    parseR1HeartbeatResponse,
    parseR1ResultResponse,
    resultToWire,
    type ClaimRequest,
    type ClaimResponse,
    type HeartbeatRequest,
    type HeartbeatResponse,
    type MasterTransport,
    type R1ClaimBody,
    type R1HeartbeatBody,
    type R1ResultBody,
    type ResultAck,
    type ResultSubmission,
} from '../vone_execution_contract';

/**
 * LOCAL MOCK of the V-ONE Master's VONE_WORKER_IDENTITY_R1 worker API, for
 * tests only. It speaks the R1 wire exactly as specified (bodies, responses,
 * the single 409 rejection) and models only what that spec states: a job is
 * owned by whoever claimed it, and a result is accepted only from the owner
 * of a job that is still CLAIMED. It never makes network calls beyond
 * binding a loopback port in startMockMasterServer().
 */

export interface MockJobSpec {
    readonly id: string;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
}

interface MockJob {
    readonly spec: MockJobSpec;
    readonly createdAt: string;
    state: 'QUEUED' | 'CLAIMED' | 'DONE';
    owner: string | null;
}

export interface MockResponse {
    readonly status: number;
    readonly body: unknown;
}

export type MockRoute = 'heartbeat' | 'claim' | 'result';

export class MockMaster {
    public readonly heartbeats: R1HeartbeatBody[] = [];
    public readonly claims: R1ClaimBody[] = [];
    public readonly acceptedResults: R1ResultBody[] = [];
    public readonly rejectedResults: R1ResultBody[] = [];
    public authFailures = 0;
    public generation = 0;

    private readonly jobs = new Map<string, MockJob>();
    private readonly order: string[] = [];
    private readonly overrides = new Map<MockRoute, MockResponse>();

    constructor(private readonly options: { readonly expectedToken: string }) {}

    // ---- test controls ---------------------------------------------------

    public enqueue(spec: MockJobSpec): void {
        this.jobs.set(spec.id, { spec, createdAt: new Date(0).toISOString(), state: 'QUEUED', owner: null });
        this.order.push(spec.id);
    }

    /** The Master puts the same job id back in the queue (re-delivery / takeover by another worker). */
    public requeue(jobId: string): void {
        const job = this.mustGet(jobId);
        job.state = 'QUEUED';
        job.owner = null;
        this.order.push(jobId);
    }

    /** The next response on `route` is `response` instead of the normal one (authorized requests only). */
    public overrideNext(route: MockRoute, response: MockResponse): void {
        this.overrides.set(route, response);
    }

    public jobState(jobId: string): { state: string; owner: string | null } {
        const job = this.mustGet(jobId);
        return { state: job.state, owner: job.owner };
    }

    // ---- R1 handlers (shared by the in-process and HTTP transports) -----

    public handleHeartbeat(token: string | null, body: R1HeartbeatBody): MockResponse {
        if (!this.authorized(token)) return { status: 401, body: { ok: false, error: 'unauthorized' } };
        this.heartbeats.push(body);
        this.generation += 1;
        return this.takeOverride('heartbeat') ?? {
            status: 200,
            body: { ok: true, workerId: body.workerId, auth: WORKER_AUTH_MARKER, generation: this.generation },
        };
    }

    public handleClaim(token: string | null, body: R1ClaimBody): MockResponse {
        if (!this.authorized(token)) return { status: 401, body: { ok: false, error: 'unauthorized' } };
        this.claims.push(body);
        const override = this.takeOverride('claim');
        if (override) return override;

        const index = this.order.findIndex((jobId) => this.jobs.get(jobId)?.state === 'QUEUED');
        if (index < 0) return { status: 200, body: { ok: true, job: null } };
        const job = this.mustGet(this.order[index]);
        this.order.splice(index, 1);
        job.state = 'CLAIMED';
        job.owner = body.workerId;
        return {
            status: 200,
            body: {
                ok: true,
                job: { id: job.spec.id, toolName: job.spec.toolName, args: job.spec.args, createdAt: job.createdAt },
                auth: WORKER_AUTH_MARKER,
            },
        };
    }

    public handleResult(token: string | null, body: R1ResultBody): MockResponse {
        if (!this.authorized(token)) return { status: 401, body: { ok: false, error: 'unauthorized' } };
        const override = this.takeOverride('result');
        if (override) return override;

        const job = this.jobs.get(body.jobId);
        if (!job || job.state !== 'CLAIMED' || job.owner !== body.workerId) {
            this.rejectedResults.push(body);
            return { status: 409, body: { ok: false, error: R1_NOT_OWNED_ERROR } };
        }
        job.state = 'DONE';
        this.acceptedResults.push(body);
        return { status: 200, body: { ok: true, jobId: body.jobId, auth: WORKER_AUTH_MARKER } };
    }

    private takeOverride(route: MockRoute): MockResponse | undefined {
        const override = this.overrides.get(route);
        this.overrides.delete(route);
        return override;
    }

    private authorized(token: string | null): boolean {
        const ok = token !== null && token.length > 0 && token === this.options.expectedToken;
        if (!ok) this.authFailures += 1;
        return ok;
    }

    private mustGet(jobId: string): MockJob {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error(`mock master: unknown job ${jobId}`);
        return job;
    }
}

/**
 * In-process MasterTransport over a MockMaster. It uses the same R1
 * adapters and parsers as HttpMasterTransport and JSON round-trips every
 * message, so it exercises the real wire shapes minus the socket.
 * Fault injection: `offline` (every call fails as a retryable network
 * error), `failNextSubmits` (submit fails before reaching the Master) and
 * `dropNextAcks` (the Master applies the result but the ack is lost).
 */
export class InProcessMasterTransport implements MasterTransport {
    public offline = false;
    public failNextSubmits = 0;
    public dropNextAcks = 0;
    public readonly calls = { heartbeat: 0, claim: 0, submitResult: 0 };

    constructor(
        private readonly master: MockMaster,
        private readonly token: string | null,
    ) {}

    public async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
        this.calls.heartbeat += 1;
        this.guardOnline();
        const response = this.master.handleHeartbeat(this.token, roundTrip(heartbeatToWire(request)));
        return parseOrThrow(() => parseR1HeartbeatResponse(this.unwrap(response), request.worker_id));
    }

    public async claim(request: ClaimRequest): Promise<ClaimResponse> {
        this.calls.claim += 1;
        this.guardOnline();
        const response = this.master.handleClaim(this.token, roundTrip(claimToWire(request)));
        return parseOrThrow(() => parseR1ClaimResponse(this.unwrap(response), request.worker_id));
    }

    public async submitResult(submission: ResultSubmission): Promise<ResultAck> {
        this.calls.submitResult += 1;
        this.guardOnline();
        if (this.failNextSubmits > 0) {
            this.failNextSubmits -= 1;
            throw new TransportError('connection reset before request was sent', 'network', true);
        }
        const response = this.master.handleResult(this.token, roundTrip(resultToWire(submission)));
        if (this.dropNextAcks > 0) {
            this.dropNextAcks -= 1;
            throw new TransportError('connection reset while reading ack', 'network', true);
        }
        return parseOrThrow(() => parseR1ResultResponse(response.status, this.unwrap(response, [409]), submission.job_id));
    }

    private guardOnline(): void {
        if (this.offline) throw new TransportError('ECONNREFUSED (mock offline)', 'network', true);
    }

    private unwrap(response: MockResponse, passThrough: number[] = []): unknown {
        if (response.status === 401 || response.status === 403) {
            throw new TransportError(`HTTP ${response.status} - credential rejected by Master`, 'auth', false, response.status);
        }
        if (response.status >= 400 && !passThrough.includes(response.status)) {
            throw new TransportError(`HTTP ${response.status}`, 'http', response.status >= 500, response.status);
        }
        return roundTrip(response.body);
    }
}

function parseOrThrow<T>(fn: () => T): T {
    try {
        return fn();
    } catch (error) {
        throw contractErrorToTransportError(error);
    }
}

function roundTrip<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export interface MockMasterServer {
    readonly url: string;
    readonly port: number;
    /** Hard stop: closes the listener and drops every open connection. */
    close(): Promise<void>;
    readonly requests: { count: number; paths: string[]; legacyContractHeader: number };
}

/** Real HTTP server for MockMaster on the R1 paths, bound to 127.0.0.1 only. */
export async function startMockMasterServer(master: MockMaster, port = 0): Promise<MockMasterServer> {
    const requests = { count: 0, paths: [] as string[], legacyContractHeader: 0 };
    const server = http.createServer((req, res) => {
        requests.count += 1;
        requests.paths.push(req.url ?? '');
        if (req.headers['x-vone-contract'] !== undefined) requests.legacyContractHeader += 1;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const send = (response: MockResponse): void => {
                res.writeHead(response.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response.body));
            };
            if (req.method !== 'POST') return send({ status: 405, body: { ok: false, error: 'method' } });
            const auth = req.headers.authorization;
            const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
            let body: unknown;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                return send({ status: 400, body: { ok: false, error: 'json' } });
            }
            switch (req.url) {
                case R1_HTTP_PATHS.heartbeat:
                    return send(master.handleHeartbeat(token, body as R1HeartbeatBody));
                case R1_HTTP_PATHS.claim:
                    return send(master.handleClaim(token, body as R1ClaimBody));
                case R1_HTTP_PATHS.result:
                    return send(master.handleResult(token, body as R1ResultBody));
                default:
                    return send({ status: 404, body: { ok: false, error: 'not found' } });
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requests,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };
}
