/** Shared host/guest wire vocabulary. A completion reports only named guest checks. */
export const QUALIFICATION_PROTOCOL_PREFIX = "ARTGOD_SIMULATION ";
export const SIMULATION_EVIDENCE_PREFIX = "ARTGOD_SIMULATION_EVIDENCE ";
export const QUALIFICATION_PROTOCOL_VERSION = 1;
export const QUALIFICATION_EVENT = Object.freeze({
    Ready: "ready",
    Complete: "complete",
});
export const QUALIFICATION_STATUS = Object.freeze({
    Passed: "passed",
    Failed: "failed",
});
export const QUALIFICATION_CHECKS = Object.freeze([
    "sqlite-wal",
    "sqlite-competing-writers",
    "sqlite-reopen",
    "nats-persistent-restart",
    "nats-redelivery-after-commit",
    "guest-entropy-clock",
]);
export const DATA_PLANE_CHECKS = Object.freeze([
    "runtime-entrypoints",
    "chain-acquisition",
    "source-ingestion",
    "order-validation",
    "http-projection",
    "reorg-recovery",
    "provider-disagreement-detected",
]);
