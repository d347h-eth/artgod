import type { OrderRecord } from "../../domain/orders.js";
import { ORDER_VALIDATION_BATCH_POLICY as POLICY } from "../../domain/order-validation-policy.js";
import type { ConduitRegistryPort } from "../../ports/conduits.js";
import type {
    MakerValidationBatchFactory,
    OrderValidationSnapshotFactory,
} from "../../ports/order-validation.js";
import type { RpcProviderPort } from "../../ports/rpc.js";
import { validateSeaportOrder } from "./seaport-validate.js";

/** Infrastructure uncertainty cannot be recorded as a protocol-invalid order. */
export class OrderValidationSnapshotUnavailable extends Error {
    constructor(message: string, cause?: unknown) {
        super(message, { cause });
        this.name = "OrderValidationSnapshotUnavailable";
    }
}

const SHARED_READS = new Set(["getCounter", "allowance", "balanceOf"]);

type SnapshotDependencies = {
    chainId: number;
    rpc: RpcProviderPort;
    conduits: ConduitRegistryPort;
    conduitController: string;
    now?: () => number;
};

/** Full WETH validation with shared reads confined to one fresh chain snapshot. */
export function createSeaportValidationBatchFactory(
    input: SnapshotDependencies & { wethAddress: string },
): MakerValidationBatchFactory {
    return createValidationSnapshotFactory(
        input,
        (order) =>
            order.side === "buy" &&
            order.currency?.toLowerCase() === input.wethAddress.toLowerCase(),
    );
}

/** Full by-ID validation uses the same strict snapshot/error boundary for every order type. */
export function createSeaportOrderValidationFactory(
    input: SnapshotDependencies,
): OrderValidationSnapshotFactory {
    return createValidationSnapshotFactory(input, () => true);
}

function createValidationSnapshotFactory(
    input: SnapshotDependencies,
    admits: (order: OrderRecord) => boolean,
): OrderValidationSnapshotFactory {
    const { rpc } = input;
    const now = input.now ?? Date.now;
    return async ({ chainId, minimumBlock }) => {
        if (chainId !== input.chainId)
            throw new Error("Validation batch chain mismatch");
        const startedAt = now();
        const number = await rpc.getBlockNumber();
        if (minimumBlock !== null && number < minimumBlock) {
            throw new OrderValidationSnapshotUnavailable(
                "RPC head precedes maker trigger",
            );
        }
        // Fresh lookup bypasses any general block cache, including the check before commit.
        const block = await rpc.getBlock(number, { fresh: true });
        const checkLifetime = () => {
            if (
                now() - startedAt > POLICY.snapshotLifetimeMs ||
                now() / 1_000 - block.timestamp > POLICY.maxBlockAgeSeconds ||
                block.number !== number ||
                !/^0x[0-9a-f]{64}$/i.test(block.hash)
            ) {
                throw new OrderValidationSnapshotUnavailable(
                    "Validation snapshot is stale or unavailable",
                );
            }
        };
        checkLifetime();
        const cache = new Map<string, Promise<unknown>>();
        const counts = { perOrder: 0, shared: 0, other: 0 };
        let failure: unknown;
        let orders = 0;
        let closed = false;
        const pinnedRpc: RpcProviderPort = {
            getBlockNumber: () => rpc.getBlockNumber(),
            getBlock: (n, options) => rpc.getBlock(n, options),
            getLogs: (filter) => rpc.getLogs(filter),
            getTransaction: (hash) => rpc.getTransaction(hash),
            getTransactionReceipt: (hash) => rpc.getTransactionReceipt(hash),
            getBalance: async (address) => {
                try {
                    checkLifetime();
                    counts.other++;
                    const balance = await rpc.getBalance(address, {
                        blockNumber: number,
                    });
                    if (typeof balance !== "bigint")
                        throw new Error("Invalid native balance response");
                    return balance;
                } catch (error) {
                    failure = new OrderValidationSnapshotUnavailable(
                        "Validation snapshot balance read failed",
                        error,
                    );
                    throw failure;
                }
            },
            async readContract<T>(
                params: Parameters<RpcProviderPort["readContract"]>[0],
            ): Promise<T> {
                try {
                    checkLifetime();
                    const key = JSON.stringify(
                        [
                            chainId,
                            block.hash,
                            params.address.toLowerCase(),
                            params.functionName,
                            params.args,
                        ],
                        (_key, value) =>
                            typeof value === "bigint"
                                ? value.toString()
                                : typeof value === "string"
                                  ? value.toLowerCase()
                                  : value,
                    );
                    const shared = SHARED_READS.has(params.functionName);
                    let pending = shared ? cache.get(key) : undefined;
                    if (!pending) {
                        if (shared) counts.shared++;
                        else if (params.functionName === "getOrderStatus")
                            counts.perOrder++;
                        else counts.other++;
                        pending = rpc.readContract({
                            ...params,
                            blockNumber: number,
                        });
                        if (shared) cache.set(key, pending);
                    }
                    const result = await pending;
                    if (result === undefined || result === null)
                        throw new Error("Empty contract response");
                    return result as T;
                } catch (error) {
                    failure = new OrderValidationSnapshotUnavailable(
                        "Validation snapshot read failed",
                        error,
                    );
                    throw failure;
                }
            },
        };
        const canAccept = () =>
            !closed &&
            !failure &&
            orders < POLICY.maxOrders &&
            now() - startedAt < POLICY.admissionBudgetMs;
        return {
            canAccept,
            proof: { observedAt: startedAt, blockNumber: number },
            readCounts: () => ({ ...counts }),
            async validate(order: OrderRecord) {
                if (closed || failure || orders >= POLICY.maxOrders)
                    throw new OrderValidationSnapshotUnavailable(
                        "Validation batch is closed",
                    );
                if (order.chainId !== chainId || !admits(order)) {
                    throw new Error(
                        "Validation snapshot requires WETH bids on its chain",
                    );
                }
                checkLifetime();
                orders++;
                const result = await validateSeaportOrder(
                    pinnedRpc,
                    input.conduits,
                    { conduitController: input.conduitController },
                    order,
                );
                // Singleton validation retains its existing error behavior. A batched RPC failure
                // poisons this snapshot, even if the validator translated it into a result.
                if (failure) throw failure;
                return result;
            },
            async finish() {
                if (closed)
                    throw new Error("Validation batch already finished");
                closed = true;
                if (failure) throw failure;
                const canonical = await rpc.getBlock(number, { fresh: true });
                const head = await rpc.getBlockNumber();
                checkLifetime();
                if (
                    canonical.hash !== block.hash ||
                    head < number ||
                    head - number > POLICY.maxHeadAdvance
                ) {
                    throw new OrderValidationSnapshotUnavailable(
                        "Validation snapshot changed before commit",
                    );
                }
                cache.clear();
            },
        };
    };
}
