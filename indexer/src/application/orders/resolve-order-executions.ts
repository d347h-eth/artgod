import { randomUUID } from "node:crypto";
import { getRpcBudgetDeferral } from "@artgod/shared/evm/rpc-budget";
import { ORDER_VALIDATION_DEMAND_POLICY as POLICY } from "../../domain/order-validation-demand.js";
import type { OrderExecutionRequirementsPort } from "../../ports/order-execution-requirements.js";
import type { OrderValidationAdmissionPort } from "../../ports/order-validation-admission.js";
import type { OrderExecutionBlockPort } from "./execution-block.js";

/** One bounded receipt attempt per permit; failures defer only that transaction. */
export class ResolveOrderExecutions {
    constructor(
        private readonly deps: {
            chainId: number;
            store: OrderExecutionRequirementsPort;
            executionBlock: OrderExecutionBlockPort;
            admission: OrderValidationAdmissionPort;
            now?: () => number;
        },
    ) {}

    async executeBatch(
        signal?: AbortSignal,
    ): Promise<{ claimed: number; released: number } | undefined> {
        if (signal?.aborted) return;
        return this.deps.admission.run(async () => {
            if (signal?.aborted) return;
            const now = this.deps.now ?? Date.now;
            const claim = this.deps.store.claim(
                this.deps.chainId,
                randomUUID(),
                now(),
            );
            if (!claim) return;
            const timer = setInterval(() => {
                try {
                    this.deps.store.renew(claim, now());
                } catch {
                    /* Commit still fences ownership. */
                }
            }, POLICY.renewEveryMs);
            timer.unref?.();
            let released = 0;
            try {
                const checkpoint = this.deps.store.captureSyncCheckpoint(
                    this.deps.chainId,
                );
                const block = await this.deps.executionBlock.resolve(
                    claim.transactionHash,
                );
                this.deps.store.complete(claim, block, checkpoint, now());
            } catch (error) {
                if (getRpcBudgetDeferral(error)) {
                    this.deps.store.release(claim, now());
                    released = 1;
                } else this.deps.store.defer(claim, error, now());
            } finally {
                clearInterval(timer);
            }
            return { claimed: 1, released };
        }, signal);
    }
}
