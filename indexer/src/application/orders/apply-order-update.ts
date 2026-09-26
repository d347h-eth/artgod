import type { OrderUpdateByIdPayload } from "../../domain/order-jobs.js";
import { orderUpdateQueue } from "../../domain/order-processing.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import type { OrdersDomainPort } from "../../ports/domain-handlers.js";
import type { AdmitOrderValidation } from "./validate-order-demand.js";
import { observeProcessing } from "../processing-observability.js";
import {
    ORDER_PROCESSING_OPERATION as OPERATION,
    type OrderProcessingObservability,
} from "./observability.js";

/** Both new lifecycle deliveries and the legacy mixed queue use the same semantics. */
export class ApplyOrderUpdate {
    constructor(
        private readonly deps: {
            chainId: number;
            validation: Pick<AdmitOrderValidation, "execute">;
            lifecycle: Pick<OrdersDomainPort, "handleOrderUpdateById">;
            observability?: OrderProcessingObservability;
        },
    ) {}
    async execute(
        payload: OrderUpdateByIdPayload,
        requiredAt: number,
    ): Promise<void> {
        if (payload.chainId !== this.deps.chainId || !payload.orderId)
            throw new Error("Invalid order update identity");
        if (orderUpdateQueue(payload) === QUEUE_NAMES.OrdersUpdateById) {
            this.deps.validation.execute({
                chainId: payload.chainId,
                orderId: payload.orderId,
                requiredAt,
                minimumBlock: payload.blockNumber ?? null,
            });
        } else
            await observeProcessing(
                this.deps.observability,
                OPERATION.Lifecycle,
                { chainId: payload.chainId },
                () => this.deps.lifecycle.handleOrderUpdateById(payload),
            );
    }
}
