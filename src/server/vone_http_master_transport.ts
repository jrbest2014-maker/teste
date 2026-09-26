import { redactSecrets } from '../core/vone_secret_redaction';
import {
    R1_HTTP_PATHS,
    TransportError,
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
    type ResultAck,
    type ResultSubmission,
} from './vone_execution_contract';
import type { WorkerCredential } from './vone_worker_config';

export interface HttpMasterTransportOptions {
    readonly baseUrl: string;
    readonly credential: WorkerCredential;
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
}

const MAX_ERROR_BODY = 200;

/**
 * MasterTransport for the Master's VONE_WORKER_IDENTITY_R1 worker API
 * (`/api/worker/{heartbeat,claim,result}`, `Authorization: Bearer <token>`).
 * All wire shapes and their validation live in vone_execution_contract.ts.
 *
 * This is the only component that ever calls credential.reveal(), and only
 * to build the Authorization header. Every error message it produces is
 * built from the HTTP status plus a truncated, redactSecrets()-filtered
 * response body, plus a literal scrub of the token itself - so a Master
 * that echoes the header back still cannot leak it through an error.
 *
 * HTTP 409 on /result is not an error: it is the Master's ownership
 * rejection and is returned as `{accepted:false}` so the worker records it
 * without retrying or re-executing. A response that does not prove
 * IDENTITY_R1 surfaces as an auth failure, which stops the worker.
 */
export class HttpMasterTransport implements MasterTransport {
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;

    constructor(private readonly options: HttpMasterTransportOptions) {
        if (!options.credential || options.credential.present !== true) {
            throw new TransportError('no worker credential configured (fail-closed)', 'auth', false);
        }
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.timeoutMs = options.timeoutMs ?? 15000;
    }

    public async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
        const { body } = await this.post(R1_HTTP_PATHS.heartbeat, heartbeatToWire(request), []);
        return this.parse(() => parseR1HeartbeatResponse(body, request.worker_id));
    }

    public async claim(request: ClaimRequest): Promise<ClaimResponse> {
        const { body } = await this.post(R1_HTTP_PATHS.claim, claimToWire(request), []);
        return this.parse(() => parseR1ClaimResponse(body, request.worker_id));
    }

    public async submitResult(submission: ResultSubmission): Promise<ResultAck> {
        const wire = resultToWire(submission);
        const payload = 'error' in wire ? { ...wire, error: this.scrub(wire.error) } : wire;
        const { status, body } = await this.post(R1_HTTP_PATHS.result, payload, [409]);
        return this.parse(() => parseR1ResultResponse(status, body, submission.job_id));
    }

    private parse<T>(fn: () => T): T {
        try {
            return fn();
        } catch (error) {
            throw contractErrorToTransportError(error, (message) => this.scrub(message));
        }
    }

    private async post(
        path: string,
        payload: unknown,
        passThroughStatuses: readonly number[],
    ): Promise<{ status: number; body: unknown }> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response: Response;
        try {
            response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.options.credential.reveal()}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
        } catch (error) {
            const aborted = controller.signal.aborted;
            const message = error instanceof Error ? error.message : String(error);
            throw new TransportError(
                this.scrub(aborted ? `request to ${path} timed out after ${this.timeoutMs}ms` : `${path}: ${message}`),
                aborted ? 'timeout' : 'network',
                true,
            );
        } finally {
            clearTimeout(timer);
        }

        const status = response.status;
        let text = '';
        try {
            text = await response.text();
        } catch {
            throw new TransportError(this.scrub(`${path}: failed reading body`), 'network', true, status);
        }

        if (status === 401 || status === 403) {
            throw new TransportError(`${path}: HTTP ${status} - credential rejected by Master`, 'auth', false, status);
        }

        if (!response.ok && !passThroughStatuses.includes(status)) {
            throw new TransportError(
                this.scrub(`${path}: HTTP ${status} ${text.slice(0, MAX_ERROR_BODY)}`),
                'http',
                status >= 500 || status === 429,
                status,
            );
        }

        try {
            return { status, body: text.length ? JSON.parse(text) : null };
        } catch {
            throw new TransportError(`${path}: HTTP ${status} with a non-JSON body`, 'protocol', false, status);
        }
    }

    private scrub(message: string): string {
        const token = this.options.credential.reveal();
        const literal = token.length > 0 ? message.split(token).join('[REDACTED]') : message;
        return redactSecrets(literal);
    }
}
