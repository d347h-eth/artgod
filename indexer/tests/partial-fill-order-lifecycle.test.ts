import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { capturedOpenSeaPartialCollectionOffer as captured } from "@artgod/shared/testing/opensea-offers";
import { MARKET_DATA_STORAGE_POLICY } from "@artgod/shared/market-data/storage-policy";
import { SEAPORT_ORDER_TYPE } from "@artgod/shared/market-data/seaport";
import { normalizeOpenSeaBuyOrder } from "../src/application/offchain/opensea-bidding-order-terms.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { ValidateOrderDemand } from "../src/application/orders/validate-order-demand.js";
import { ApplyOrderUpdate } from "../src/application/orders/apply-order-update.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { SqliteMarketDataMaintenance } from "../src/infra/storage/sqlite-market-data-maintenance.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
    ORDER_SIDE,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    type OrderSide,
} from "../src/domain/orders.js";
import {
    ORDER_UPDATE_REASON,
    type OrderUpsertPayload,
} from "../src/domain/order-jobs.js";
import { ORDER_VALIDATION_DEMAND_POLICY } from "../src/domain/order-validation-demand.js";
import {
    MAKER_TRIGGER_SCOPE,
    GLOBAL_MAKER_TRIGGER_REASON,
} from "../src/domain/maker-triggers.js";
import { OFFCHAIN_ORDER_SOURCE } from "../src/domain/offchain-jobs.js";
import { remainingOrderQuantity } from "../src/domain/order-quantity.js";
import { computeSeaportOrderHash } from "../src/domain/seaport-protocol.js";
import type { RpcProviderPort } from "../src/ports/rpc.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    heavyMakerOrder,
} from "./fixtures/heavy-maker.js";
import { validationChainFixture } from "./helpers/validation-chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { insertCollection } from "./helpers/ownership-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";

const NOW = 1_792_400_000;
const BLOCK = 26_214_320;
const terms = normalizeOpenSeaBuyOrder(captured, {});
const ID = captured.order_hash;
const hash = (number: number) => syncBlockFixture(number).hash;
let collectionId: number;
let clockMs = NOW * 1000;

class PartialRpc extends HeavyMakerRpc {
    filled = 55n;
    size = 100n;
    cancelled = false;
    failStatus = false;
    constructor() {
        super();
        this.blockNumber = BLOCK;
        this.blockTimestamp = NOW;
        this.balance = 600_000_000_000_000_000n;
    }
    override async getBlock(number: number) {
        return {
            ...syncBlockFixture(number),
            timestamp: NOW,
            transactions: [],
        };
    }
    override async readContract<T>(
        params: Parameters<RpcProviderPort["readContract"]>[0],
    ): Promise<T> {
        if (params.functionName !== "getOrderStatus")
            return super.readContract<T>(params);
        this.reads.getOrderStatus = (this.reads.getOrderStatus ?? 0) + 1;
        await this.onRead?.(params);
        if (this.failStatus) throw new Error("fixture status unavailable");
        return [true, this.cancelled, this.filled, this.size] as T;
    }
}
function upsert(
    overrides: Partial<OrderUpsertPayload> = {},
): OrderUpsertPayload {
    return {
        ...terms,
        chainId: 1,
        collectionId,
        source: OFFCHAIN_ORDER_SOURCE.OpenSea,
        sourceStatus: ORDER_SOURCE_STATUS.Active,
        rawSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
        observedAt: NOW,
        ...overrides,
    };
}
function fullOrder(type: number, side: OrderSide) {
    const order = heavyMakerOrder(0, {
        collectionId,
        contract: terms.contract,
        maker: HEAVY_MAKER.smallMaker,
        side,
    });
    const data = order.seaportData!;
    data.orderType = String(type);
    data.startTime = String(NOW - 3600);
    data.endTime = String(NOW + 86400);
    return upsert({
        orderId: computeSeaportOrderHash(data),
        maker: order.maker,
        side,
        tokenId: order.tokenId,
        sourceScopeKind: order.sourceScopeKind ?? undefined,
        seaportData: data,
        price: order.price,
        quantity: "1",
        originalQuantity: undefined,
        validFrom: Number(data.startTime),
        validUntil: Number(data.endTime),
    });
}
function workflow() {
    const rpc = new PartialRpc();
    const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth);
    const store = new SqliteOrderValidationDemand(domain);
    const processor = new ValidateOrderDemand({
        chainId: 1,
        store,
        admission: new FairOrderValidationAdmission(2),
        createSnapshot: createSeaportOrderValidationFactory({
            chainId: 1,
            rpc,
            conduitController: HEAVY_MAKER.controller,
        }),
    });
    const chain = validationChainFixture({
        chainId: 1,
        rpc,
        collectionIds: [collectionId],
    });
    const update = new ApplyOrderUpdate({ chainId: 1, lifecycle: domain });
    return { rpc, domain, store, processor, chain, update };
}
type Work = ReturnType<typeof workflow>;
const row = (id = ID) =>
    db.prepare("SELECT * FROM orders WHERE id=?").get(id) as any;
