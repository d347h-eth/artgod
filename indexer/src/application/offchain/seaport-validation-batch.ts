import { StoredBlockHashConflict } from "../../domain/chain-sync.js";
import type { OrderRecord } from "../../domain/orders.js";
import { ORDER_VALIDATION_BATCH_POLICY as POLICY } from "../../domain/order-validation-policy.js";
import type { ConduitRegistryPort } from "../../ports/conduits.js";
import type { OrderValidationSnapshotFactory } from "../../ports/order-validation.js";
import type { RpcProviderPort } from "../../ports/rpc.js";
import { validateSeaportOrder } from "./seaport-validate.js";
import { createSeaportStatusReader } from "./seaport-status-reader.js";
import {
    OrderValidationSnapshotUnavailable,
    OrderValidationReadUnavailable,
} from "../../domain/order-validation-failure.js";

const SHARED_READS = new Set([
    "getCounter",
    "allowance",
    "balanceOf",
    "getConduit",
    "getChannels",
]);
// These Seaport/ERC721 calls depend on one order/token. This classifies the read,
// not the provider's health or the order's validity; failed work remains retryable.
const ORDER_READS = new Set(["getOrderStatus", "ownerOf", "getApproved"]);

type SnapshotDependencies = {
    chainId: number;
    rpc: RpcProviderPort;
    conduitController: string;
    now?: () => number;
};

/** Every ordinary or expanded scope uses the same exact applied checkpoint. */
export function createSeaportOrderValidationFactory(
    input: SnapshotDependencies,
): OrderValidationSnapshotFactory {
    const { rpc } = input;
    const now = input.now ?? Date.now;
    let statusBatchUnavailableUntil = 0;
    return async ({ checkpoint, candidates = [] }) => {
        // Copy the supplied identity: callers cannot change an in-flight snapshot.
        const { chainId, collectionId } = checkpoint;
        const block = { ...checkpoint.block };
        if (chainId !== input.chainId)
            throw new Error("Validation batch chain mismatch");
        if (
            !Number.isSafeInteger(collectionId) ||
            collectionId < 0 ||
            !Number.isSafeInteger(checkpoint.revision) ||
            checkpoint.revision < 0 ||
            !Number.isSafeInteger(block.number) ||
            block.number < 0 ||
            !/^0x[0-9a-f]{64}$/i.test(block.hash) ||
            !/^0x[0-9a-f]{64}$/i.test(block.parentHash) ||
            !Number.isSafeInteger(block.timestamp) ||
            block.timestamp < 0
        )
            throw new OrderValidationSnapshotUnavailable(
                "Invalid validation checkpoint",
            );
        const startedAt = now();
        const number = block.number;
        const reference = {
            chainId,
            blockNumber: number,
            blockHash: block.hash,
        };
        const checkLifetime = () => {
            if (now() - startedAt > POLICY.snapshotLifetimeMs) {
                throw new OrderValidationSnapshotUnavailable(
                    "Validation snapshot execution lifetime exceeded",
                );
            }
        };
        checkLifetime();
        const cache = new Map<string, Promise<unknown>>();
        const counts = { perOrder: 0, shared: 0, other: 0, statusBatches: 0 };
        const readStatus = createSeaportStatusReader({
            rpc,
            block: reference,
            candidates,
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
        // Persistent conduit/channel observations are not evidence at this checkpoint.
        // Only successful reads made through pinnedRpc populate these bounded local maps.
        const conduitAddresses = new Map<string, string>();
        const conduitChannels = new Map<string, Set<string>>();
        const conduits: ConduitRegistryPort = {
            getConduit: (_chainId, key) =>
                conduitAddresses.get(key.toLowerCase()) ?? null,
            upsertConduit: (record) => {
                conduitAddresses.set(
                    record.conduitKey.toLowerCase(),
                    record.conduitAddress.toLowerCase(),
                );
            },
            hasChannel: (_chainId, address, channel) =>
                conduitChannels
                    .get(address.toLowerCase())
                    ?.has(channel.toLowerCase()) ?? false,
            replaceChannels: (_chainId, address, channels) => {
                conduitChannels.set(
                    address.toLowerCase(),
                    new Set(channels.map((channel) => channel.toLowerCase())),
                );
            },
        };
        const pinnedRpc: Pick<RpcProviderPort, "readContract" | "getBalance"> =
            {
                getBalance: async (address) => {
                    try {
                        checkLifetime();
                        counts.other++;
                        const balance = await rpc.getBalanceAtBlock(
                            address,
                            reference,
                        );
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
                            pending = rpc.readContractAtBlock({
                                ...params,
                                block: reference,
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
            proof: {
                observedAt: startedAt,
                block: {
                    number,
                    hash: block.hash,
                    parentHash: block.parentHash,
                    timestamp: block.timestamp,
                },
            },
            readCounts: () => ({ ...counts }),
            async validate(order: OrderRecord) {
                if (closed || failure || orders >= POLICY.maxOrders)
                    throw new OrderValidationSnapshotUnavailable(
                        "Validation batch is closed",
                    );
                if (
                    order.chainId !== chainId ||
                    order.collectionId !== collectionId
                ) {
                    throw new Error(
                        "Order does not belong to this validation snapshot scope",
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
                checkLifetime();
                if (
                    canonical.number === number &&
                    canonical.hash !== block.hash
                )
                    throw new StoredBlockHashConflict(
                        {
                            chainId,
                            blockNumber: number,
                            blockHash: block.hash,
                            checkpoint,
                        },
                        canonical.hash,
                    );
                if (
                    canonical.number !== number ||
                    canonical.hash !== block.hash ||
                    canonical.parentHash !== block.parentHash ||
                    canonical.timestamp !== block.timestamp
                ) {
                    throw new OrderValidationSnapshotUnavailable(
                        "Validation snapshot changed before commit",
                    );
                }
                cache.clear();
                conduitAddresses.clear();
                conduitChannels.clear();
            },
        };
    };
}
