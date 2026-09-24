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
    validationHints: number;
    terminalFacts: number;
    elapsedMs: number;
    cpuMs: number;
    sqliteAdmissionMs: number;
    maximumValidations: number;
    reads: Record<string, number>;
    pending: number;
    demandRows: number;
    oldestDemandAgeMs: number;
    maximumTerminalAgeMs: number;
    allocatedBytes: number;
    outboxRows: number;
    maximumRssKiB: number;
};
