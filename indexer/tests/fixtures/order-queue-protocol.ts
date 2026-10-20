export const QUEUE_FIXTURE_CONSUMER = {
    Maker: "maker-healing-fixture",
    Token: "token-healing-fixture",
} as const;

export const QUEUE_FIXTURE_PHASE = {
    Ready: "ready",
    Held: "held",
    RpcHeld: "rpc-held",
    Complete: "complete",
    Update: "update",
    Progress: "progress",
    Summary: "summary",
} as const;
export const QUEUE_FIXTURE_COMMAND = {
    Stop: "stop",
    ReleaseRpc: "release-rpc",
    Report: "report",
} as const;
export type QueueFixtureProgress = {
    phase: string;
    handled: number;
    sourceRechecks: number;
    sourceLifecycleUpdates: number;
    elapsedMs: number;
    cpuMs: number;
    sqliteAdmissionMs: number;
    maximumValidations: number;
    reads: Record<string, number>;
    pending: number;
    demandRows: number;
    oldestDemandAgeMs: number;
    maximumSourceAgeMs: number;
    allocatedBytes: number;
    outboxRows: number;
    maximumRssKiB: number;
};
