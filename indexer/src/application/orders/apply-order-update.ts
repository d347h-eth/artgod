import type { OrderUpdateByIdPayload } from "../../domain/order-jobs.js";
import { orderUpdateQueue } from "../../domain/order-processing.js";
import type { OrdersDomainPort } from "../../ports/domain-handlers.js";
import { observeProcessing } from "../processing-observability.js";
import {
    ORDER_PROCESSING_OPERATION as OPERATION,
    type OrderProcessingObservability,
} from "./observability.js";

/** A delivery is complete only after the source owner has atomically retained
 * its observation and any ordinary validation demand. No receipt RPC is required. */
export class ApplyOrderUpdate {
    constructor(
        private readonly deps: {
            chainId: number;
            lifecycle: Pick<OrdersDomainPort, "handleOrderUpdateById">;
            observability?: OrderProcessingObservability;
        },
    ) {}

    async execute(payload: OrderUpdateByIdPayload): Promise<void> {
        if (payload.chainId !== this.deps.chainId || !payload.orderId)
            throw new Error("Invalid order update identity");
        // Share source vocabulary validation with the offchain publisher.
        orderUpdateQueue(payload);
        await observeProcessing(
            this.deps.observability,
            OPERATION.Lifecycle,
            { chainId: payload.chainId },
            () => this.deps.lifecycle.handleOrderUpdateById(payload),
        );
    }
}
