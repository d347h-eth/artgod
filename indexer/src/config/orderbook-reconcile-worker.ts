// A REST scan can last several minutes. Renew within the ACK deadline while
// preserving serial collection processing and prompt crash redelivery.
export const ORDERBOOK_RECONCILE_WORKER_POLICY = {
    maxInFlight: 1,
    ackWaitMs: 30_000,
    extendLeaseMs: 10_000,
} as const;

// Dispatch and browser startup happen after a tick. Check due times within a
// minute so this delay cannot push a read out by another full venue interval.
export const ORDERBOOK_SCHEDULER_POLL_MS = 60_000;
