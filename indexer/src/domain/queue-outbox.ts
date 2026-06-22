// Queue outbox statuses are persisted by the generic queue publication guard.
export const QUEUE_OUTBOX_STATUS = {
    Pending: "pending",
    Sent: "sent",
    FailedRetry: "failed_retry",
    FailedTerminal: "failed_terminal",
} as const;

// QueueOutboxStatus is the serialized delivery state of one outbox row.
export type QueueOutboxStatus =
    (typeof QUEUE_OUTBOX_STATUS)[keyof typeof QUEUE_OUTBOX_STATUS];
