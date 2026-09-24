import {
    MAKER_TRIGGER_SCOPE,
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
    type OrderUpdateByMakerPayload,
} from "./order-jobs.js";
import { ORDER_SOURCE_STATUS } from "./orders.js";
import { QUEUE_NAMES, type QueueName } from "./queues.js";

// Before targeted routing, one maker worker and one by-ID validator could run.
// Preserve that aggregate order-validation capacity across all three paths.
export const ORDER_PROCESSING_POLICY = Object.freeze({
    concurrentValidations: 2,
});

export function makerUpdateQueue(
    payload: OrderUpdateByMakerPayload,
): QueueName {
    return payload.scope === MAKER_TRIGGER_SCOPE.Token
        ? QUEUE_NAMES.OrdersUpdateByToken
        : QUEUE_NAMES.OrdersUpdateByMaker;
}

/** Definitive/source observations never enter coalescible validation demand. */
export function orderUpdateQueue(payload: OrderUpdateByIdPayload): QueueName {
    if (payload.sourceStatus != null) {
        if (
            !Object.values(ORDER_SOURCE_STATUS).some(
                (status) => status === payload.sourceStatus,
            )
        )
            throw new Error("Unsupported order source status");
        return QUEUE_NAMES.OrderLifecycle;
    }
    switch (payload.reason) {
        case ORDER_UPDATE_REASON.Fill:
        case ORDER_UPDATE_REASON.Cancel:
            return QUEUE_NAMES.OrderLifecycle;
        case ORDER_UPDATE_REASON.Validation:
            return QUEUE_NAMES.OrdersUpdateById;
        default:
            throw new Error("Unsupported order update reason");
    }
}

const CONSUMER_PREFIX = {
    [QUEUE_NAMES.OrdersUpdateByMaker]: "orders-update-by-maker",
    [QUEUE_NAMES.OrdersUpdateByToken]: "orders-update-by-token",
    [QUEUE_NAMES.OrdersUpdateById]: "orders-update-by-id",
    [QUEUE_NAMES.OrderLifecycle]: "orders-lifecycle",
} as const;

export function orderConsumerName(queue: QueueName, chainId: number): string {
    if (!(queue in CONSUMER_PREFIX))
        throw new Error("Unsupported order consumer queue");
    return `${CONSUMER_PREFIX[queue as keyof typeof CONSUMER_PREFIX]}-${chainId}`;
}
