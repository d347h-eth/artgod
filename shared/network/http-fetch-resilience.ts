// Policy values that configure normal HTTP request retries.
export type HttpFetchRetryPolicy = {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
};

// Groups timeout and retry controls for ordinary HTTP fetches.
export type HttpFetchResilienceConfig = {
    requestTimeoutMs: number;
    retryPolicy: HttpFetchRetryPolicy;
};

// Describes one scheduled retry after a failed normal HTTP attempt.
export type HttpFetchRetryScheduledContext = {
    attempt: number;
    nextAttempt: number;
    delayMs: number;
    error: unknown;
};

export type FetchWithHttpResilienceOptions = {
    input: RequestInfo | URL;
    init?: RequestInit;
    config: HttpFetchResilienceConfig;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    onRetryScheduled?: (context: HttpFetchRetryScheduledContext) => void;
};

const HTTP_FETCH_REQUEST_TIMEOUT_ERROR_MESSAGE = "HTTP request timed out";

// HTTP statuses that are generally transient for idempotent metadata/media fetches.
const HTTP_FETCH_RETRYABLE_STATUS_CODES = new Set([
    408, 425, 429, 500, 502, 503, 504,
]);

// Error raised when a normal HTTP attempt exceeds its request timeout.
export class HttpFetchRequestTimeoutError extends Error {
    constructor(timeoutMs: number, cause?: unknown) {
        super(`${HTTP_FETCH_REQUEST_TIMEOUT_ERROR_MESSAGE} after ${timeoutMs}ms`);
        this.name = "HttpFetchRequestTimeoutError";
        this.cause = cause;
    }
}

// Error raised internally to retry transient HTTP responses.
export class HttpFetchRetryableStatusError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`);
        this.name = "HttpFetchRetryableStatusError";
    }
}

// Fetches an ordinary HTTP resource with timeout and bounded exponential backoff.
export async function fetchWithHttpResilience(
    options: FetchWithHttpResilienceOptions,
): Promise<Response> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const sleep = options.sleep ?? sleepMs;
    const maxAttempts = Math.max(1, options.config.retryPolicy.maxAttempts);
    let attempt = 1;

    for (;;) {
        try {
            const response = await fetchWithHttpRequestTimeout(
                fetchImpl,
                options.input,
                options.init ?? {},
                options.config.requestTimeoutMs,
            );
            if (isRetryableResponse(response)) {
                await response.body?.cancel().catch(() => undefined);
                throw new HttpFetchRetryableStatusError(response.status);
            }
            return response;
        } catch (error) {
            if (
                attempt >= maxAttempts ||
                options.init?.signal?.aborted === true
            ) {
                throw error;
            }
            const delayMs = getHttpFetchRetryDelayMs(
                attempt,
                options.config.retryPolicy,
            );
            options.onRetryScheduled?.({
                attempt,
                nextAttempt: attempt + 1,
                delayMs,
                error,
            });
            await sleep(delayMs);
            attempt += 1;
        }
    }
}

// Fetches one ordinary HTTP attempt with a bounded per-attempt timeout.
export async function fetchWithHttpRequestTimeout(
    fetchImpl: typeof fetch,
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMs: number,
): Promise<Response> {
    if (timeoutMs <= 0) {
        return fetchImpl(input, init);
    }

    const controller = new AbortController();
    const externalSignal = init.signal;
    const abortFromExternalSignal = () => controller.abort();
    if (externalSignal?.aborted) {
        controller.abort();
    } else {
        externalSignal?.addEventListener("abort", abortFromExternalSignal, {
            once: true,
        });
    }

    let didTimeout = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedInit = {
        ...init,
        signal: controller.signal,
    };
    const timeoutPromise = new Promise<Response>((_, reject) => {
        timeout = setTimeout(() => {
            didTimeout = true;
            controller.abort();
            reject(new HttpFetchRequestTimeoutError(timeoutMs));
        }, timeoutMs);
    });
    const fetchPromise = fetchImpl(input, timedInit);

    try {
        return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (error) {
        if (didTimeout && !(error instanceof HttpFetchRequestTimeoutError)) {
            throw new HttpFetchRequestTimeoutError(timeoutMs, error);
        }
        throw error;
    } finally {
        externalSignal?.removeEventListener("abort", abortFromExternalSignal);
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

// Computes bounded exponential backoff for normal HTTP fetch retries.
export function getHttpFetchRetryDelayMs(
    attempt: number,
    policy: HttpFetchRetryPolicy,
): number {
    const exp = Math.max(0, attempt - 1);
    const delay = policy.baseDelayMs * Math.pow(2, exp);
    return Math.min(delay, policy.maxDelayMs);
}

function isRetryableResponse(response: Response): boolean {
    return HTTP_FETCH_RETRYABLE_STATUS_CODES.has(response.status);
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