async function validate(work: Work) {
    await work.chain.apply();
    return work.processor.executeBatch();
}
async function initial(work: Work) {
    work.rpc.filled = 0n;
    work.rpc.blockNumber = BLOCK - 1;
    await work.domain.handleOrderUpsert(upsert());
    await validate(work);
}
async function source(
    work: Work,
    extra: Parameters<ApplyOrderUpdate["execute"]>[0] extends infer T
        ? Partial<T>
        : never = {},
) {
    await work.update.execute({
        chainId: 1,
        collectionId,
        orderId: ID,
        source: OFFCHAIN_ORDER_SOURCE.OpenSea,
        reason: ORDER_UPDATE_REASON.SourceExecution,
        observedAt: NOW,
        ...extra,
    });
}
async function canonical(
    work: Work,
    reason = ORDER_UPDATE_REASON.Fill,
    id = ID,
) {
    await work.chain.apply();
    const storage = new SqliteStorage();
    db.writeTransaction(() =>
        work.domain.applyCanonicalOrderUpdate(
            {
                chainId: 1,
                orderId: id,
                reason,
                blockNumber: work.rpc.blockNumber,
                blockHash: hash(work.rpc.blockNumber),
                txHash: `0x${"12".repeat(32)}`,
                logIndex: 0,
            },
            storage.captureSyncCheckpoint(1),
            clockMs,
        ),
    )();
}
function rollback(fromBlock: number) {
    const storage = new SqliteStorage();
    const header = syncBlockFixture(fromBlock - 1);
    storage.rollbackFromBlock({
        plan: storage.prepareRollback({ chainId: 1, fromBlock }),
        snapshot: {
            block: {
                blockNumber: header.number,
                blockHash: header.hash,
                parentHash: header.parentHash,
                blockTimestamp: NOW,
            },
            owners: [],
        },
    });
}

