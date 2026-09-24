import { randomUUID } from "node:crypto";
import { logger } from "@artgod/shared/utils";
import {
    ORDER_VALIDATION_DEMAND_POLICY as POLICY,
    type OrderValidationRequest,
} from "../../domain/order-validation-demand.js";
import type { OrderValidationDemandPort } from "../../ports/order-validation-demand.js";
import type { OrderValidationSnapshotFactory } from "../../ports/order-validation.js";

export class AdmitOrderValidation {
    constructor(
        private readonly chainId: number,
        private readonly store: OrderValidationDemandPort,
    ) {}
    execute(request: OrderValidationRequest) {
        if (request.chainId !== this.chainId)
            throw new Error("Order validation demand chain mismatch");
        return this.store.admit(request, Date.now());
    }
}

/** Polling persisted demand is also restart recovery; no publish/ACK gap owns liveness. */
export class ValidateOrderDemand {
    constructor(
        private readonly deps: {
            chainId: number;
            store: OrderValidationDemandPort;
            createSnapshot: OrderValidationSnapshotFactory;
            now?: () => number;
        },
    ) {}

    async executeNext(): Promise<boolean> {
        const now = this.deps.now ?? Date.now;
        const claim = this.deps.store.claimNext(
            this.deps.chainId,
            randomUUID(),
            now(),
        );
        if (!claim) return false;
        const timer = setInterval(() => {
            try {
                this.deps.store.renew(claim, now());
            } catch {
                /* The commit fence remains authoritative. */
            }
        }, POLICY.renewEveryMs);
        timer.unref?.();
        try {
            const snapshot = await this.deps.createSnapshot({
                chainId: claim.demand.chainId,
                minimumBlock: claim.demand.minimumBlock,
            });
            const result = await snapshot.validate(claim.candidate.order);
            await snapshot.finish();
            this.deps.store.complete(claim, result, snapshot.proof, now());
        } catch (error) {
            this.deps.store.fail(claim, error, now());
            logger.warn("Order validation demand failed", {
                chainId: claim.demand.chainId,
                orderId: claim.demand.orderId,
                generation: claim.demand.generation,
                error: String(error),
            });
        } finally {
            clearInterval(timer);
        }
        return true;
    }
}

export function startOrderValidationDemand(
    processor: ValidateOrderDemand,
): () => Promise<void> {
    let active: Promise<void> | undefined;
    let stopped = false;
    const tick = () => {
        if (stopped || active) return;
        active = (async () => {
            const start = Date.now();
            for (
                let count = 0;
                !stopped &&
                count < POLICY.batchOrders &&
                Date.now() - start < POLICY.budgetMs;
                count++
            )
                if (!(await processor.executeNext())) break;
        })()
            .catch((error) =>
                logger.warn("Order validation demand poll failed", {
                    error: String(error),
                }),
            )
            .finally(() => {
                active = undefined;
            });
    };
    const timer = setInterval(tick, POLICY.pollMs);
    timer.unref?.();
    tick();
    return async () => {
        stopped = true;
        clearInterval(timer);
        await active;
    };
}
