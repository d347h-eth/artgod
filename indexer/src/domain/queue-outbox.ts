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

// Required sync follow-ups retry publication until accepted or superseded by
// rollback/purge. Other owners retain their existing finite retry policy.
export const QUEUE_OUTBOX_RETRY_POLICY = {
    Bounded: "bounded",
    Required: "required",
} as const;
export type QueueOutboxRetryPolicy =
    (typeof QUEUE_OUTBOX_RETRY_POLICY)[keyof typeof QUEUE_OUTBOX_RETRY_POLICY];
