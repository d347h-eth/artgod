/** Shared host/guest wire vocabulary. A completion reports only named guest checks. */
export const QUALIFICATION_PROTOCOL_PREFIX = "ARTGOD_SIMULATION ";
export const SIMULATION_EVIDENCE_PREFIX = "ARTGOD_SIMULATION_EVIDENCE ";
export const SIMULATION_EVIDENCE_EVENT = Object.freeze({
    Probe: "probe",
    Result: "result",
    Failure: "failure",
    ProcessReady: "processReady",
});
export const QUALIFICATION_PROTOCOL_VERSION = 1;
export const QUALIFICATION_EVENT = Object.freeze({
    Ready: "ready",
    Complete: "complete",
});
export const QUALIFICATION_STATUS = Object.freeze({
    Passed: "passed",
    Failed: "failed",
});
/** Reached-state vocabulary shared by emitted guest evidence and host ledgers. */
export const CHECK_COVERAGE_STATUS = Object.freeze({
    Passed: QUALIFICATION_STATUS.Passed,
    Failed: QUALIFICATION_STATUS.Failed,
    Unreached: "unreached",
});
export const QUALIFICATION_CHECK = Object.freeze({
    SqliteWal: "sqlite-wal",
    SqliteCompetingWriters: "sqlite-competing-writers",
    SqliteReopen: "sqlite-reopen",
    NatsPersistentRestart: "nats-persistent-restart",
    NatsRedeliveryAfterCommit: "nats-redelivery-after-commit",
    GuestEntropyClock: "guest-entropy-clock",
    RuntimeBigInt: "runtime-bigint-known-answers",
    FixtureCrypto: "fixture-crypto-known-answers",
});
export const QUALIFICATION_CHECKS = Object.freeze(
    Object.values(QUALIFICATION_CHECK),
);
export const DATA_PLANE_CHECK = Object.freeze({
    RuntimeEntrypoints: "runtime-entrypoints",
    ChainAcquisition: "chain-acquisition",
    SourceIngestion: "source-ingestion",
    OrderValidation: "order-validation",
    HttpProjection: "http-projection",
    ReorgRecovery: "reorg-recovery",
    ProviderDisagreement: "provider-disagreement-detected",
    ProcessRecovery: "process-recovery",
    StartupMaintenance: "startup-maintenance",
    SafeRefusal: "safe-refusal",
    CollectionBootstrap: "collection-bootstrap",
    StaleResultSafetyCut: "stale-result-safety-cut",
});
export const DATA_PLANE_CHECKS = Object.freeze(Object.values(DATA_PLANE_CHECK));
