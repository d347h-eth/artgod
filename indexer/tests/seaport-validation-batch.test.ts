import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@artgod/shared/utils";
import { zeroAddress } from "viem";
import { computeSeaportOrderHash } from "../src/domain/seaport-protocol.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import {
    OrderValidationSnapshotUnavailable,
    OrderValidationReadUnavailable,
} from "../src/domain/order-validation-failure.js";
import { ORDER_VALIDATION_BATCH_POLICY as POLICY } from "../src/domain/order-validation-policy.js";
import {
    ORDER_VALIDATION_REASON,
    ORDER_STATUS,
    type OrderRecord,
} from "../src/domain/orders.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    heavyMakerOrder,
    heavyMakerBlock,
    heavyMakerCheckpoint,
} from "./fixtures/heavy-maker.js";

function factory(
    rpc: HeavyMakerRpc,
    options: {
        chainId?: number;
        now?: () => number;
    } = {},
) {
    return createSeaportOrderValidationFactory({
        rpc,
        chainId: HEAVY_MAKER.chainId,
        conduitController: HEAVY_MAKER.controller,
        now: () => HEAVY_MAKER.now * 1_000,
        ...options,
    });
}
const scope = { checkpoint: heavyMakerCheckpoint() };

describe("bounded Seaport validation snapshots", () => {
    beforeEach(() =>
        vi.spyOn(Date, "now").mockReturnValue(HEAVY_MAKER.now * 1_000),
    );
    afterEach(() => vi.restoreAllMocks());

    it.each([
        "getOrderStatus",
        "ownerOf",
        "getCounter",
        "balanceOf",
        "allowance",
        "isApprovedForAll",
    ])(
        "classifies %s read failures without allowing poisoned snapshot completion",
        async (functionName) => {
            vi.spyOn(logger, "error").mockImplementation(() => {});
            const rpc = new HeavyMakerRpc();
            const sell =
                functionName === "ownerOf" ||
                functionName === "isApprovedForAll";
            const order = heavyMakerOrder(
                0,
                sell ? { side: "sell", maker: HEAVY_MAKER.smallMaker } : {},
            );
            const cause = new Error("fixture dependency failure");
            rpc.onRead = (params) => {
                if (params.functionName === functionName) throw cause;
            };
            const create = createSeaportOrderValidationFactory({
                chainId: HEAVY_MAKER.chainId,
                rpc,
                conduitController: HEAVY_MAKER.controller,
            });
            const batch = await create(scope);
            const failure = await batch
                .validate(order)
                .catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(OrderValidationSnapshotUnavailable);
            if (
                functionName === "getOrderStatus" ||
                functionName === "ownerOf"
            ) {
                expect(failure).toBeInstanceOf(OrderValidationReadUnavailable);
                expect(failure).toMatchObject({ orderId: order.id, cause });
            } else {
                expect(failure).not.toBeInstanceOf(
                    OrderValidationReadUnavailable,
                );
            }
            await expect(batch.finish()).rejects.toBe(failure);
        },
    );

    it("pins native balance and sell checks in full-order snapshots, propagating native RPC failure", async () => {
        vi.spyOn(logger, "error").mockImplementation(() => {});
        const rpc = new HeavyMakerRpc();
        const getBalance = vi.spyOn(rpc, "getBalanceAtBlock");
        const create = createSeaportOrderValidationFactory({
            chainId: HEAVY_MAKER.chainId,
            rpc,
            conduitController: HEAVY_MAKER.controller,
        });
        const native = heavyMakerOrder(5, { currency: zeroAddress });
        native.seaportData!.offer[0] = {
            ...native.seaportData!.offer[0]!,
            itemType: "0",
            token: zeroAddress,
        };
        native.id = computeSeaportOrderHash(native.seaportData!);
        const context = await create(scope);
        expect((await context.validate(native)).status).toBe(
            ORDER_STATUS.Fillable,
        );
        expect(getBalance).toHaveBeenCalledWith(native.maker, {
            chainId: HEAVY_MAKER.chainId,
            blockNumber: HEAVY_MAKER.blockNumber,
            blockHash: HEAVY_MAKER.blockHash,
        });
        const sell = heavyMakerOrder(6, {
            side: "sell",
            maker: HEAVY_MAKER.smallMaker,
        });
        expect((await context.validate(sell)).status).toBe(
            ORDER_STATUS.Fillable,
        );
        await context.finish();
        expect(context.proof).toEqual({
            observedAt: HEAVY_MAKER.now * 1_000,
            block: {
                number: HEAVY_MAKER.blockNumber,
                hash: rpc.blockHash,
                parentHash: rpc.blockHash,
                timestamp: HEAVY_MAKER.now,
            },
        });
        getBalance.mockRejectedValueOnce(new Error("native RPC unavailable"));
        const failed = await create(scope);
        await expect(failed.validate(native)).rejects.toThrow(
            OrderValidationSnapshotUnavailable,
        );
        await expect(failed.finish()).rejects.toThrow(
            OrderValidationSnapshotUnavailable,
        );
    });

    it("shares in-flight wallet reads while retaining each order status and pinning every read", async () => {
        const rpc = new HeavyMakerRpc();
        const blocks = new Set<string | undefined>();
        rpc.onRead = (params) => {
            blocks.add(params.block?.blockHash);
            expect(params.blockNumber).toBeUndefined();
        };
        const batch = await factory(rpc)(scope);
        const results = await Promise.all(
            [0, 1, 2].map((i) => batch.validate(heavyMakerOrder(i))),
        );
        await batch.finish();
        expect(results.map((r) => r.status)).toEqual(
            Array(3).fill(ORDER_STATUS.Fillable),
        );
        expect(rpc.reads).toEqual({
            getOrderStatus: 3,
            getCounter: 1,
            allowance: 1,
            balanceOf: 1,
            getConduit: 1,
            getChannels: 1,
        });
        expect(blocks).toEqual(new Set([HEAVY_MAKER.blockHash]));
        await expect(batch.validate(heavyMakerOrder(3))).rejects.toThrow(
            OrderValidationSnapshotUnavailable,
        );
    });

    it("separates makers, protocol counters and allowance spenders", async () => {
        const rpc = new HeavyMakerRpc();
        const secondConduit = "0x7777777777777777777777777777777777777777";
        const secondKey = `0x${"02".repeat(32)}`;
        const read = rpc.readContractAtBlock.bind(rpc);
        vi.spyOn(rpc, "readContractAtBlock").mockImplementation(
            async (params) => {
                if (
                    params.functionName === "getConduit" &&
                    params.args?.[0] === secondKey
                )
                    return [secondConduit, true] as any;
                if (params.functionName === "getChannels")
                    return [
                        HEAVY_MAKER.protocol,
                        "0x8888888888888888888888888888888888888888",
                    ] as any;
                return read(params);
            },
        );
        const batch = await factory(rpc)(scope);
        const otherProtocol = heavyMakerOrder(3);
        otherProtocol.seaportData = {
            ...otherProtocol.seaportData!,
            protocolAddress: "0x8888888888888888888888888888888888888888",
        };
        const otherSpender = heavyMakerOrder(4);
        otherSpender.seaportData = {
            ...otherSpender.seaportData!,
            conduitKey: secondKey,
        };
        otherSpender.id = computeSeaportOrderHash(otherSpender.seaportData);
        for (const order of [
            heavyMakerOrder(0),
            heavyMakerOrder(1, { maker: HEAVY_MAKER.smallMaker }),
            otherProtocol,
            otherSpender,
        ]) {
            expect((await batch.validate(order)).status).toBe(
                ORDER_STATUS.Fillable,
            );
        }
        await batch.finish();
        expect(rpc.reads).toEqual({
            getOrderStatus: 4,
            getCounter: 3,
            allowance: 3,
            balanceOf: 2,
            getConduit: 1,
        });
    });

    it("rejects orders from another chain or collection scope", async () => {
        const rpc = new HeavyMakerRpc();
        const batch = await factory(rpc)(scope);
        for (const change of [{ chainId: 2 }, { collectionId: 11 }]) {
            await expect(
                batch.validate(heavyMakerOrder(0, change)),
            ).rejects.toThrow("snapshot scope");
        }
        await expect(
            factory(rpc)({ checkpoint: { ...scope.checkpoint, chainId: 2 } }),
        ).rejects.toThrow("chain mismatch");
        expect(rpc.reads).toEqual({});
        const chainTwo = await factory(rpc, { chainId: 2 })({
            checkpoint: { ...scope.checkpoint, chainId: 2 },
        });
        expect(
            (await chainTwo.validate(heavyMakerOrder(0, { chainId: 2 })))
                .status,
        ).toBe(ORDER_STATUS.Fillable);
        await chainTwo.finish();
    });

    it("preserves hash/time early exits and protocol terminal decisions", async () => {
        const rpc = new HeavyMakerRpc();
        const batch = await factory(rpc)(scope);
        expect(
            await batch.validate(
                heavyMakerOrder(0, { id: `0x${"00".repeat(32)}` }),
            ),
        ).toMatchObject({
            status: ORDER_STATUS.Invalid,
            reason: ORDER_VALIDATION_REASON.OrderHashMismatch,
        });
        expect(rpc.reads).toEqual({});
        rpc.counter = 1n;
        expect(await batch.validate(heavyMakerOrder(1))).toMatchObject({
            status: ORDER_STATUS.Cancelled,
            reason: ORDER_VALIDATION_REASON.CounterMismatch,
        });
        await batch.finish();
        expect(rpc.reads).toEqual({ getOrderStatus: 1, getCounter: 1 });
    });

    it.each([
        "getOrderStatus",
        "getCounter",
        "allowance",
        "balanceOf",
        "getConduit",
        "getChannels",
    ])(
        "retries %s failure without reporting protocol invalidity",
        async (failedRead) => {
            vi.spyOn(logger, "error").mockImplementation(() => {});
            const rpc = new HeavyMakerRpc();
            rpc.onRead = ({ functionName }) => {
                if (functionName === failedRead)
                    throw new Error("RPC unavailable");
            };
            const batch = await factory(rpc)(scope);
            await expect(batch.validate(heavyMakerOrder(0))).rejects.toThrow(
                OrderValidationSnapshotUnavailable,
            );
            await expect(batch.finish()).rejects.toThrow(
                OrderValidationSnapshotUnavailable,
            );
        },
    );

    it("refreshes balances across contexts and keeps price-specific decisions", async () => {
        const rpc = new HeavyMakerRpc();
        rpc.balance = BigInt(heavyMakerOrder(0).price!);
        const create = factory(rpc);
        const first = await create(scope);
        expect((await first.validate(heavyMakerOrder(0))).status).toBe(
            ORDER_STATUS.Fillable,
        );
        expect((await first.validate(heavyMakerOrder(1))).status).toBe(
            ORDER_STATUS.NoBalance,
        );
        await first.finish();
        rpc.balance = 10n ** 24n;
        rpc.blockNumber++;
        const second = await create({
            checkpoint: heavyMakerCheckpoint(heavyMakerBlock(rpc.blockNumber)),
        });
        expect((await second.validate(heavyMakerOrder(1))).status).toBe(
            ORDER_STATUS.Fillable,
        );
        await second.finish();
        expect(rpc.reads.balanceOf).toBe(2);
    });

    it("reads conduit existence and channel authority anew at each checkpoint", async () => {
        const rpc = new HeavyMakerRpc();
        const first = await factory(rpc)(scope);
        expect((await first.validate(heavyMakerOrder(0))).status).toBe(
            ORDER_STATUS.Fillable,
        );
        await first.finish();
        const read = rpc.readContractAtBlock.bind(rpc);
        const calls = vi
            .spyOn(rpc, "readContractAtBlock")
            .mockImplementation(async (params) =>
                params.functionName === "getChannels"
                    ? ([] as any)
                    : read(params),
            );
        const next = await factory(rpc)(scope);
        expect((await next.validate(heavyMakerOrder(1))).status).toBe(
            ORDER_STATUS.Invalid,
        );
        await next.finish();
        expect(
            calls.mock.calls.some(([p]) => p.functionName === "getConduit"),
        ).toBe(true);
        expect(
            calls.mock.calls.some(([p]) => p.functionName === "getChannels"),
        ).toBe(true);
    });

    it("bounds admission by count and elapsed time, rejecting expired results", async () => {
        const rpc = new HeavyMakerRpc();
        let elapsed = 0;
        const create = factory(rpc, {
            now: () => HEAVY_MAKER.now * 1_000 + elapsed,
        });
        const batch = await create(scope);
        for (let i = 0; i < POLICY.maxOrders; i++)
            await batch.validate(heavyMakerOrder(i));
        expect(batch.canAccept()).toBe(false);
        await expect(
            batch.validate(heavyMakerOrder(POLICY.maxOrders)),
        ).rejects.toThrow(OrderValidationSnapshotUnavailable);
        await batch.finish();
        const timed = await create(scope);
        elapsed = POLICY.admissionBudgetMs;
        expect(timed.canAccept()).toBe(false);
        elapsed = POLICY.snapshotLifetimeMs + 1;
        await expect(timed.finish()).rejects.toThrow(
            OrderValidationSnapshotUnavailable,
        );
    });

    it("accepts applied lag and advancing heads without selecting another snapshot", async () => {
        const rpc = new HeavyMakerRpc();
        rpc.blockTimestamp = HEAVY_MAKER.now - 3600;
        const getHead = vi
            .spyOn(rpc, "getBlockNumber")
            .mockRejectedValue(new Error("independent HEAD forbidden"));
        const checkpoint = heavyMakerCheckpoint(
            heavyMakerBlock(rpc.blockNumber, rpc.blockHash, rpc.blockTimestamp),
        );
        const snapshot = await factory(rpc)({ checkpoint });
        expect((await snapshot.validate(heavyMakerOrder(0))).status).toBe(
            ORDER_STATUS.Fillable,
        );
        rpc.blockNumber += 100;
        await snapshot.finish();
        expect(getHead).not.toHaveBeenCalled();
        expect(snapshot.proof.block).toMatchObject(checkpoint.block);
    });

    it("rejects replaced checkpoint identity without latest or numeric state fallback", async () => {
        const rpc = new HeavyMakerRpc();
        const reorg = await factory(rpc)(scope);
        await reorg.validate(heavyMakerOrder(0));
        rpc.blockHash = `0x${"cd".repeat(32)}`;
        await expect(reorg.finish()).rejects.toMatchObject({
            check: {
                chainId: HEAVY_MAKER.chainId,
                blockNumber: HEAVY_MAKER.blockNumber,
                blockHash: HEAVY_MAKER.blockHash,
            },
            observedHash: rpc.blockHash,
        });
        const read = vi
            .spyOn(rpc, "readContractAtBlock")
            .mockRejectedValue(new Error("EIP-1898 unsupported"));
        const legacy = vi.spyOn(rpc, "readContract");
        legacy.mockClear();
        const retry = await factory(rpc)(scope);
        await expect(retry.validate(heavyMakerOrder(1))).rejects.toThrow(
            OrderValidationSnapshotUnavailable,
        );
        expect(read).toHaveBeenCalled();
        expect(legacy).not.toHaveBeenCalled();
    });
});
