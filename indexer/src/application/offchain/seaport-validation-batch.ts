import type { OrderRecord } from "../../domain/orders.js";
import { ORDER_VALIDATION_BATCH_POLICY as POLICY } from "../../domain/order-validation-policy.js";
import type { ConduitRegistryPort } from "../../ports/conduits.js";
import type {
    MakerValidationBatchFactory,
    OrderValidationSnapshotFactory,
} from "../../ports/order-validation.js";
import type { RpcProviderPort } from "../../ports/rpc.js";
import { validateSeaportOrder } from "./seaport-validate.js";
import { createSeaportStatusReader } from "./seaport-status-reader.js";
import {
    OrderValidationSnapshotUnavailable,
    OrderValidationReadUnavailable,
} from "../../domain/order-validation-failure.js";

const SHARED_READS = new Set(["getCounter", "allowance", "balanceOf"]);
// These Seaport/ERC721 calls depend on one order/token. This classifies the read,
// not the provider's health or the order's validity; failed work remains retryable.
const ORDER_READS = new Set(["getOrderStatus", "ownerOf", "getApproved"]);

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
    let statusBatchUnavailableUntil = 0;
    return async ({ chainId, minimumBlock, candidates = [] }) => {
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
        const counts = { perOrder: 0, shared: 0, other: 0, statusBatches: 0 };
        const readStatus = createSeaportStatusReader({
            rpc,
            chainId,
            blockNumber: number,
            candidates: candidates.filter(admits),
            canBatch: () => now() >= statusBatchUnavailableUntil,
            batchFailed: () => {
                statusBatchUnavailableUntil =
                    now() + POLICY.statusBatchRetryAfterMs;
            },
            counts,
        });
        let failure: unknown;
        let currentOrderId: string | undefined;
        let orders = 0;
        let closed = false;
        // The validator also catches conduit-registry errors. Preserve their infrastructure
        // origin so a failed SQLite lookup or cache write cannot become an invalid order.
        const registryCall = <T>(call: () => T): T => {
            try {
                return call();
            } catch (error) {
                failure = new OrderValidationSnapshotUnavailable(
                    "Validation snapshot conduit registry failed",
                    error,
                );
                throw failure;
            }
        };
        const conduits: ConduitRegistryPort = {
            getConduit: (...args) =>
                registryCall(() => input.conduits.getConduit(...args)),
            upsertConduit: (...args) =>
                registryCall(() => input.conduits.upsertConduit(...args)),
            hasChannel: (...args) =>
                registryCall(() => input.conduits.hasChannel(...args)),
            replaceChannels: (...args) =>
                registryCall(() => input.conduits.replaceChannels(...args)),
        };
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
                    if (params.functionName === "getOrderStatus")
                        return (await readStatus(params)) as T;
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
                    failure =
                        error instanceof OrderValidationSnapshotUnavailable
                            ? error
                            : currentOrderId &&
                                ORDER_READS.has(params.functionName)
                              ? new OrderValidationReadUnavailable(
                                    currentOrderId,
                                    error,
                                )
                              : new OrderValidationSnapshotUnavailable(
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
                currentOrderId = order.id;
                try {
                    const result = await validateSeaportOrder(
                        pinnedRpc,
                        conduits,
                        { conduitController: input.conduitController },
                        order,
                    );
                    // A failed dependency poisons this snapshot, even if the validator
                    // translated the infrastructure error into a protocol result.
                    if (failure) throw failure;
                    return result;
                } finally {
                    currentOrderId = undefined;
                }
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
