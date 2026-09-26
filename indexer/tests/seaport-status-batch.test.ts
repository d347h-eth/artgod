import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@artgod/shared/utils";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { OrderValidationSnapshotUnavailable } from "../src/domain/order-validation-failure.js";
import { ORDER_VALIDATION_BATCH_POLICY as POLICY } from "../src/domain/order-validation-policy.js";
import { ORDER_STATUS, type OrderRecord } from "../src/domain/orders.js";
import {
    RPC_CONTRACT_BATCH_MAX_CALLS,
    type RpcProviderPort,
} from "../src/ports/rpc.js";
import {
    BatchedHeavyMakerRpc,
    HEAVY_MAKER,
    heavyMakerOrder,
    warmConduits,
} from "./fixtures/heavy-maker.js";

const start = HEAVY_MAKER.now * 1_000;
function factory(rpc: RpcProviderPort, now: () => number = () => start) {
    return createSeaportOrderValidationFactory({
        rpc,
        chainId: HEAVY_MAKER.chainId,
        conduits: warmConduits,
        conduitController: HEAVY_MAKER.controller,
        now,
    });
}
function scope(candidates: OrderRecord[]) {
    return {
        chainId: HEAVY_MAKER.chainId,
        minimumBlock: HEAVY_MAKER.blockNumber,
        candidates,
    };
}

