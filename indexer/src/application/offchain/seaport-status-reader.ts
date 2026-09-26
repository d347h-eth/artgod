import { SEAPORT_VALIDATION_ABI } from "../../abi/seaport-validation.js";
import { ORDER_VALIDATION_BATCH_POLICY } from "../../domain/order-validation-policy.js";
import type { OrderRecord } from "../../domain/orders.js";
import {
    RPC_CONTRACT_BATCH_MAX_CALLS,
    type Hex,
    type RpcContractRead,
    type RpcProviderPort,
} from "../../ports/rpc.js";

type OrderStatus = readonly [boolean, boolean, bigint, bigint];

/** Context-local lookahead: bounded status aggregates never replace full validation. */
export function createSeaportStatusReader(input: {
    rpc: RpcProviderPort;
    chainId: number;
    blockNumber: number;
    candidates: readonly OrderRecord[];
    canBatch: () => boolean;
    batchFailed: () => void;
    counts: { perOrder: number; statusBatches: number };
}) {
    const pending = new Map<string, RpcContractRead>();
    const prefetched = new Map<string, Promise<unknown>>();
    const singles = new Map<string, Promise<OrderStatus>>();
    for (const order of input.candidates.slice(
        0,
        ORDER_VALIDATION_BATCH_POLICY.maxOrders,
    )) {
        const protocol = order.seaportData?.protocolAddress;
        if (
            order.chainId !== input.chainId ||
            order.kind !== "seaport" ||
            !protocol ||
            !/^0x[0-9a-f]{40}$/i.test(protocol) ||
            !/^0x[0-9a-f]{64}$/i.test(order.id)
        )
            continue;
        const contract: RpcContractRead = {
            address: protocol as Hex,
            abi: SEAPORT_VALIDATION_ABI,
            functionName: "getOrderStatus",
            args: [order.id],
        };
        pending.set(statusKey(contract), contract);
    }

    async function prefetch(contracts: RpcContractRead[]): Promise<unknown[]> {
        input.counts.perOrder += contracts.length;
        input.counts.statusBatches++;
        try {
            const results = await input.rpc.readContracts!({
                contracts,
                blockNumber: input.blockNumber,
            });
            if (results.length !== contracts.length)
                throw new Error("Contract batch result count mismatch");
            const values = results.map((result) =>
                "value" in result ? result.value : undefined,
            );
            if (!values.some(isOrderStatus)) input.batchFailed();
            return values;
        } catch {
            // Unsupported/failed aggregates cost one attempt then cool down across contexts.
            // Only orders actually validated request their serial fallback.
            input.batchFailed();
            return [];
        }
    }

    return async (contract: RpcContractRead): Promise<OrderStatus> => {
        const key = statusKey(contract);
        if (
            !prefetched.has(key) &&
            !singles.has(key) &&
            input.rpc.readContracts &&
            input.canBatch()
        ) {
            const chunk = [contract];
            pending.delete(key);
            for (const [nextKey, next] of pending) {
                if (chunk.length === RPC_CONTRACT_BATCH_MAX_CALLS) break;
                chunk.push(next);
                pending.delete(nextKey);
            }
            if (chunk.length > 1) {
                const results = prefetch(chunk);
                for (let i = 0; i < chunk.length; i++)
                    prefetched.set(
                        statusKey(chunk[i]!),
                        results.then((values) => values[i]),
                    );
            }
        }
        const value = await prefetched.get(key);
        if (isOrderStatus(value)) return value;
        let single = singles.get(key);
        if (!single) {
            input.counts.perOrder++;
            single = input.rpc
                .readContract({ ...contract, blockNumber: input.blockNumber })
                .then((result) => {
                    if (!isOrderStatus(result))
                        throw new Error(
                            "Invalid Seaport order status response",
                        );
                    return result;
                });
            singles.set(key, single);
            pending.delete(key);
        }
        return single;
    };
}

function statusKey(contract: RpcContractRead): string {
    // Maps live for one pinned chain/block snapshot only. Different protocols stay separate.
    return `${contract.address}:${contract.args?.[0]}`.toLowerCase();
}

function isOrderStatus(value: unknown): value is OrderStatus {
    return (
        Array.isArray(value) &&
        value.length === 4 &&
        typeof value[0] === "boolean" &&
        typeof value[1] === "boolean" &&
        typeof value[2] === "bigint" &&
        value[2] >= 0n &&
        typeof value[3] === "bigint" &&
        value[3] >= 0n
    );
}
