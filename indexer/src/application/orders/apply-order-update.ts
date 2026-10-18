import type { ChainSyncCheckpoint } from "../../domain/chain-sync.js";
import type { OrderExecutionBlockPort } from "./execution-block.js";
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
    sourceExecutionValidationRequest,
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
            executionBlock?: OrderExecutionBlockPort;
            validation: Pick<
                AdmitOrderValidation,
                "execute" | "captureSyncCheckpoint" | "needsValidation"
            >;
            lifecycle: Pick<
                OrdersDomainPort,
                "handleOrderUpdateById" | "applySourceExecution"
            >;
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
            if (
                payload.reason === ORDER_UPDATE_REASON.SourceExecution &&
                !this.deps.lifecycle.applySourceExecution(payload)
                    .validationNeeded
            )
                return;
            let request = observedOrderValidationRequest(
                payload.chainId,
                payload.orderId,
                requiredAt,
            );
            let checkpoint: ChainSyncCheckpoint | undefined;
            const executionHash = payload.executionTransactionHash;
            if (payload.reason === ORDER_UPDATE_REASON.SourceExecution) {
                // No receipt dependency remains for a terminal/source-ineligible order.
                // Admission rechecks eligibility after RPC, so cancellation still wins.
                if (!this.deps.validation.needsValidation(request)) return;
                checkpoint = this.deps.validation.captureSyncCheckpoint();
                // Local observation time cannot prove source execution inclusion. RPC
                // stays outside the writer; failure retains the original delivery.
                const block = await this.resolveExecutionBlock(
                    executionHash ?? null,
                );
                request = sourceExecutionValidationRequest(
                    payload.chainId,
                    payload.orderId,
                    block,
                );
            } else if (payload.blockNumber != null) {
                request = eventValidationRequest(
                    payload.chainId,
                    payload.orderId,
                    payload.blockNumber,
                );
            }
            this.deps.validation.execute(request, checkpoint);
        } else
            await observeProcessing(
                this.deps.observability,
                OPERATION.Lifecycle,
                { chainId: payload.chainId },
                () => this.deps.lifecycle.handleOrderUpdateById(payload),
            );
    }
    private resolveExecutionBlock(hash: string | null): Promise<number> {
        if (!hash || !this.deps.executionBlock)
            throw new Error(
                "Source execution requires canonical transaction coverage",
            );
        return this.deps.executionBlock.resolve(hash);
    }
}
