import { TOKEN_IMAGE_CACHE_QUEUE_NAME } from "@artgod/shared/media/token-image-cache-jobs";

export const QUEUE_NAMES = {
    RealtimeSync: "events-sync-realtime",
    BackfillSync: "events-sync-backfill",
    BlockCheck: "block-check",
    CollectionBootstrap: "collection-bootstrap",
    OpenSeaBootstrap: "opensea-bootstrap",
    OpenSeaReconcile: "opensea-reconcile",
    OffchainOrdersRaw: "offchain-orders-raw",
    OrdersDomain: "orders-domain",
    OrdersUpsert: "orders-upsert",
    OrdersUpdateByMaker: "order-updates-by-maker",
    OrdersUpdateById: "order-updates-by-id",
    ActivityUpsert: "activity-upsert",
    CollectionExtensionArtifacts: "collection-extension-artifacts",
    TokenImageCache: TOKEN_IMAGE_CACHE_QUEUE_NAME,
    MetadataDomain: "metadata-domain",
    MetadataRefresh: "metadata-refresh",
    MetadataStats: "metadata-stats",
    ActivityDomain: "activity-domain",
    DeadLetter: "dead-letter",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
