import type { ChainSyncCheckpoint } from "../../domain/chain-sync.js";
import {
    ORDER_EXECUTION_LOG,
    type OrderExecutionBlockPort,
    type SourceExecutionValidationPort,
} from "./execution-block.js";
import { tryParseHash } from "@artgod/shared/offchain/normalizer-utils";
import { logger } from "@artgod/shared/utils";
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
            executionValidation: SourceExecutionValidationPort;
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
        const queue = orderUpdateQueue(payload);
        if (
            payload.sourceStatus == null &&
            payload.reason === ORDER_UPDATE_REASON.SourceExecution
        ) {
            if (
                !this.deps.lifecycle.applySourceExecution(payload)
                    .validationNeeded
            )
                return;
            if (
                !this.deps.validation.needsValidation(
                    observedOrderValidationRequest(
                        payload.chainId,
                        payload.orderId,
                        requiredAt,
                    ),
                )
            )
                return;
            const transactionHash = this.executionHash(payload);
            if (!transactionHash) return;
            // Await broker persistence before ACK. Partial classification changes no
            // order state, so a failed publication safely retries this source delivery.
            await this.deps.executionValidation.request({
                chainId: payload.chainId,
                orderId: payload.orderId,
                transactionHash,
                requiredAt,
            });
            return;
        }
        if (queue === QUEUE_NAMES.OrdersUpdateById) {
            let request = observedOrderValidationRequest(
                payload.chainId,
                payload.orderId,
                requiredAt,
            );
            let checkpoint: ChainSyncCheckpoint | undefined;
            if (
                payload.reason === ORDER_UPDATE_REASON.SourceExecutionValidation
            ) {
                // No receipt dependency remains for a terminal/source-ineligible order.
                // Admission rechecks eligibility after RPC, so cancellation still wins.
                if (!this.deps.validation.needsValidation(request)) return;
                const executionHash = this.executionHash(payload);
                if (!executionHash) return;
                checkpoint = this.deps.validation.captureSyncCheckpoint();
                // Local observation time cannot prove source execution inclusion. RPC
                // stays outside the writer; failure retains the original delivery.
                const block = await this.resolveExecutionBlock(executionHash);
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
    private executionHash(payload: OrderUpdateByIdPayload): string | null {
        const hash = tryParseHash(payload.executionTransactionHash);
        if (!hash)
            logger.warn(ORDER_EXECUTION_LOG.MissingTransactionHash, {
                component: ORDER_EXECUTION_LOG.Component,
                chainId: payload.chainId,
                orderId: payload.orderId,
            });
        return hash;
    }
    private resolveExecutionBlock(hash: string): Promise<number> {
        if (!this.deps.executionBlock)
            throw new Error(
                "Source execution requires canonical transaction coverage",
            );
        return this.deps.executionBlock.resolve(hash);
    }
}
