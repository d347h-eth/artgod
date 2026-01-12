export const QUEUE_NAMES = {
    RealtimeSync: "events-sync-realtime",
    BackfillSync: "events-sync-backfill",
    BlockCheck: "block-check",
    OrdersDomain: "orders-domain",
    MetadataDomain: "metadata-domain",
    ActivityDomain: "activity-domain",
    DeadLetter: "dead-letter",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
