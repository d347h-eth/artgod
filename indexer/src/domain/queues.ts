export const QUEUE_NAMES = {
    RealtimeSync: "events-sync-realtime",
    BackfillSync: "events-sync-backfill",
    BlockCheck: "block-check",
    CollectionBootstrap: "collection-bootstrap",
    OffchainOrdersRaw: "offchain-orders-raw",
    OrdersDomain: "orders-domain",
    OrdersUpsert: "orders-upsert",
    OrdersUpdateByMaker: "order-updates-by-maker",
    OrdersUpdateById: "order-updates-by-id",
    MetadataDomain: "metadata-domain",
    MetadataRefresh: "metadata-refresh",
    ActivityDomain: "activity-domain",
    DeadLetter: "dead-letter",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