describe("Seaport status aggregates", () => {
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(start);
        vi.spyOn(logger, "error").mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it("lazily batches unique statuses within bounds, pins blocks, and refreshes across snapshots", async () => {
        const rpc = new BatchedHeavyMakerRpc();
        const orders = Array.from({ length: 55 }, (_, i) => heavyMakerOrder(i));
        const create = factory(rpc);
        const snapshot = await create(scope([...orders, orders[0]!]));
        expect(rpc.batches).toHaveLength(0);
        for (const order of orders)
            expect((await snapshot.validate(order)).status).toBe(
                ORDER_STATUS.Fillable,
            );
        await snapshot.validate(orders[0]!);
        await snapshot.finish();
        expect(rpc.batches.map((b) => b.contracts.length)).toEqual([
            20, 20, 15,
        ]);
        expect(
            rpc.batches.every(
                (b) =>
                    b.contracts.length <= RPC_CONTRACT_BATCH_MAX_CALLS &&
                    b.blockNumber === HEAVY_MAKER.blockNumber,
            ),
        ).toBe(true);
        expect(snapshot.readCounts()).toEqual({
            perOrder: 55,
            shared: 3,
            other: 0,
            statusBatches: 3,
        });
        expect(rpc.reads.getOrderStatus).toBe(55);
        rpc.blockNumber++;
        rpc.balance = 0n;
        const next = await create(scope(orders.slice(0, 2)));
        expect((await next.validate(orders[0]!)).status).toBe(
            ORDER_STATUS.NoBalance,
        );
        await next.finish();
        expect(rpc.batches.at(-1)?.blockNumber).toBe(rpc.blockNumber);
        expect(rpc.reads.getOrderStatus).toBe(57);
    });

    it("keeps protocol identities separate and retains local hash guards", async () => {
        const rpc = new BatchedHeavyMakerRpc();
        const original = heavyMakerOrder(0);
        const other = {
            ...original,
            seaportData: {
                ...original.seaportData!,
                protocolAddress: "0x8888888888888888888888888888888888888888",
            },
        };
        const wrongHash = heavyMakerOrder(1, { id: `0x${"00".repeat(32)}` });
        const snapshot = await factory(rpc)(
            scope([original, other, wrongHash]),
        );
        expect(await snapshot.validate(wrongHash)).toMatchObject({
            status: ORDER_STATUS.Invalid,
            reason: "order-hash-mismatch",
        });
        expect(rpc.batches).toHaveLength(0);
        await snapshot.validate(original);
        await snapshot.validate(other);
        await snapshot.finish();
        expect(
            rpc.batches[0]?.contracts.slice(0, 2).map((c) => c.address),
        ).toEqual([HEAVY_MAKER.protocol, other.seaportData.protocolAddress]);
        expect(rpc.reads.getCounter).toBe(2);
    });

    it("falls back only for failed or malformed items, preserving independent terminal decisions", async () => {
        const rpc = new BatchedHeavyMakerRpc();
        vi.spyOn(rpc, "readContracts").mockResolvedValue([
            { error: new Error("one call reverted") },
            { value: [false, false, "0", "1"] },
            { value: null },
            { value: [false, true, 0n, 1n] },
            { value: [false, false, 1n, 1n] },
        ]);
        const single = vi.spyOn(rpc, "readContract");
        const orders = Array.from({ length: 5 }, (_, i) => heavyMakerOrder(i));
        const snapshot = await factory(rpc)(scope(orders));
        const statuses = [];
        for (const order of orders)
            statuses.push((await snapshot.validate(order)).status);
        await snapshot.finish();
        expect(statuses).toEqual([
            ORDER_STATUS.Fillable,
            ORDER_STATUS.Fillable,
            ORDER_STATUS.Fillable,
            ORDER_STATUS.Cancelled,
            ORDER_STATUS.Filled,
        ]);
        expect(
            single.mock.calls
                .filter(([p]) => p.functionName === "getOrderStatus")
                .map(([p]) => p.args?.[0]),
        ).toEqual(orders.slice(0, 3).map((o) => o.id));
    });

    it.each(["rejection", "missing-results", "all-failed"])(
        "cools down %s across contexts and probes again later",
        async (failure) => {
            const rpc = new BatchedHeavyMakerRpc();
            const aggregate = vi.spyOn(rpc, "readContracts");
            if (failure === "rejection")
                aggregate.mockRejectedValue(new Error("provider limit"));
            else
                aggregate.mockResolvedValue(
                    failure === "missing-results"
                        ? []
                        : Array.from({ length: 3 }, () => ({
                              error: new Error("unsupported"),
                          })),
                );
            let now = start;
            const create = factory(rpc, () => now);
            const orders = [0, 1, 2].map((i) => heavyMakerOrder(i));
            for (let context = 0; context < 2; context++) {
                const snapshot = await create(scope(orders));
                for (const order of orders)
                    expect((await snapshot.validate(order)).status).toBe(
                        ORDER_STATUS.Fillable,
                    );
                await snapshot.finish();
            }
            expect(aggregate).toHaveBeenCalledTimes(1);
            now += POLICY.statusBatchRetryAfterMs;
            rpc.blockTimestamp = now / 1_000;
            const retry = await create(scope(orders));
            await retry.validate(orders[0]!);
            await retry.finish();
            expect(aggregate).toHaveBeenCalledTimes(2);
            // Unconsumed lookahead does not issue fallback reads.
            expect(rpc.reads.getOrderStatus).toBe(7);
        },
    );

    it("propagates failed individual fallback instead of committing invalid orders", async () => {
        const rpc = new BatchedHeavyMakerRpc();
        vi.spyOn(rpc, "readContracts").mockRejectedValue(
            new Error("batch unavailable"),
        );
        rpc.onRead = () => {
            throw new Error("individual read unavailable");
        };
        const orders = [heavyMakerOrder(0), heavyMakerOrder(1)];
        const snapshot = await factory(rpc)(scope(orders));
        await expect(snapshot.validate(orders[0]!)).rejects.toThrow(
            OrderValidationSnapshotUnavailable,
        );
        await expect(snapshot.finish()).rejects.toThrow(
            OrderValidationSnapshotUnavailable,
        );
        expect(rpc.reads.getOrderStatus).toBe(1);
    });

    it("rejects a reorg after successful batching and respects the context admission budget", async () => {
        const rpc = new BatchedHeavyMakerRpc();
        let now = start;
        const orders = Array.from({ length: POLICY.maxOrders }, (_, i) =>
            heavyMakerOrder(i),
        );
        const snapshot = await factory(rpc, () => now)(scope(orders));
        await snapshot.validate(orders[0]!);
        now += POLICY.admissionBudgetMs;
        expect(snapshot.canAccept()).toBe(false);
        expect(rpc.batches).toHaveLength(1);
        expect(rpc.reads.getOrderStatus).toBe(RPC_CONTRACT_BATCH_MAX_CALLS);
        rpc.blockHash = `0x${"cd".repeat(32)}`;
        await expect(snapshot.finish()).rejects.toThrow(
            "changed before commit",
        );
    });
});
