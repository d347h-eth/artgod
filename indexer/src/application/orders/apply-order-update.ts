import type { OrderUpdateByIdPayload } from "../../domain/order-jobs.js";
import { orderUpdateQueue } from "../../domain/order-processing.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import type { OrdersDomainPort } from "../../ports/domain-handlers.js";
import type { AdmitOrderValidation } from "./validate-order-demand.js";

/** Both new lifecycle deliveries and the legacy mixed queue use the same semantics. */
export class ApplyOrderUpdate {
    constructor(
        private readonly deps: {
            chainId: number;
            validation: Pick<AdmitOrderValidation, "execute">;
            lifecycle: Pick<OrdersDomainPort, "handleOrderUpdateById">;
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
        } else await this.deps.lifecycle.handleOrderUpdateById(payload);
    }
}
