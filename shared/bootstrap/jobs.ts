// Bootstrap queue names are shared by backend publishers and indexer workers.
export const BOOTSTRAP_QUEUE_NAME = {
    CollectionBootstrap: "collection-bootstrap",
} as const;

export type BootstrapQueueName =
    (typeof BOOTSTRAP_QUEUE_NAME)[keyof typeof BOOTSTRAP_QUEUE_NAME];

// Bootstrap job kinds are the durable queue envelope values for bootstrap work.
export const BOOTSTRAP_JOB_KIND = {
    Start: "bootstrap.collection.start",
    MetadataProcess: "bootstrap.collection.metadata-process",
    ImageCacheProcess: "bootstrap.collection.image-cache-process",
    BackfillCheck: "bootstrap.collection.backfill-check",
} as const;

export type BootstrapJobKind =
    (typeof BOOTSTRAP_JOB_KIND)[keyof typeof BOOTSTRAP_JOB_KIND];

// Job id scopes keep bootstrap queue de-duplication ids consistent.
export const BOOTSTRAP_JOB_ID_SCOPE = {
    Start: "bootstrap:start",
    Metadata: "bootstrap:metadata",
    ImageCache: "bootstrap:image-cache",
    BackfillCheck: "bootstrap:check",
} as const;
