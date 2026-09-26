import { redactSecrets } from '../core/vone_secret_redaction';
import {
    CONTRACT_HEADER,
    ContractViolationError,
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
 * MasterTransport over HTTP+JSON using the PROPOSED paths from
 * vone_execution_contract.ts (unverified against the real Master).
 *
 * This is the only component that ever calls credential.reveal(), and only
 * to build the Authorization header. Every error message it produces is
 * built from the HTTP status plus a truncated, redactSecrets()-filtered
 * response body, plus a literal scrub of the token itself - so a Master
 * that echoes the header back still cannot leak it through an error.
 *
 * A result rejection is not an error: HTTP 409 with a JSON ResultAck body
 * is returned as `{accepted:false, reason}` so the worker can handle
 * ownership/lease rejections without treating them as retryable failures.
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
        const { body } = await this.post(PROPOSED_HTTP_PATHS.heartbeat, request, []);
        return this.parse(() => parseHeartbeatResponse(body));
    }

    public async claim(request: ClaimRequest): Promise<ClaimResponse> {
        const { status, body } = await this.post(PROPOSED_HTTP_PATHS.claim, request, [204]);
        if (status === 204) return { contract: EXECUTION_CONTRACT_VERSION, job: null };
        return this.parse(() => parseClaimResponse(body));
    }

    public async submitResult(submission: ResultSubmission): Promise<ResultAck> {
        const { body } = await this.post(PROPOSED_HTTP_PATHS.result, submission, [409]);
        return this.parse(() => parseResultAck(body));
    }

    private parse<T>(fn: () => T): T {
        try {
            return fn();
        } catch (error) {
            if (error instanceof ContractViolationError) {
                throw new TransportError(this.scrub(error.message), 'protocol', false);
            }
            throw error;
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
                    [CONTRACT_HEADER]: EXECUTION_CONTRACT_VERSION,
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
        if (status === 204 && passThroughStatuses.includes(204)) {
            return { status, body: null };
        }

        let text = '';
        try {
            text = await response.text();
        } catch (error) {
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
