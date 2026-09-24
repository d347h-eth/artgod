import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@artgod/shared/utils";
import { zeroAddress } from "viem";
import { computeSeaportOrderHash } from "../src/application/offchain/seaport-protocol.js";
import {
    createSeaportValidationBatchFactory,
    createSeaportOrderValidationFactory,
    OrderValidationSnapshotUnavailable,
} from "../src/application/offchain/seaport-validation-batch.js";
import { ORDER_VALIDATION_BATCH_POLICY as POLICY } from "../src/domain/order-validation-policy.js";
import { ORDER_STATUS, type OrderRecord } from "../src/domain/orders.js";
import type { ConduitRegistryPort } from "../src/ports/conduits.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    heavyMakerOrder,
    warmConduits,
} from "./fixtures/heavy-maker.js";

function factory(
    rpc: HeavyMakerRpc,
    options: {
        chainId?: number;
        wethAddress?: string;
        conduits?: ConduitRegistryPort;
        now?: () => number;
    } = {},
) {
    return createSeaportValidationBatchFactory({
        rpc,
        chainId: HEAVY_MAKER.chainId,
        wethAddress: HEAVY_MAKER.weth,
        conduits: warmConduits,
        conduitController: HEAVY_MAKER.controller,
        now: () => HEAVY_MAKER.now * 1_000,
        ...options,
    });
}
const scope = {
    chainId: HEAVY_MAKER.chainId,
    minimumBlock: HEAVY_MAKER.blockNumber,
};

describe("bounded Seaport validation snapshots", () => {
    beforeEach(() =>
        vi.spyOn(Date, "now").mockReturnValue(HEAVY_MAKER.now * 1_000),
    );
    afterEach(() => vi.restoreAllMocks());

    it("pins native balance and sell checks in full-order snapshots, propagating native RPC failure", async () => {
        vi.spyOn(logger, "error").mockImplementation(() => {});
        const rpc = new HeavyMakerRpc();
        const getBalance = vi.spyOn(rpc, "getBalance");
        const create = createSeaportOrderValidationFactory({
            chainId: HEAVY_MAKER.chainId,
            rpc,
            conduits: warmConduits,
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
            blockNumber: HEAVY_MAKER.blockNumber,
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
            blockNumber: HEAVY_MAKER.blockNumber,
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
        const blocks = new Set<number | undefined>();
        rpc.onRead = (params) => {
            blocks.add(params.blockNumber);
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
        });
        expect(blocks).toEqual(new Set([HEAVY_MAKER.blockNumber]));
        await expect(batch.validate(heavyMakerOrder(3))).rejects.toThrow(
            OrderValidationSnapshotUnavailable,
        );
    });

    it("separates makers, protocol counters and allowance spenders", async () => {
        const rpc = new HeavyMakerRpc();
        const secondConduit = "0x7777777777777777777777777777777777777777";
        const secondKey = `0x${"02".repeat(32)}`;
        const batch = await factory(rpc, {
            conduits: {
                ...warmConduits,
                getConduit: (_chain, key) =>
                    key === secondKey ? secondConduit : HEAVY_MAKER.conduit,
            },
        })(scope);
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
        });
    });

    it("rejects cross-chain, other-currency, sell and native orders instead of leaking a snapshot", async () => {
        const rpc = new HeavyMakerRpc();
        const batch = await factory(rpc)(scope);
        for (const change of [
            { chainId: 2 },
            { currency: "0x9999999999999999999999999999999999999999" },
            { side: "sell" as const },
            { currency: null },
        ]) {
            await expect(
                batch.validate(heavyMakerOrder(0, change)),
            ).rejects.toThrow("requires WETH bids");
        }
        await expect(factory(rpc)({ ...scope, chainId: 2 })).rejects.toThrow(
            "chain mismatch",
        );
        expect(rpc.reads).toEqual({});
        const chainTwo = await factory(rpc, { chainId: 2 })({
            ...scope,
            chainId: 2,
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
            reason: "order-hash-mismatch",
        });
        expect(rpc.reads).toEqual({});
        rpc.counter = 1n;
        expect(await batch.validate(heavyMakerOrder(1))).toMatchObject({
            status: ORDER_STATUS.Cancelled,
            reason: "counter-mismatch",
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
            const batch = await factory(rpc, {
                conduits: {
                    getConduit: () => null,
                    hasChannel: () => false,
                    upsertConduit: () => {},
                    replaceChannels: () => {},
                },
            })(scope);
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
        const second = await create(scope);
        expect((await second.validate(heavyMakerOrder(1))).status).toBe(
            ORDER_STATUS.Fillable,
        );
        await second.finish();
        expect(rpc.reads.balanceOf).toBe(2);
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

    it("rejects lagging heads, reorgs, stale blocks and excessive head advance before commit", async () => {
        const rpc = new HeavyMakerRpc();
        await expect(
            factory(rpc)({ ...scope, minimumBlock: rpc.blockNumber + 1 }),
        ).rejects.toThrow("precedes maker trigger");
        await expect(
            factory(rpc, {
                now: () =>
                    (HEAVY_MAKER.now + POLICY.maxBlockAgeSeconds + 1) * 1_000,
            })(scope),
        ).rejects.toThrow("stale or unavailable");
        const reorg = await factory(rpc)(scope);
        await reorg.validate(heavyMakerOrder(0));
        rpc.blockHash = `0x${"cd".repeat(32)}`;
        await expect(reorg.finish()).rejects.toThrow("changed before commit");
        const advancing = await factory(rpc)(scope);
        rpc.blockNumber += POLICY.maxHeadAdvance + 1;
        await expect(advancing.finish()).rejects.toThrow(
            "changed before commit",
        );
    });
});
