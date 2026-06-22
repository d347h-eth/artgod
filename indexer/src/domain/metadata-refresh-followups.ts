// Metadata refresh follow-up run statuses guard one final stats enqueue per run.
export const METADATA_REFRESH_RUN_STATUS = {
    Pending: "pending",
    Finalized: "finalized",
} as const;

// MetadataRefreshRunStatus is the serialized lifecycle of a follow-up run.
export type MetadataRefreshRunStatus =
    (typeof METADATA_REFRESH_RUN_STATUS)[keyof typeof METADATA_REFRESH_RUN_STATUS];

// Extension artifact task statuses track terminality for a metadata refresh.
export const METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS = {
    Pending: "pending",
    Succeeded: "succeeded",
    Skipped: "skipped",
    FailedTerminal: "failed_terminal",
} as const;

// MetadataRefreshExtensionArtifactTaskStatus is stored on child artifact tasks.
export type MetadataRefreshExtensionArtifactTaskStatus =
    (typeof METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS)[keyof typeof METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS];

// MetadataRefreshExtensionArtifactTerminalStatus releases one child dependency.
export type MetadataRefreshExtensionArtifactTerminalStatus = Exclude<
    MetadataRefreshExtensionArtifactTaskStatus,
    typeof METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.Pending
>;

// Run id scopes keep persisted refresh guards readable and stable.
export const METADATA_REFRESH_RUN_ID_SCOPE = {
    MetadataSync: "metadata-sync",
    MetadataRefresh: "metadata-refresh",
    MetadataRefreshRange: "metadata-refresh-range",
    BootstrapMetadataSnapshot: "bootstrap-metadata-snapshot",
    Bootstrap: "bootstrap",
} as const;

// MetadataRefreshRunIdScope identifies the workflow that owns a run id.
export type MetadataRefreshRunIdScope =
    (typeof METADATA_REFRESH_RUN_ID_SCOPE)[keyof typeof METADATA_REFRESH_RUN_ID_SCOPE];

// Builds the durable guard id for one collection-scoped refresh follow-up run.
export function buildMetadataRefreshRunId(input: {
    scope: MetadataRefreshRunIdScope;
    chainId: number;
    collectionId: number;
    sourceJobId: string;
}): string {
    return [
        input.scope,
        input.chainId,
        input.collectionId,
        input.sourceJobId,
    ].join(":");
}
