// A REST scan can last several minutes. Renew within the ACK deadline while
// preserving serial collection processing and prompt crash redelivery.
export const OPENSEA_RECONCILE_WORKER_POLICY = {
    maxInFlight: 1,
    ackWaitMs: 30_000,
    extendLeaseMs: 10_000,
} as const;
