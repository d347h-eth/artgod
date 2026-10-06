export const REORG_FIXTURE_CONSUMER = {
    Reorg: "reorg-recovery-fixture",
    Resync: "resync-recovery-fixture",
} as const;
export const REORG_FIXTURE_ROLE = {
    All: "all",
    Reorg: "reorg",
    Resync: "resync",
    Publisher: "publisher",
    Direct: "direct",
    Writer: "writer",
} as const;
export const REORG_FIXTURE_PHASE = {
    Ready: "ready",
    RpcHeld: "rpc_held",
    FanoutHeld: "fanout_held",
    Checked: "checked",
    Resynced: "resynced",
    Acknowledged: "acknowledged",
    Deferred: "deferred",
    Touch: "touch",
    WriterLocked: "writer_locked",
    WriterReleased: "writer_released",
} as const;
export const REORG_FIXTURE_COMMAND = {
    Stop: "stop",
    ReleaseRpc: "release_rpc",
    Check: "check",
} as const;
export const REORG_FIXTURE_PUBLICATION = {
    Healthy: "healthy",
    Ambiguous: "ambiguous",
    FailMetadata: "fail_metadata",
    HoldMetadata: "hold_metadata",
} as const;
export type ReorgFixtureConfig = {
    dbPath: string;
    natsUrl: string;
    prefix: string;
    role: (typeof REORG_FIXTURE_ROLE)[keyof typeof REORG_FIXTURE_ROLE];
    publication: (typeof REORG_FIXTURE_PUBLICATION)[keyof typeof REORG_FIXTURE_PUBLICATION];
    retryDelayMs: number;
    ackWaitMs: number;
    extendLeaseMs: number;
    publish: boolean;
    resume: boolean;
    holdOwner?: boolean;
    ownerDelayMs?: number;
    dropAckOnce?: boolean;
    sqliteBusyTimeoutMs?: number;
    writerHoldMs?: number;
};
export type ReorgFixtureReport = {
    phase: (typeof REORG_FIXTURE_PHASE)[keyof typeof REORG_FIXTURE_PHASE];
    jobId?: string;
    attempt?: number;
    completed?: boolean;
    elapsedMs?: number;
    revision?: number;
    ownerReads?: number;
    rssBytes?: number;
};
