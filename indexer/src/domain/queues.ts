import { TOKEN_IMAGE_CACHE_QUEUE_NAME } from "@artgod/shared/media/token-image-cache-jobs";
import { BOOTSTRAP_QUEUE_NAME } from "@artgod/shared/bootstrap/jobs";
import { OPENSEA_QUEUE_NAME } from "@artgod/shared/offchain/opensea-jobs";

export const QUEUE_NAMES = {
    RealtimeSync: "events-sync-realtime",
    BackfillSync: "events-sync-backfill",
    BlockCheck: "block-check",
    CollectionBootstrap: BOOTSTRAP_QUEUE_NAME.CollectionBootstrap,
    CollectionBootstrapImageCache:
        BOOTSTRAP_QUEUE_NAME.CollectionBootstrapImageCache,
    OpenSeaBootstrap: OPENSEA_QUEUE_NAME.Bootstrap,
    OpenSeaReconcile: OPENSEA_QUEUE_NAME.Reconcile,
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