describe("partial-order lifecycle through the applied validation owner", () => {
    loadTestEnv();
    beforeEach(async () => {
        clockMs = NOW * 1000;
        vi.spyOn(Date, "now").mockImplementation(() => clockMs);
        for (const level of ["info", "warn", "error", "debug"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        collectionId = insertCollection({
            chainId: 1,
            slug: "partial-order-fixture",
            address: terms.contract,
            anchorBlock: BLOCK - 2,
        });
    });
    afterEach(() => vi.restoreAllMocks());

    it("separates declared size from unknown remaining quantity until applied validation", async () => {
        const w = workflow();
        await w.domain.handleOrderUpsert(upsert());
        expect(row()).toMatchObject({
            fillability_status: ORDER_STATUS.Unvalidated,
            original_quantity: "100",
            quantity: null,
            fillable_quantity: null,
            proof_block_number: null,
        });
        expect(w.store.get(1, ID)?.pending).toBe(true);
        expect(await w.processor.executeBatch()).toBeUndefined();
        expect(w.rpc.reads).toEqual({});
        expect((await validate(w))?.applied).toBe(1);
        expect(row()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            quantity: "45",
            fillable_quantity: "10",
            proof_block_number: BLOCK,
        });
    });

    it.each([0n, 360_000_000_000_000_000n, 6_000_000_000_000_000_000n])(
        "keeps funded allowance %s separate from original and remaining units",
        async (allowance) => {
            const w = workflow();
            w.rpc.allowance = allowance;
            await w.domain.handleOrderUpsert(upsert());
            await validate(w);
            expect(row()).toMatchObject({
                original_quantity: "100",
                quantity: "45",
                fillable_quantity:
                    allowance === 0n
                        ? "0"
                        : allowance === 360_000_000_000_000_000n
                          ? "6"
                          : "10",
                fillability_status:
                    allowance === 0n
                        ? ORDER_STATUS.NoApproval
                        : ORDER_STATUS.Fillable,
            });
        },
    );

    it("retains uncertain first validation without inventing executable state", async () => {
        const w = workflow();
        await w.domain.handleOrderUpsert(upsert());
        w.rpc.failStatus = true;
        await validate(w);
        expect(row()).toMatchObject({
            fillability_status: ORDER_STATUS.Unvalidated,
            quantity: null,
            proof_block_number: null,
        });
        expect(w.store.get(1, ID)).toMatchObject({
            pending: true,
            failures: 1,
        });
        clockMs += ORDER_VALIDATION_DEMAND_POLICY.retryBaseMs;
        w.rpc.failStatus = false;
        w.rpc.balance = 0n;
        await validate(w);
        expect(row()).toMatchObject({
            fillability_status: ORDER_STATUS.NoBalance,
            quantity: "45",
            fillable_quantity: "0",
        });
    });

    it.each([null, "", "malformed", `0x${"31".repeat(32)}`])(
        "retains source sales without requiring transaction metadata %s",
        async (executionTransactionHash) => {
            const w = workflow();
            await initial(w);
            const receipts = vi.spyOn(w.rpc, "getTransactionReceipt");
            await source(w, { executionTransactionHash });
            expect(row()).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Active,
                fillability_status: ORDER_STATUS.Fillable,
                quantity: "100",
            });
            expect(w.store.get(1, ID)).toMatchObject({
                pending: true,
                minimumBlock: null,
            });
            w.rpc.blockNumber = BLOCK;
            w.rpc.filled = 55n;
            await validate(w);
            expect(row()).toMatchObject({
                quantity: "45",
                fillable_quantity: "10",
            });
            expect(receipts).not.toHaveBeenCalled();
        },
    );

    it("coalesces a repeated useful observation without using future source time as coverage", async () => {
        const w = workflow();
        await initial(w);
        await source(w, { observedAt: NOW + 86400 });
        const required = w.store.get(1, ID)!;
        await source(w, { observedAt: NOW + 86400 });
        expect(w.store.get(1, ID)).toMatchObject({
            generation: required.generation,
            admissionSequence: required.admissionSequence,
        });
        w.rpc.blockNumber = BLOCK;
        w.rpc.filled = 55n;
        await validate(w);
        expect(row()?.quantity).toBe("45");
        expect(w.store.get(1, ID)?.pending).toBe(false);
    });

    it("preserves canonical remaining quantity through source quantity refreshes", async () => {
        const w = workflow();
        await w.domain.handleOrderUpsert(upsert());
        await validate(w);
        for (const quantity of ["100", "55", "1"]) {
            await w.domain.handleOrderUpsert(upsert({ quantity }));
            expect(row()).toMatchObject({
                original_quantity: "100",
                quantity: "45",
                fillable_quantity: "10",
            });
        }
        expect(w.store.get(1, ID)?.pending).toBe(true);
        await validate(w);
        expect(row()?.quantity).toBe("45");
    });

    it("rechecks funded capacity from durable freshness without another source event", async () => {
        const w = workflow();
        w.rpc.balance = 0n;
        await w.domain.handleOrderUpsert(upsert());
        await validate(w);
        expect(row()?.fillability_status).toBe(ORDER_STATUS.NoBalance);
        clockMs +=
            (MARKET_DATA_STORAGE_POLICY.orderRevalidationSeconds + 1) * 1000;
        w.rpc.balance = 600_000_000_000_000_000n;
        // The first tick admits freshness after this sample; a later sample covers it.
        await validate(w);
        await validate(w);
        expect(row()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            quantity: "45",
            fillable_quantity: "10",
        });
    });

    it.each([0n, 55n, 99n, 100n])(
        "derives cumulative remaining quantity from protocol fill %s",
        async (filled) => {
            const w = workflow();
            await initial(w);
            w.rpc.blockNumber = BLOCK;
            w.rpc.filled = filled;
            await canonical(w);
            await validate(w);
            expect(row()).toMatchObject({
                quantity: String(100n - filled),
                fillability_status:
                    filled === 100n
                        ? ORDER_STATUS.Filled
                        : ORDER_STATUS.Fillable,
            });
        },
    );

    it.each([
        [101n, 100n],
        [1n, 0n],
        [1n, 3n],
    ])(
        "retains last result when protocol fraction %s/%s is impossible",
        async (filled, size) => {
            const w = workflow();
            await initial(w);
            w.rpc.blockNumber = BLOCK;
            w.rpc.filled = filled;
            w.rpc.size = size;
            await canonical(w);
            await validate(w);
            expect(row()).toMatchObject({
                quantity: "100",
                fillability_status: ORDER_STATUS.Fillable,
                proof_block_number: BLOCK - 1,
            });
            expect(w.store.get(1, ID)?.pending).toBe(true);
        },
    );

    it("interprets fractions as ratios rather than original NFT counts", () => {
        expect(remainingOrderQuantity(100n, 11n, 20n)).toBe(45n);
        expect(remainingOrderQuantity(100n, 0n, 0n)).toBe(100n);
        expect(() => remainingOrderQuantity(100n, 1n, 3n)).toThrow(
            "Non-integral",
        );
    });

    it.each(
        [
            SEAPORT_ORDER_TYPE.FullOpen,
            SEAPORT_ORDER_TYPE.FullRestricted,
            SEAPORT_ORDER_TYPE.PartialOpen,
            SEAPORT_ORDER_TYPE.PartialRestricted,
        ].flatMap((type) =>
            [ORDER_SIDE.Buy, ORDER_SIDE.Sell].map((side) => ({ type, side })),
        ),
    )(
        "retains signed fixed size for $side type$type and validates a source sale",
        async ({ type, side }) => {
            const w = workflow();
            const payload = fullOrder(type, side);
            w.rpc.filled = 0n;
            w.rpc.size = 0n;
            await w.domain.handleOrderUpsert(payload);
            expect(row(payload.orderId)).toMatchObject({
                original_quantity: "1",
                quantity: null,
            });
            await validate(w);
            await source(w, { orderId: payload.orderId });
            expect(row(payload.orderId)).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Active,
                quantity: "1",
                fillability_status: ORDER_STATUS.Fillable,
            });
            w.rpc.filled = 1n;
            w.rpc.size = 1n;
            w.rpc.blockNumber++;
            await validate(w);
            expect(row(payload.orderId)).toMatchObject({
                quantity: "0",
                fillability_status: ORDER_STATUS.Filled,
            });
        },
    );

    it.each(["balance", "allowance"] as const)(
        "requires the entire signed full-only payment from %s",
        async (limited) => {
            const w = workflow();
            const data = structuredClone(terms.seaportData!);
            data.orderType = String(SEAPORT_ORDER_TYPE.FullOpen);
            const id = computeSeaportOrderHash(data);
            w.rpc.filled = 0n;
            w.rpc.size = 0n;
            w.rpc.balance = BigInt(data.offer[0]!.startAmount);
            w.rpc.allowance = w.rpc.balance;
            w.rpc[limited] /= 10n;
            await w.domain.handleOrderUpsert(
                upsert({ orderId: id, seaportData: data }),
            );
            await validate(w);
            expect(row(id)).toMatchObject({
                original_quantity: "100",
                quantity: "100",
                fillable_quantity: "0",
                fillability_status:
                    limited === "balance"
                        ? ORDER_STATUS.NoBalance
                        : ORDER_STATUS.NoApproval,
            });
            w.rpc[limited] = BigInt(data.offer[0]!.startAmount);
            w.rpc.blockNumber++;
            await source(w, { orderId: id });
            await validate(w);
            expect(row(id)).toMatchObject({
                quantity: "100",
                fillable_quantity: "100",
                fillability_status: ORDER_STATUS.Fillable,
            });
        },
    );

    it("derives buy funding capacity from signed payment rather than source unit price", async () => {
        const w = workflow();
        await w.domain.handleOrderUpsert(upsert({ price: "1" }));
        await validate(w);
        expect(row()).toMatchObject({
            price: terms.price,
            quantity: "45",
            fillable_quantity: "10",
            fillability_status: ORDER_STATUS.Fillable,
        });
    });

    it("does not use an unrelated source currency balance to prove a signed WETH offer fillable", async () => {
        const w = workflow();
        const sourceCurrency = "0x9999999999999999999999999999999999999999";
        const read = w.rpc.readContract.bind(w.rpc);
        vi.spyOn(w.rpc, "readContract").mockImplementation(async (params) =>
            params.functionName === "balanceOf"
                ? params.address.toLowerCase() === sourceCurrency
                    ? 10n ** 24n
                    : 0n
                : read(params),
        );
        await w.domain.handleOrderUpsert(upsert({ currency: sourceCurrency }));
        expect(row()).toMatchObject({ currency: terms.currency });
        expect(
            w.domain
                .selectMakerCandidates(
                    {
                        chainId: 1,
                        maker: terms.maker,
                        scope: MAKER_TRIGGER_SCOPE.Global,
                        reason: GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
                    },
                    "",
                    w.domain.captureMakerPass(),
                    100,
                )
                .map((candidate) => candidate.order.id),
        ).toEqual([ID]);
        await validate(w);
        expect(row()).toMatchObject({
            quantity: "45",
            fillable_quantity: "0",
            fillability_status: ORDER_STATUS.NoBalance,
        });
    });

    it("derives a sell quote from signed payments including fees", async () => {
        const w = workflow();
        const declaration = fullOrder(
            SEAPORT_ORDER_TYPE.FullOpen,
            ORDER_SIDE.Sell,
        );
        const data = structuredClone(declaration.seaportData!);
        data.consideration.push({
            ...data.consideration[0]!,
            startAmount: "10",
            endAmount: "10",
        });
        const id = computeSeaportOrderHash(data);
        await w.domain.handleOrderUpsert({
            ...declaration,
            orderId: id,
            seaportData: data,
            price: "1",
            currency: "0x9999999999999999999999999999999999999999",
        });
        expect(row(id)).toMatchObject({
            price: (
                BigInt(data.consideration[0]!.startAmount) + 10n
            ).toString(),
            currency: HEAVY_MAKER.weth,
        });
    });

    it("leaves a non-integral signed unit quote unknown rather than using a source price", async () => {
        const w = workflow();
        const declaration = fullOrder(
            SEAPORT_ORDER_TYPE.FullOpen,
            ORDER_SIDE.Buy,
        );
        const data = structuredClone(declaration.seaportData!);
        data.consideration[0]!.startAmount = "3";
        data.consideration[0]!.endAmount = "3";
        const id = computeSeaportOrderHash(data);
        await w.domain.handleOrderUpsert({
            ...declaration,
            orderId: id,
            seaportData: data,
            price: "1",
        });
        expect(row(id)).toMatchObject({
            price: null,
            currency: HEAVY_MAKER.weth,
            original_quantity: "3",
        });
    });

    it("does not accept a partial protocol fraction for a full-only declaration", async () => {
        const w = workflow();
        const data = structuredClone(terms.seaportData!);
        data.orderType = String(SEAPORT_ORDER_TYPE.FullOpen);
        const id = computeSeaportOrderHash(data);
        await w.domain.handleOrderUpsert(
            upsert({ orderId: id, seaportData: data }),
        );
        await validate(w);
        expect(row(id)).toMatchObject({
            quantity: null,
            fillability_status: ORDER_STATUS.Unvalidated,
            proof_block_number: null,
        });
        expect(w.store.get(1, id)?.pending).toBe(true);
    });

    it.each(["tokenId", "contract", "side", "sourceScopeKind"] as const)(
        "rejects a source %s that does not identify the signed NFT before admission",
        async (field) => {
            const w = workflow();
            const declaration = fullOrder(
                SEAPORT_ORDER_TYPE.FullOpen,
                ORDER_SIDE.Sell,
            );
            const altered = {
                ...declaration,
                [field]:
                    field === "tokenId"
                        ? "999999"
                        : field === "contract"
                          ? "0x9999999999999999999999999999999999999999"
                          : field === "side"
                            ? ORDER_SIDE.Buy
                            : ORDER_SOURCE_SCOPE_KIND.Collection,
            };
            await expect(w.domain.handleOrderUpsert(altered)).rejects.toThrow(
                /Signed declaration|collection contract/,
            );
            expect(row(declaration.orderId)).toBeUndefined();
            expect(w.store.get(1, declaration.orderId)).toBeNull();
            expect(w.rpc.reads).toEqual({});
        },
    );

    it("does not assign a correctly signed foreign NFT to another collection checkpoint", async () => {
        const w = workflow();
        const declaration = fullOrder(
            SEAPORT_ORDER_TYPE.FullOpen,
            ORDER_SIDE.Sell,
        );
        const contract = "0x9999999999999999999999999999999999999999";
        const data = structuredClone(declaration.seaportData!);
        data.offer[0]!.token = contract;
        const id = computeSeaportOrderHash(data);
        await expect(
            w.domain.handleOrderUpsert({
                ...declaration,
                orderId: id,
                contract,
                seaportData: data,
            }),
        ).rejects.toThrow("collection contract");
        expect(row(id)).toBeUndefined();
        expect(w.store.get(1, id)).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT 1 FROM order_source_observations WHERE order_id=?",
                )
                .get(id),
        ).toBeUndefined();
    });

    it("lets source withdrawal win over an in-flight validation without asserting chain cancellation", async () => {
        const w = workflow();
        await w.domain.handleOrderUpsert(upsert());
        let once = true;
        w.rpc.onRead = async () => {
            if (once) {
                once = false;
                await source(w, {
                    reason: ORDER_UPDATE_REASON.Cancel,
                    sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                });
            }
        };
        await validate(w);
        expect(row()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Inactive,
            fillability_status: ORDER_STATUS.Unvalidated,
            proof_block_number: null,
        });
        expect(w.store.get(1, ID)?.pending).toBe(false);
    });

    it("keeps another source available after one source withdraws", async () => {
        const w = workflow();
        await w.domain.handleOrderUpsert(upsert());
        await w.domain.handleOrderUpsert(upsert({ source: "fixture-peer" }));
        await validate(w);
        await source(w, {
            reason: ORDER_UPDATE_REASON.Cancel,
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
        });
        expect(row()?.source_status).toBe(ORDER_SOURCE_STATUS.Active);
        expect(
            db
                .prepare(
                    "SELECT source_status FROM order_source_observations WHERE order_id=? AND source_id=?",
                )
                .get(ID, OFFCHAIN_ORDER_SOURCE.OpenSea),
        ).toEqual({ source_status: ORDER_SOURCE_STATUS.Cancelled });
    });

    it("preserves source withdrawal that arrives before declaration", async () => {
        const w = workflow();
        await source(w, {
            reason: ORDER_UPDATE_REASON.Cancel,
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
        });
        await w.domain.handleOrderUpsert(upsert());
        expect(row()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Inactive,
            fillability_status: ORDER_STATUS.Unvalidated,
            quantity: null,
        });
        expect(await validate(w)).toBeUndefined();
    });

    it("only the sync writer can directly establish canonical cancellation", async () => {
        const w = workflow();
        await initial(w);
        w.rpc.blockNumber = BLOCK;
        await w.chain.apply();
        await expect(
            w.update.execute({
                chainId: 1,
                orderId: ID,
                reason: ORDER_UPDATE_REASON.Cancel,
                blockNumber: BLOCK,
                blockHash: hash(BLOCK),
            } as unknown as Parameters<ApplyOrderUpdate["execute"]>[0]),
        ).rejects.toThrow("source");
        expect(row()?.fillability_status).toBe(ORDER_STATUS.Fillable);
        await canonical(w, ORDER_UPDATE_REASON.Cancel);
        expect(row()).toMatchObject({
            fillability_status: ORDER_STATUS.Cancelled,
            proof_block_number: BLOCK,
        });
    });

    it("keeps newer observation generation pending while an older proof finishes", async () => {
        const w = workflow();
        await w.domain.handleOrderUpsert(upsert());
        let once = true;
        w.rpc.onRead = async () => {
            if (once) {
                once = false;
                await source(w, {
                    executionTransactionHash: `0x${"77".repeat(32)}`,
                });
            }
        };
        await validate(w);
        expect(row()?.quantity).toBe("45");
        expect(w.store.get(1, ID)?.pending).toBe(true);
        w.rpc.onRead = undefined;
        await validate(w);
        expect(w.store.get(1, ID)?.pending).toBe(false);
    });

    it.each([55n, 100n])(
        "restores declaration after orphaning a protocol result with %s filled",
        async (filled) => {
            const w = workflow();
            await initial(w);
            w.rpc.blockNumber = BLOCK;
            w.rpc.filled = filled;
            await canonical(w);
            await validate(w);
            rollback(BLOCK);
            expect(row()).toMatchObject({
                fillability_status: ORDER_STATUS.Unvalidated,
                original_quantity: "100",
                quantity: null,
                proof_block_number: null,
            });
            expect(w.store.get(1, ID)).toMatchObject({
                pending: true,
                minimumBlock: null,
            });
            w.rpc.filled = 0n;
            await validate(w);
            expect(row()).toMatchObject({
                fillability_status: ORDER_STATUS.Fillable,
                quantity: "100",
                proof_block_number: BLOCK,
            });
        },
    );

    it("invalidates latest proof after an unchanged result without erasing its older canonical attribution", async () => {
        const w = workflow();
        await initial(w);
        await source(w);
        w.rpc.blockNumber = BLOCK;
        await validate(w);
        expect(row()).toMatchObject({
            block_number: BLOCK - 1,
            proof_block_number: BLOCK,
            quantity: "100",
        });
        db.prepare("DELETE FROM order_validation_demand WHERE order_id=?").run(
            ID,
        );
        rollback(BLOCK);
        expect(row()).toMatchObject({
            block_number: BLOCK - 1,
            proof_block_number: null,
            quantity: "100",
            fillability_status: ORDER_STATUS.Fillable,
        });
        expect(w.store.get(1, ID)?.pending).toBe(true);
    });

    it("rolls back order and demand changes atomically when the writer fails", async () => {
        const w = workflow();
        await initial(w);
        w.rpc.blockNumber = BLOCK;
        w.rpc.filled = 55n;
        await canonical(w);
        await validate(w);
        const before = row(),
            demand = w.store.get(1, ID);
        db.exec(
            "CREATE TEMP TRIGGER reject_fixture_rollback BEFORE UPDATE ON order_validation_demand BEGIN SELECT RAISE(ABORT,'fixture rollback failure'); END",
        );
        try {
            expect(() => rollback(BLOCK)).toThrow("fixture rollback failure");
            expect(row()).toEqual(before);
            expect(w.store.get(1, ID)).toEqual(demand);
        } finally {
            db.exec("DROP TRIGGER reject_fixture_rollback");
        }
    });

    it("retains unexpired terminal declarations through maintenance so delayed reorg recovery can reopen them", async () => {
        const w = workflow();
        await initial(w);
        w.rpc.blockNumber = BLOCK;
        w.rpc.filled = 100n;
        await canonical(w);
        await validate(w);
        const afterGrace =
            NOW + MARKET_DATA_STORAGE_POLICY.orderReorgGraceSeconds + 1;
        db.prepare(
            "UPDATE orders SET updated_at=datetime(?,'unixepoch') WHERE id=?",
        ).run(NOW, ID);
        new SqliteMarketDataMaintenance(db).maintainBatch(afterGrace);
        expect(row()).toMatchObject({
            fillability_status: ORDER_STATUS.Filled,
            quantity: "0",
        });
        rollback(BLOCK);
        expect(row()?.fillability_status).toBe(ORDER_STATUS.Unvalidated);
    });

    it("admits a new source in the same second as inactivity retirement", async () => {
        const w = workflow();
        await w.domain.handleOrderUpsert(upsert());
        await source(w, {
            reason: ORDER_UPDATE_REASON.Cancel,
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
        });
        // An unchanged inactive declaration may be observed more recently than
        // its last state change; cleanup retains that observation's second.
        db.prepare(
            "UPDATE orders SET updated_at=datetime(?,'unixepoch') WHERE id=?",
        ).run(
            NOW - MARKET_DATA_STORAGE_POLICY.inactiveOrderGraceSeconds - 1,
            ID,
        );
        new SqliteMarketDataMaintenance(db).maintainBatch(NOW);
        expect(row()).toBeUndefined();
        expect(
            db
                .prepare(
                    "SELECT retired_at FROM market_order_retirements WHERE order_id=?",
                )
                .get(ID),
        ).toEqual({ retired_at: NOW });
        await w.domain.handleOrderUpsert(
            upsert({ source: "new-peer-fixture" }),
        );
        expect(row()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Active,
            fillability_status: ORDER_STATUS.Unvalidated,
        });
        expect(w.store.get(1, ID)?.pending).toBe(true);
        expect(
            db
                .prepare(
                    "SELECT source_status FROM order_source_observations WHERE order_id=? AND source_id=?",
                )
                .get(ID, OFFCHAIN_ORDER_SOURCE.OpenSea),
        ).toEqual({ source_status: ORDER_SOURCE_STATUS.Cancelled });
    });

    it("rejects incompatible signed identity without replacing the retained declaration", async () => {
        const w = workflow();
        await w.domain.handleOrderUpsert(upsert());
        const before = row();
        const incompatible = {
            ...terms.seaportData!,
            orderType: String(SEAPORT_ORDER_TYPE.FullOpen),
        };
        await expect(
            w.domain.handleOrderUpsert(upsert({ seaportData: incompatible })),
        ).rejects.toThrow("declaration");
        expect(row()).toEqual(before);
    });
});
