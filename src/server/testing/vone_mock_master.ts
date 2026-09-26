import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
    CONTRACT_HEADER,
    EXECUTION_CONTRACT_VERSION,
    PROPOSED_HTTP_PATHS,
    TransportError,
    parseClaimResponse,
    parseHeartbeatResponse,
    parseResultAck,
    type ClaimRequest,
    type ClaimResponse,
    type HeartbeatRequest,
    type HeartbeatResponse,
    type JobEnvelope,
    type MasterTransport,
    type ResultAck,
    type ResultRejectionReason,
    type ResultSubmission,
} from '../vone_execution_contract';

/**
 * LOCAL MOCK of the V-ONE Master for tests only. It implements the PROPOSED
 * wire format from vone_execution_contract.ts - it is not evidence of how
 * the real Master behaves. It never makes network calls beyond binding a
 * loopback port in startMockMasterServer().
 *
 * Ownership rules it enforces on results: the job must exist, the submitting
 * worker must be the current lease owner (WRONG_WORKER otherwise), the lease
 * id must match (LEASE_MISMATCH) and the lease must not have expired
 * (LEASE_EXPIRED). A second submission of an already accepted result by the
 * same owner/lease is acknowledged as a duplicate, not re-applied.
 */

export interface MockJobSpec {
    readonly job_id: string;
    readonly task_id: string;
    readonly idempotency_key: string;
    readonly capability: string;
    readonly payload: Record<string, unknown>;
}

interface MockJob {
    spec: MockJobSpec;
    state: 'QUEUED' | 'CLAIMED' | 'DONE';
    owner: string | null;
    lease_id: string | null;
    lease_expires_at: number;
    accepted: ResultSubmission | null;
}

export interface MockResponse {
    readonly status: number;
    readonly body: unknown;
}

export interface MockMasterOptions {
    readonly expectedToken: string;
    readonly leaseMs?: number;
    readonly now?: () => number;
}

export class MockMaster {
    public readonly heartbeats: HeartbeatRequest[] = [];
    public readonly claims: ClaimRequest[] = [];
    public readonly acceptedResults: ResultSubmission[] = [];
    public readonly duplicateResults: ResultSubmission[] = [];
    public readonly rejectedResults: Array<{ submission: ResultSubmission; reason: ResultRejectionReason }> = [];
    public authFailures = 0;
    public checkpointRevision = 0;

    private readonly jobs = new Map<string, MockJob>();
    private readonly order: string[] = [];
    private readonly leaseMs: number;
    private readonly now: () => number;
    private forcedOwner: string | null = null;
    private malformedNextClaim = false;

    constructor(private readonly options: MockMasterOptions) {
        this.leaseMs = options.leaseMs ?? 60_000;
        this.now = options.now ?? Date.now;
    }

    // ---- test controls ---------------------------------------------------

    public enqueue(spec: MockJobSpec): void {
        this.jobs.set(spec.job_id, {
            spec,
            state: 'QUEUED',
            owner: null,
            lease_id: null,
            lease_expires_at: 0,
            accepted: null,
        });
        this.order.push(spec.job_id);
    }

    /** Lease runs out: the job becomes claimable by anyone (owner kept until re-claimed). */
    public expireLease(jobId: string): void {
        const job = this.mustGet(jobId);
        job.lease_expires_at = this.now() - 1;
    }

    /** Master-side retry: hand the same job (same idempotency_key) out again under a new lease. */
    public redeliver(jobId: string): void {
        const job = this.mustGet(jobId);
        job.state = 'QUEUED';
        job.owner = null;
        job.lease_id = null;
        job.lease_expires_at = 0;
        this.order.push(jobId);
    }

    /** Next claim response names this worker_id as owner, whoever asked (buggy-Master simulation). */
    public forceNextClaimOwner(workerId: string): void {
        this.forcedOwner = workerId;
    }

    public returnMalformedNextClaim(): void {
        this.malformedNextClaim = true;
    }

    public jobState(jobId: string): { state: string; owner: string | null } {
        const job = this.mustGet(jobId);
        return { state: job.state, owner: job.owner };
    }

    // ---- protocol handlers (shared by in-process and HTTP transports) ---

    public handleHeartbeat(token: string | null, request: HeartbeatRequest): MockResponse {
        if (!this.authorized(token)) return { status: 401, body: { error: 'unauthorized' } };
        this.heartbeats.push(request);
        return { status: 200, body: { ok: true } };
    }

