import { decodeSyncWorkClass } from "@artgod/shared/types/sync-work-class";
import type { OrderValidationSnapshotFactory } from "../ports/order-validation.js";
import type { IndexerConfig } from "../config/index.js";
import { NatsRpcBudget } from "../infra/rpc/nats-budget.js";
import { RpcWorkScope } from "../infra/rpc/work-scope.js";

/** Compose a pipeline-wide request allocation on the already configured broker. */
export async function connectIndexerRpcBudget(
    config: IndexerConfig,
    options: { owner: boolean },
) {
    const budget = await NatsRpcBudget.connect({
        ...config.queue,
        chainId: config.chainId,
        endpoints: [
            ...config.rpc.endpoints,
            ...(config.rpc.backfillEndpoints ?? []),
        ],
        endpointLimit: config.rpc.resilience.rateLimiter,
        gap: config.rpc.gapAllocation,
        requestTimeoutMs: config.rpc.resilience.requestTimeoutMs,
    });
    if (options.owner) await budget.serve();
    const workScope = new RpcWorkScope();
    return {
        budget,
        workScope,
        requestBudget: { budget, workClass: workScope.current },
    };
}

// Deferred validation outlives the queue handler. Bind every RPC-bearing operation,
// including final fork verification, to the class retained with that demand.
export function bindRpcValidationFactory(
    scope: RpcWorkScope,
    factory: OrderValidationSnapshotFactory,
): OrderValidationSnapshotFactory {
    return async (input) => {
        const workClass = decodeSyncWorkClass(input.workClass);
        const snapshot = await scope.run(workClass, () => factory(input));
        return {
            ...snapshot,
            validate: (order) =>
                scope.run(workClass, () => snapshot.validate(order)),
            finish: () => scope.run(workClass, () => snapshot.finish()),
        };
    };
}
