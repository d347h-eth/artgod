/** Request-local progress for public resource fetches. Headers/bodies are excluded. */
export const HTTP_FETCH_PHASE = {
    Request: "request",
    Response: "response",
    Retry: "retry",
    Failure: "failure",
} as const;
export type HttpFetchObservation = {
    phase: (typeof HTTP_FETCH_PHASE)[keyof typeof HTTP_FETCH_PHASE];
    url: string;
    attempt: number;
    maxAttempts: number;
    status?: number;
    delayMs?: number;
    reason?: string;
};
export type HttpFetchObserver = (event: HttpFetchObservation) => void;
