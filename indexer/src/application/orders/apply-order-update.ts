import {
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
} from "../../domain/order-jobs.js";
import { orderUpdateQueue } from "../../domain/order-processing.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import type { OrdersDomainPort } from "../../ports/domain-handlers.js";
import type { AdmitOrderValidation } from "./validate-order-demand.js";
import {
    eventValidationRequest,
    observedOrderValidationRequest,
} from "../../domain/order-validation-demand.js";
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
            settlement?: {
                resolve(
                    chainId: number,
                    protocol: string,
                    hash: string,
                ): string[];
                awaitFillProof(
                    chainId: number,
                    id: string,
                    block: number,
                ): void;
            };
            observability?: OrderProcessingObservability;
        },
    ) {}
    async execute(
        payload: OrderUpdateByIdPayload,
        requiredAt: number,
    ): Promise<void> {
        if (payload.chainId !== this.deps.chainId || !payload.orderId)
            throw new Error("Invalid order update identity");
        if (payload.protocolAddress && this.deps.settlement) {
            const ids = this.deps.settlement.resolve(
                payload.chainId,
                payload.protocolAddress,
                payload.orderId,
            );
            if (ids.length) {
                for (const id of ids) {
                    if (
                        payload.reason === ORDER_UPDATE_REASON.Fill &&
                        payload.blockNumber != null
                    ) {
                        // OrderFulfilled may consume only a fraction. Suppress the quote
                        // until the shared order has proof of the remaining quantity.
                        this.deps.settlement.awaitFillProof(
                            payload.chainId,
                            id,
                            payload.blockNumber,
                        );
                        this.deps.validation.execute(
                            eventValidationRequest(
                                payload.chainId,
                                id,
                                payload.blockNumber,
                            ),
                        );
                    } else
                        await this.apply(
                            { ...payload, orderId: id },
                            requiredAt,
                        );
                }
                return;
            }
        }
        return this.apply(payload, requiredAt);
    }

    private async apply(payload: OrderUpdateByIdPayload, requiredAt: number) {
        if (orderUpdateQueue(payload) === QUEUE_NAMES.OrdersUpdateById) {
            this.deps.validation.execute(
                payload.blockNumber == null
                    ? observedOrderValidationRequest(
                          payload.chainId,
                          payload.orderId,
                          requiredAt,
                      )
                    : eventValidationRequest(
                          payload.chainId,
                          payload.orderId,
                          payload.blockNumber,
                      ),
            );
        } else
            await observeProcessing(
                this.deps.observability,
                OPERATION.Lifecycle,
                { chainId: payload.chainId },
                () => this.deps.lifecycle.handleOrderUpdateById(payload),
            );
    }
}
