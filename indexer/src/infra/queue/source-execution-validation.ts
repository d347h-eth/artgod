import type { SourceExecutionValidationPort } from "../../application/orders/execution-block.js";
import {
    ORDER_JOB_KIND,
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
} from "../../domain/order-jobs.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import type { QueuePort } from "../../ports/queue.js";

/** A separate publication keeps receipt RPC off order-lifecycle-updates. Retrying
 * the source delivery republishes the same job identity until publication succeeds. */
export class QueuedSourceExecutionValidation implements SourceExecutionValidationPort {
    constructor(private readonly queue: Pick<QueuePort, "publish">) {}

    async request(
        input: Parameters<SourceExecutionValidationPort["request"]>[0],
    ) {
        const { chainId, orderId, transactionHash, requiredAt } = input;
        const reason = ORDER_UPDATE_REASON.SourceExecutionValidation;
        await this.queue.publish<OrderUpdateByIdPayload>(
            QUEUE_NAMES.OrdersUpdateById,
            {
                jobId: `${reason}:${chainId}:${orderId}:${transactionHash.toLowerCase()}:${requiredAt}`,
                kind: ORDER_JOB_KIND.UpdateById,
                queue: QUEUE_NAMES.OrdersUpdateById,
                chainId,
                // Source time identifies retries, but must not delay receipt work
                // when the marketplace clock is ahead of the local clock.
                scheduledAt: Date.now(),
                attempt: 0,
                payload: {
                    chainId,
                    orderId,
                    reason,
                    executionTransactionHash: transactionHash,
                },
            },
        );
    }
}