    public handleClaim(token: string | null, request: ClaimRequest): MockResponse {
        if (!this.authorized(token)) return { status: 401, body: { error: 'unauthorized' } };
        if (request.contract !== EXECUTION_CONTRACT_VERSION) {
            return { status: 400, body: { error: 'contract mismatch' } };
        }
        this.claims.push(request);

        if (this.malformedNextClaim) {
            this.malformedNextClaim = false;
            return { status: 200, body: { contract: EXECUTION_CONTRACT_VERSION, job: { job_id: 'broken' } } };
        }

        const now = this.now();
        let job: MockJob | undefined;
        const queuedIndex = this.order.findIndex((jobId) => this.jobs.get(jobId)?.state === 'QUEUED');
        if (queuedIndex >= 0) {
            job = this.jobs.get(this.order[queuedIndex]);
            this.order.splice(queuedIndex, 1);
        } else {
            // A lease that ran out makes the job claimable again by anyone.
            job = [...this.jobs.values()].find((candidate) => candidate.state === 'CLAIMED' && candidate.lease_expires_at <= now);
        }
        if (job) {
            job.state = 'CLAIMED';
            job.owner = this.forcedOwner ?? request.worker_id;
            this.forcedOwner = null;
            job.lease_id = randomUUID();
            job.lease_expires_at = now + this.leaseMs;
            const envelope: JobEnvelope = {
                job_id: job.spec.job_id,
                task_id: job.spec.task_id,
                idempotency_key: job.spec.idempotency_key,
                capability: job.spec.capability,
                worker_id: job.owner,
                lease_id: job.lease_id,
                lease_expires_at: job.lease_expires_at,
                payload: job.spec.payload,
            };
            return { status: 200, body: { contract: EXECUTION_CONTRACT_VERSION, job: envelope } };
        }
        return { status: 200, body: { contract: EXECUTION_CONTRACT_VERSION, job: null } };
    }

    public handleResult(token: string | null, submission: ResultSubmission): MockResponse {
        if (!this.authorized(token)) return { status: 401, body: { error: 'unauthorized' } };

        const reject = (reason: ResultRejectionReason): MockResponse => {
            this.rejectedResults.push({ submission, reason });
            return { status: 409, body: { accepted: false, reason } };
        };

        if (submission.contract !== EXECUTION_CONTRACT_VERSION) return reject('CONTRACT_MISMATCH');
        const job = this.jobs.get(submission.job_id);
        if (!job) return reject('UNKNOWN_JOB');
        if (job.owner !== submission.worker_id) return reject('WRONG_WORKER');
        if (job.lease_id !== submission.lease_id) return reject('LEASE_MISMATCH');

        if (job.state === 'DONE' && job.accepted) {
            this.duplicateResults.push(submission);
            return { status: 200, body: { accepted: true, duplicate: true, checkpoint_revision: this.checkpointRevision } };
        }
        if (job.lease_expires_at <= this.now()) return reject('LEASE_EXPIRED');
        if (submission.idempotency_key !== job.spec.idempotency_key) return reject('LEASE_MISMATCH');

        job.state = 'DONE';
        job.accepted = submission;
        this.checkpointRevision += 1;
        this.acceptedResults.push(submission);
        return { status: 200, body: { accepted: true, checkpoint_revision: this.checkpointRevision } };
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
 * In-process MasterTransport over a MockMaster. Every message is JSON
 * round-tripped and re-parsed with the contract parsers, like the HTTP path.
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
        const response = this.master.handleHeartbeat(this.token, roundTrip(request));
        return parseHeartbeatResponse(this.unwrap(response));
    }

    public async claim(request: ClaimRequest): Promise<ClaimResponse> {
        this.calls.claim += 1;
        this.guardOnline();
        const response = this.master.handleClaim(this.token, roundTrip(request));
        const body = this.unwrap(response);
        try {
            return parseClaimResponse(body);
        } catch (error) {
            throw new TransportError(error instanceof Error ? error.message : String(error), 'protocol', false);
        }
    }

    public async submitResult(submission: ResultSubmission): Promise<ResultAck> {
        this.calls.submitResult += 1;
        this.guardOnline();
        if (this.failNextSubmits > 0) {
            this.failNextSubmits -= 1;
            throw new TransportError('connection reset before request was sent', 'network', true);
        }
        const response = this.master.handleResult(this.token, roundTrip(submission));
        if (this.dropNextAcks > 0) {
            this.dropNextAcks -= 1;
            throw new TransportError('connection reset while reading ack', 'network', true);
        }
        return parseResultAck(this.unwrap(response, [409]));
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

function roundTrip<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export interface MockMasterServer {
    readonly url: string;
    readonly port: number;
    /** Hard stop: closes the listener and drops every open connection. */
    close(): Promise<void>;
    readonly requests: { count: number; missingContractHeader: number };
}

/** Real HTTP server for MockMaster, bound to 127.0.0.1 only. */
export async function startMockMasterServer(master: MockMaster, port = 0): Promise<MockMasterServer> {
    const requests = { count: 0, missingContractHeader: 0 };
    const server = http.createServer((req, res) => {
        requests.count += 1;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const send = (response: MockResponse): void => {
                res.writeHead(response.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response.body));
            };
            if (req.method !== 'POST') return send({ status: 405, body: { error: 'method' } });
            if (req.headers[CONTRACT_HEADER.toLowerCase()] !== EXECUTION_CONTRACT_VERSION) {
                requests.missingContractHeader += 1;
                return send({ status: 400, body: { error: 'contract header' } });
            }
            const auth = req.headers.authorization;
            const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
            let body: unknown;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                return send({ status: 400, body: { error: 'json' } });
            }
            switch (req.url) {
                case PROPOSED_HTTP_PATHS.heartbeat:
                    return send(master.handleHeartbeat(token, body as HeartbeatRequest));
                case PROPOSED_HTTP_PATHS.claim:
                    return send(master.handleClaim(token, body as ClaimRequest));
                case PROPOSED_HTTP_PATHS.result:
                    return send(master.handleResult(token, body as ResultSubmission));
                default:
                    return send({ status: 404, body: { error: 'not found' } });
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
