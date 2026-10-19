import { SqliteMarketDataMaintenance } from "../src/infra/storage/sqlite-market-data-maintenance.js";
import { SqliteOrderExecutionRequirements } from "../src/infra/orders/sqlite-order-execution-requirements.js";
import { ResolveOrderExecutions } from "../src/application/orders/resolve-order-executions.js";
import type { OrderUpdateByIdPayload } from "../src/domain/order-jobs.js";
import { ApplyOrderUpdate } from "../src/application/orders/apply-order-update.js";
import { AdmitOrderValidation } from "../src/application/orders/validate-order-demand.js";
import { CanonicalOrderExecutionBlock } from "../src/application/orders/execution-block.js";
import { normalizeOpenSeaOrderUpdate } from "../src/application/offchain/opensea-normalize.js";
import { OPENSEA_STREAM_EVENT_TYPE } from "@artgod/shared/opensea/payload";
import { MARKET_DATA_STORAGE_POLICY } from "@artgod/shared/market-data/storage-policy";
import { FILL_KIND } from "@artgod/shared/market-data/fills";
import { SqliteBidderIndex } from "../src/infra/bidder-index/sqlite.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { capturedOpenSeaPartialCollectionOffer as captured } from "@artgod/shared/testing/opensea-offers";
import { SEAPORT_ORDER_TYPE } from "@artgod/shared/market-data/seaport";
import { ORDER_PROCESSING_POLICY } from "../src/domain/order-processing.js";
import {
    ORDER_SOURCE_STATUS,
    ORDER_SIDE,
    ORDER_STATUS,
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    type OrderSide,
} from "../src/domain/orders.js";
import { OFFCHAIN_ORDER_SOURCE } from "../src/domain/offchain-jobs.js";
import {
    ORDER_UPDATE_REASON,
    type OrderUpsertPayload,
} from "../src/domain/order-jobs.js";
import {
    eventValidationRequest,
    ORDER_VALIDATION_DEMAND_POLICY,
} from "../src/domain/order-validation-demand.js";
import { remainingOrderQuantity } from "../src/domain/order-quantity.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import { advanceChainSyncRevision } from "../src/infra/storage/sqlite-chain-revisions.js";
import { ValidateOrderDemand } from "../src/application/orders/validate-order-demand.js";
import { normalizeOpenSeaBuyOrder } from "../src/application/offchain/opensea-bidding-order-terms.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { computeSeaportOrderHash } from "../src/application/offchain/seaport-protocol.js";
import type { RpcProviderPort } from "../src/ports/rpc.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    warmConduits,
    heavyMakerOrder,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { insertCollection } from "./helpers/ownership-fixture.js";
import { emptyOnChainData } from "./helpers/ownership-fixture.js";
import {
    syncBlockFixture,
    FINALIZED_SYNC_CHECK_POLICY,
} from "./helpers/chain-fixture.js";
import {
    RecoveryRpc,
    reorgRecoveryServices,
} from "./helpers/reorg-recovery-fixture.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import { RevalidateMakerOrders } from "../src/application/orders/revalidate-maker.js";
import { heavyMakerHint } from "./fixtures/heavy-maker.js";
import { StoredBlockHashConflict } from "../src/domain/chain-sync.js";

const NOW = 1_792_400_000;
const BLOCK = 26_214_320;
const terms = normalizeOpenSeaBuyOrder(captured, {});
const ID = captured.order_hash;
const FULL_ONLY_ORDERS = [
    SEAPORT_ORDER_TYPE.FullOpen,
    SEAPORT_ORDER_TYPE.FullRestricted,
].flatMap((type) =>
    [ORDER_SIDE.Buy, ORDER_SIDE.Sell].map((side) => ({ type, side })),
);
let collectionId: number;
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
    override async readContract<T>(
        params: Parameters<RpcProviderPort["readContract"]>[0],
    ): Promise<T> {
        if (params.functionName === "getOrderStatus") {
            this.reads.getOrderStatus = (this.reads.getOrderStatus ?? 0) + 1;
            await this.onRead?.(params);
            if (this.failStatus) throw new Error("status unavailable");
            return [true, this.cancelled, this.filled, this.size] as T;
        }
        return super.readContract<T>(params);
    }
}
function workflow() {
    const rpc = new PartialRpc();
    const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth, async () => {
        throw new Error("Must use pinned demand validation");
    });
    const store = new SqliteOrderValidationDemand(domain);
    const processor = new ValidateOrderDemand({
        chainId: 1,
        store,
        admission: new FairOrderValidationAdmission(
            ORDER_PROCESSING_POLICY.concurrentValidations,
        ),
        createSnapshot: createSeaportOrderValidationFactory({
            chainId: 1,
            rpc,
            conduits: warmConduits,
            conduitController: HEAVY_MAKER.controller,
        }),
    });
    return { rpc, domain, store, processor };
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
        validateAfterUpsert: true,
        ...overrides,
    };
}
function stored(id = ID) {
    return db
        .prepare(
            "SELECT fillability_status,source_status,quantity,original_quantity,fillable_quantity,state_revision FROM orders WHERE id=?",
        )
        .get(id);
}
function fullOnlyUpsert(type: number, side: OrderSide): OrderUpsertPayload {
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
        originalQuantity: "1",
        validFrom: Number(data.startTime),
        validUntil: Number(data.endTime),
    });
}
async function fill(work: ReturnType<typeof workflow>, block = BLOCK) {
    await work.domain.handleOrderUpdateById({
        chainId: 1,
        orderId: ID,
        reason: ORDER_UPDATE_REASON.Fill,
        blockNumber: block,
    });
}
async function initialSnapshot(work: ReturnType<typeof workflow>) {
    work.rpc.filled = 0n;
    work.rpc.blockNumber = BLOCK - 1;
    await work.domain.handleOrderUpsert(upsert({ quantity: "100" }));
    await work.processor.executeBatch();
}

describe("canonical partial fill quantity progression", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
        for (const level of ["info", "warn", "error"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        db.exec(
            "DELETE FROM maker_order_revalidation_runs;DELETE FROM queue_outbox;DELETE FROM chain_reorg_recoveries;DELETE FROM blocks;DELETE FROM market_order_retirements;DELETE FROM orders;DELETE FROM chain_sync_revisions;DELETE FROM collections;",
        );
        collectionId = insertCollection({
            chainId: 1,
            slug: "partial-order-fixture",
            address: terms.contract,
            anchorBlock: BLOCK - 1000,
        });
    });
    afterEach(() => vi.restoreAllMocks());

    it.each([
        { maker: false, retire: false },
        { maker: true, retire: false },
        { maker: false, retire: true },
        { maker: true, retire: true },
    ])(
        "discovers a validation-only fork and restores the remaining unit (maker=$maker, retirement=$retire)",
        async ({ maker, retire }) => {
            const work = workflow();
            let forked = false;
            const header = (number: number) => {
                const hash = (n: number) =>
                    syncBlockFixture(forked && n >= BLOCK ? n + 10_000 : n)
                        .hash;
                return {
                    ...syncBlockFixture(number),
                    hash: hash(number),
                    parentHash: hash(number - 1),
                    timestamp: NOW,
                };
            };
            vi.spyOn(work.rpc, "getBlock").mockImplementation(async (number) =>
                header(number),
            );
            await initialSnapshot(work);
            work.rpc.blockNumber = BLOCK;
            work.rpc.filled = 100n;
            if (maker) {
                const processor = new RevalidateMakerOrders({
                    store: new SqliteMakerRevalidations(
                        work.domain,
                        work.store,
                    ),
                    admission: new FairOrderValidationAdmission(2),
                    createSnapshot: createSeaportOrderValidationFactory({
                        chainId: 1,
                        rpc: work.rpc,
                        conduits: warmConduits,
                        conduitController: HEAVY_MAKER.controller,
                    }),
                });
                await processor.execute({
                    jobId: "validation-only-fork",
                    payload: {
                        ...heavyMakerHint(terms.maker),
                        blockNumber: BLOCK,
                    },
                });
            } else {
                await fill(work);
                await work.processor.executeBatch();
            }
            expect(stored()).toMatchObject({
                fillability_status: ORDER_STATUS.Filled,
                quantity: "0",
            });
            const original = header(BLOCK);
            expect(
                db
                    .prepare(
                        "SELECT block_number,block_hash FROM orders WHERE id=?",
                    )
                    .get(ID),
            ).toEqual({ block_number: BLOCK, block_hash: original.hash });
            expect(
                db
                    .prepare(
                        "SELECT block_hash,canonical_check_pending FROM blocks WHERE chain_id=1 AND block_number=?",
                    )
                    .get(BLOCK),
            ).toEqual({
                block_hash: original.hash,
                canonical_check_pending: 1,
            });
            expect(
                db
                    .prepare(
                        "SELECT 1 FROM collection_sync_blocks WHERE block_number=?",
                    )
                    .get(BLOCK),
            ).toBeUndefined();
            // Reorg discovery must survive the disposable coverage cache and order row.
            db.prepare(
                "DELETE FROM order_validation_demand WHERE order_id=?",
            ).run(ID);
            if (retire) {
                const afterGrace =
                    NOW + MARKET_DATA_STORAGE_POLICY.orderReorgGraceSeconds + 1;
                db.prepare(
                    "UPDATE orders SET updated_at=datetime(?,'unixepoch') WHERE id=?",
                ).run(NOW, ID);
                new SqliteMarketDataMaintenance(db).maintainBatch(afterGrace);
                expect(stored()).toBeUndefined();
                expect(
                    db
                        .prepare(
                            "SELECT block_number FROM market_order_retirements WHERE order_id=?",
                        )
                        .get(ID),
                ).toEqual({ block_number: BLOCK });
            }
            forked = true;
            const recoveryRpc = new RecoveryRpc(BLOCK - 1, BLOCK + 2);
            vi.spyOn(recoveryRpc, "getBlock").mockImplementation(
                async (number) => header(number),
            );
            // Fresh service objects simulate a restart; no check is manually enqueued.
            const recovery = reorgRecoveryServices(recoveryRpc);
            expect(() =>
                recovery.storage.persistSyncResult({
                    checkpoint: recovery.storage.captureSyncCheckpoint(1),
                    canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
                    blocks: [header(BLOCK)],
                    collections: [],
                    data: emptyOnChainData(),
                }),
            ).toThrow(StoredBlockHashConflict);
            expect(recovery.storage.getBlockHash(1, BLOCK)).toBe(original.hash);
            for (
                let attempts = 0;
                attempts < 3 &&
                recovery.storage.captureSyncCheckpoint(1).revision === 0;
                attempts++
            ) {
                expect(await recovery.recovery.checkDue()).toBe(true);
            }
            expect(recovery.storage.captureSyncCheckpoint(1).revision).toBe(1);
            expect(
                db
                    .prepare(
                        "SELECT 1 FROM market_order_retirements WHERE order_id=?",
                    )
                    .get(ID),
            ).toBeUndefined();
            if (retire) await work.domain.handleOrderUpsert(upsert());
            else
                expect(stored()).toMatchObject({
                    fillability_status: ORDER_STATUS.Unvalidated,
                    quantity: "100",
                });
            work.rpc.blockNumber = BLOCK + 2;
            work.rpc.filled = 99n;
            expect((await work.processor.executeBatch())?.applied).toBe(1);
            expect(stored()).toMatchObject({
                fillability_status: ORDER_STATUS.Fillable,
                quantity: "1",
                fillable_quantity: "1",
            });
        },
    );

    it("rejects a validation whose height was committed on another fork after snapshot finish", async () => {
        const work = workflow();
        await initialSnapshot(work);
        work.rpc.blockNumber = BLOCK;
        work.rpc.filled = 100n;
        await fill(work);
        const replacement = { ...syncBlockFixture(BLOCK), timestamp: NOW };
        const complete = work.store.completeBatch.bind(work.store);
        vi.spyOn(work.store, "completeBatch").mockImplementationOnce(
            (completions, proof, now) => {
                new SqliteStorage().persistSyncResult({
                    checkpoint: proof.checkpoint,
                    canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
                    blocks: [replacement],
                    collections: [],
                    data: emptyOnChainData(),
                });
                return complete(completions, proof, now);
            },
        );
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            quantity: "100",
        });
        expect(work.store.get(1, ID)).toMatchObject({
            pending: true,
            failures: 1,
        });
        expect(
            db
                .prepare(
                    "SELECT block_hash,canonical_check_pending FROM blocks WHERE chain_id=1 AND block_number=?",
                )
                .get(BLOCK),
        ).toEqual({ block_hash: replacement.hash, canonical_check_pending: 1 });
        work.rpc.filled = 99n;
        vi.spyOn(work.rpc, "getBlock").mockResolvedValue(replacement);
        vi.spyOn(Date, "now").mockReturnValue((NOW + 2) * 1000);
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            quantity: "1",
        });
    });

    it("rolls back header registration when validation effects fail to commit", async () => {
        const work = workflow();
        await initialSnapshot(work);
        work.rpc.blockNumber = BLOCK;
        work.rpc.filled = 100n;
        await fill(work);
        db.exec(
            "CREATE TEMP TRIGGER reject_validation_effect BEFORE UPDATE ON orders BEGIN SELECT RAISE(ABORT,'validation writer failed'); END;",
        );
        try {
            await work.processor.executeBatch();
            expect(new SqliteStorage().getBlockHash(1, BLOCK)).toBeNull();
            expect(stored()).toMatchObject({
                fillability_status: ORDER_STATUS.Fillable,
                quantity: "100",
            });
            expect(work.store.get(1, ID)).toMatchObject({
                pending: true,
                failures: 1,
                proofBlock: BLOCK - 1,
            });
        } finally {
            db.exec("DROP TRIGGER reject_validation_effect;");
        }
    });

    it("admits new orders optimistically and validates their remaining and funded quantities", async () => {
        const work = workflow();
        await work.domain.handleOrderUpsert(upsert());
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            source_status: ORDER_SOURCE_STATUS.Active,
            original_quantity: "100",
            quantity: "45",
            fillable_quantity: null,
        });
        const bidders = new SqliteBidderIndex();
        expect(await bidders.load(1)).toContain(terms.maker);
        expect(work.store.get(1, ID)?.pending).toBe(true);
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            quantity: "45",
            fillable_quantity: "10",
        });
        work.rpc.filled = 100n;
        await fill(work, BLOCK + 1);
        work.rpc.blockNumber = BLOCK + 1;
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Filled,
        });
        expect(await bidders.load(1)).not.toContain(terms.maker);
    });

    it("retains optimistic admission and durable demand through an RPC failure, then applies validation", async () => {
        const work = workflow();
        await work.domain.handleOrderUpsert(upsert());
        const admitted = stored();
        expect(admitted).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
        });
        work.rpc.failStatus = true;
        await work.processor.executeBatch();
        expect(stored()).toEqual(admitted);
        const pending = work.store.get(1, ID)!;
        expect(pending).toMatchObject({ pending: true, failures: 1 });

        vi.spyOn(Date, "now").mockReturnValue(
            NOW * 1000 + ORDER_VALIDATION_DEMAND_POLICY.retryBaseMs,
        );
        work.rpc.failStatus = false;
        work.rpc.balance = 0n;
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.NoBalance,
            original_quantity: "100",
            quantity: "45",
            fillable_quantity: "0",
        });
        expect(work.store.get(1, ID)?.pending).toBe(false);
    });

    it("preserves chain quantities through repeated source refreshes and keeps periodic validation", async () => {
        const work = workflow();
        work.rpc.filled = 56n;
        await work.domain.handleOrderUpsert(upsert());
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            quantity: "45",
        });
        await work.processor.executeBatch();
        const validated = stored();
        expect(validated).toMatchObject({
            quantity: "44",
            fillable_quantity: "10",
        });
        const reads = work.rpc.reads.getOrderStatus;
        for (const offset of [1, 2]) {
            vi.spyOn(Date, "now").mockReturnValue((NOW + offset) * 1000);
            await work.domain.handleOrderUpsert(
                upsert({ observedAt: NOW + offset }),
            );
            expect(stored()).toEqual(validated);
            expect(work.store.get(1, ID)?.pending).toBe(false);
            await work.processor.executeBatch();
        }
        expect(work.rpc.reads.getOrderStatus).toBe(reads);
        const nextObservation =
            NOW + MARKET_DATA_STORAGE_POLICY.orderRevalidationSeconds + 1;
        vi.spyOn(Date, "now").mockReturnValue(nextObservation * 1000);
        work.rpc.blockTimestamp = nextObservation;
        work.rpc.blockNumber++;
        await work.domain.handleOrderUpsert(
            upsert({ observedAt: nextObservation }),
        );
        expect(stored()).toEqual(validated);
        expect(work.store.get(1, ID)?.pending).toBe(true);
        await work.processor.executeBatch();
        expect(stored()).toEqual(validated);
        expect(work.store.get(1, ID)?.pending).toBe(false);
        expect(work.rpc.reads.getOrderStatus).toBeGreaterThan(reads!);
    });

    it("keeps source quantity updates for orders outside the protocol quantity model", async () => {
        const work = workflow();
        const sourceOrder = upsert({
            kind: FILL_KIND.BlurV2,
            seaportData: null,
            quantity: "2",
        });
        await work.domain.handleOrderUpsert(sourceOrder);
        await work.domain.handleOrderUpsert({ ...sourceOrder, quantity: "1" });
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            quantity: "1",
        });
        expect(work.store.get(1, ID)).toBeNull();
    });

    it("keeps unchanged result proof without rewriting the order at newer validation blocks", async () => {
        const work = workflow();
        await work.domain.handleOrderUpsert(upsert());
        await work.processor.executeBatch();
        const validated = stored();
        db.exec(
            "CREATE TEMP TRIGGER reject_unchanged_result_write BEFORE UPDATE ON orders BEGIN SELECT RAISE(ABORT,'unchanged result rewritten'); END;",
        );
        try {
            work.rpc.blockNumber++;
            work.store.admit(
                eventValidationRequest(1, ID, work.rpc.blockNumber),
                Date.now(),
            );
            await work.processor.executeBatch();
            expect(work.store.get(1, ID)).toMatchObject({
                pending: false,
                proofBlock: BLOCK + 1,
            });
            expect(stored()).toEqual(validated);
            expect(
                db
                    .prepare("SELECT block_number FROM orders WHERE id=?")
                    .get(ID),
            ).toEqual({ block_number: BLOCK });
        } finally {
            db.exec("DROP TRIGGER reject_unchanged_result_write;");
        }
        rollbackResult(work, BLOCK + 1);
        expect(stored()).toEqual(validated);
        const request = eventValidationRequest(1, ID, BLOCK);
        expect(
            work.store.isCovered(
                request,
                work.domain.validationCandidate(request)!.revision,
            ),
        ).toBe(false);
        rollbackResult(work, BLOCK);
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Unvalidated,
        });
    });

    it("keeps the last validated bid active and advances quantity without another source observation", async () => {
        const work = workflow();
        await initialSnapshot(work);
        const before = stored();
        work.rpc.filled = 55n;
        work.rpc.blockNumber = BLOCK;
        await fill(work);
        expect(stored()).toEqual(before);
        expect(work.store.get(1, ID)).toMatchObject({
            pending: true,
            minimumBlock: BLOCK,
        });
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            source_status: ORDER_SOURCE_STATUS.Active,
            quantity: "45",
            original_quantity: "100",
            fillable_quantity: "10",
        });
        expect(work.store.get(1, ID)?.pending).toBe(false);
        const after = stored(),
            reads = work.rpc.reads.getOrderStatus;
        await fill(work);
        await fill(work, BLOCK - 1);
        await work.processor.executeBatch();
        expect(stored()).toEqual(after);
        expect(work.rpc.reads.getOrderStatus).toBe(reads);
    });

    it.each(["rpc", "block-hash", "chain-revision"])(
        "retains valid state while %s failure leaves validation pending",
        async (failure) => {
            const work = workflow();
            await initialSnapshot(work);
            const before = stored();
            work.rpc.blockNumber = BLOCK;
            work.rpc.filled = 55n;
            await fill(work);
            work.rpc.failStatus = failure === "rpc";
            work.rpc.onRead = async (p) => {
                if (p.functionName !== "getOrderStatus") return;
                if (failure === "block-hash")
                    work.rpc.blockHash = `0x${"cd".repeat(32)}`;
                if (failure === "chain-revision") advanceChainSyncRevision(1);
            };
            await work.processor.executeBatch();
            expect(stored()).toEqual(before);
            expect(work.store.get(1, ID)?.pending).toBe(true);
            work.rpc.failStatus = false;
            work.rpc.onRead = undefined;
            work.rpc.blockTimestamp = NOW + 61;
            vi.spyOn(Date, "now").mockReturnValue((NOW + 61) * 1000);
            await work.processor.executeBatch();
            expect(stored()).toMatchObject({
                fillability_status: ORDER_STATUS.Fillable,
                quantity: "45",
                fillable_quantity: "10",
            });
        },
    );

    it("does not commit a snapshot as completion of a newer fill obligation", async () => {
        const work = workflow();
        await initialSnapshot(work);
        work.rpc.blockNumber = BLOCK;
        work.rpc.filled = 55n;
        await fill(work);
        let once = true;
        work.rpc.onRead = async (p) => {
            if (once && p.functionName === "getOrderStatus") {
                once = false;
                await fill(work, BLOCK + 1);
            }
        };
        await work.processor.executeBatch();
        expect(work.store.get(1, ID)).toMatchObject({
            pending: true,
            minimumBlock: BLOCK + 1,
        });
        work.rpc.onRead = undefined;
        work.rpc.blockNumber = BLOCK + 1;
        work.rpc.filled = 56n;
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            quantity: "44",
            fillable_quantity: "10",
        });
        expect(work.store.get(1, ID)?.pending).toBe(false);
    });

    it("only terminates a partial order when the protocol remainder reaches zero", async () => {
        const work = workflow();
        await initialSnapshot(work);
        work.rpc.blockNumber = BLOCK;
        work.rpc.filled = 100n;
        await fill(work);
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
        });
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Filled,
            quantity: "0",
            fillable_quantity: "0",
        });
    });

    it.each([SEAPORT_ORDER_TYPE.FullOpen, SEAPORT_ORDER_TYPE.FullRestricted])(
        "applies a full-only execution immediately without validation demand (type=%s)",
        async (type) => {
            const work = workflow();
            const order = heavyMakerOrder(0, {
                collectionId,
                contract: terms.contract,
                validFrom: terms.validFrom,
                validUntil: terms.validUntil,
            });
            order.seaportData!.orderType = String(type);
            order.id = computeSeaportOrderHash(order.seaportData!);
            await work.domain.handleOrderUpsert({
                ...upsert(),
                orderId: order.id,
                seaportData: order.seaportData,
                price: order.price,
                quantity: "1",
                originalQuantity: "1",
                validateAfterUpsert: false,
            });
            await work.domain.handleOrderUpdateById({
                chainId: 1,
                orderId: order.id,
                reason: ORDER_UPDATE_REASON.Fill,
                blockNumber: BLOCK,
            });
            expect(stored(order.id)).toMatchObject({
                fillability_status: ORDER_STATUS.Filled,
                quantity: "0",
                fillable_quantity: "0",
            });
            expect(work.store.get(1, order.id)).toBeNull();
            expect(work.rpc.reads.getOrderStatus).toBeUndefined();
        },
    );

    it("lets source cancellation win over an in-flight partial-order validation", async () => {
        const work = workflow();
        await initialSnapshot(work);
        work.rpc.blockNumber = BLOCK;
        await fill(work);
        work.rpc.onRead = async (p) => {
            if (p.functionName === "getOrderStatus")
                await work.domain.handleOrderUpdateById({
                    chainId: 1,
                    orderId: ID,
                    collectionId,
                    reason: ORDER_UPDATE_REASON.Cancel,
                    sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                    observedAt: NOW,
                });
        };
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Cancelled,
        });
    });

    it.each([0n, 360_000_000_000_000_000n, 6_000_000_000_000_000_000n])(
        "keeps allowance capacity separate from original and remaining units (%s)",
        async (allowance) => {
            const work = workflow();
            work.rpc.allowance = allowance;
            await work.domain.handleOrderUpsert(upsert());
            await work.processor.executeBatch();
            expect(stored()).toMatchObject({
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

    it("restores funding capacity through validation demand without REST input", async () => {
        const work = workflow();
        work.rpc.balance = 0n;
        await work.domain.handleOrderUpsert(upsert());
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.NoBalance,
            quantity: "45",
            fillable_quantity: "0",
        });
        work.rpc.balance = 600_000_000_000_000_000n;
        work.rpc.blockNumber++;
        work.store.admit(
            eventValidationRequest(1, ID, work.rpc.blockNumber),
            Date.now(),
        );
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            quantity: "45",
            fillable_quantity: "10",
        });
    });

    it("does not admit a fill before the collection bootstrap anchor", async () => {
        const work = workflow();
        await initialSnapshot(work);
        const before = stored();
        await fill(work, BLOCK - 2000);
        expect(stored()).toEqual(before);
        expect(work.store.get(1, ID)?.pending).toBe(false);
    });

    it("leaves valid state untouched when durable demand admission fails", async () => {
        const work = workflow();
        await initialSnapshot(work);
        const before = stored();
        db.exec(
            "CREATE TEMP TRIGGER fail_partial_demand BEFORE UPDATE ON order_validation_demand BEGIN SELECT RAISE(ABORT,'demand unavailable'); END;",
        );
        try {
            await expect(fill(work)).rejects.toThrow("demand unavailable");
            expect(stored()).toEqual(before);
        } finally {
            db.exec("DROP TRIGGER fail_partial_demand");
        }
    });

    it.each([55n, 100n])(
        "discards orphaned partial-order results and revalidates without source input (%s filled)",
        async (filled) => {
            const work = workflow();
            await initialSnapshot(work);
            work.rpc.blockNumber = BLOCK;
            work.rpc.filled = filled;
            await fill(work);
            await work.processor.executeBatch();
            expect(stored()).toMatchObject({
                quantity: filled === 100n ? "0" : "45",
            });
            const storage = new SqliteStorage();
            storage.rollbackFromBlock({
                plan: storage.prepareRollback({ chainId: 1, fromBlock: BLOCK }),
                snapshot: {
                    block: {
                        blockNumber: BLOCK - 1,
                        blockHash: work.rpc.blockHash,
                        parentHash: work.rpc.blockHash,
                        blockTimestamp: NOW,
                    },
                    owners: [],
                },
            });
            expect(stored()).toMatchObject({
                fillability_status: ORDER_STATUS.Unvalidated,
                quantity: "100",
                fillable_quantity: null,
            });
            expect(work.store.get(1, ID)).toMatchObject({
                pending: true,
                minimumBlock: BLOCK,
                proofBlock: null,
            });
            work.rpc.filled = 0n;
            await work.processor.executeBatch();
            expect(stored()).toMatchObject({
                fillability_status: ORDER_STATUS.Fillable,
                quantity: "100",
                fillable_quantity: "10",
            });
        },
    );

    it("retains a signed full-only declaration when its canonical execution is rolled back", async () => {
        const work = workflow();
        const order = heavyMakerOrder(0, {
            collectionId,
            contract: terms.contract,
        });
        order.seaportData!.startTime = String(NOW - 3600);
        order.seaportData!.endTime = String(NOW + 86400);
        order.id = computeSeaportOrderHash(order.seaportData!);
        await work.domain.handleOrderUpsert({
            ...upsert(),
            orderId: order.id,
            seaportData: order.seaportData,
            quantity: "1",
            originalQuantity: "1",
            price: order.price,
            validateAfterUpsert: false,
        });
        await work.domain.handleOrderUpdateById({
            chainId: 1,
            orderId: order.id,
            reason: ORDER_UPDATE_REASON.Fill,
            blockNumber: BLOCK,
        });
        const storage = new SqliteStorage();
        storage.rollbackFromBlock({
            plan: storage.prepareRollback({ chainId: 1, fromBlock: BLOCK }),
            snapshot: {
                block: {
                    blockNumber: BLOCK - 1,
                    blockHash: work.rpc.blockHash,
                    parentHash: work.rpc.blockHash,
                    blockTimestamp: NOW,
                },
                owners: [],
            },
        });
        expect(stored(order.id)).toMatchObject({
            fillability_status: ORDER_STATUS.Unvalidated,
            quantity: "1",
        });
        expect(work.store.get(1, order.id)?.pending).toBe(true);
        work.rpc.filled = 0n;
        work.rpc.size = 0n;
        work.rpc.blockHash = `0x${"cd".repeat(32)}`;
        await work.processor.executeBatch();
        expect(stored(order.id)).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            quantity: "1",
        });
    });

    it("preserves independent source cancellation through quantity rollback", async () => {
        const work = workflow();
        await work.domain.handleOrderUpsert(upsert());
        await work.processor.executeBatch();
        await work.domain.handleOrderUpdateById({
            chainId: 1,
            orderId: ID,
            collectionId,
            reason: ORDER_UPDATE_REASON.Cancel,
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
            observedAt: NOW,
        });
        const before = stored(),
            storage = new SqliteStorage();
        storage.rollbackFromBlock({
            plan: storage.prepareRollback({ chainId: 1, fromBlock: BLOCK }),
            snapshot: {
                block: {
                    blockNumber: BLOCK - 1,
                    blockHash: work.rpc.blockHash,
                    parentHash: work.rpc.blockHash,
                    blockTimestamp: NOW,
                },
                owners: [],
            },
        });
        expect(stored()).toEqual(before);
        expect(work.store.get(1, ID)?.pending).toBe(false);
    });

    it("rebinds pending orphaned block requirements while keeping pre-fork validated state", async () => {
        const work = workflow();
        await initialSnapshot(work);
        const before = stored();
        await fill(work, BLOCK + 500);
        const storage = new SqliteStorage();
        storage.rollbackFromBlock({
            plan: storage.prepareRollback({ chainId: 1, fromBlock: BLOCK }),
            snapshot: {
                block: {
                    blockNumber: BLOCK - 1,
                    blockHash: work.rpc.blockHash,
                    parentHash: work.rpc.blockHash,
                    blockTimestamp: NOW,
                },
                owners: [],
            },
        });
        expect(stored()).toEqual(before);
        expect(work.store.get(1, ID)).toMatchObject({
            pending: true,
            minimumBlock: BLOCK,
        });
        work.rpc.blockNumber = BLOCK;
        await work.processor.executeBatch();
        expect(work.store.get(1, ID)?.pending).toBe(false);
    });

    it("rolls back quantity invalidation and demand with the rest of a failed fork commit", async () => {
        const work = workflow();
        await initialSnapshot(work);
        work.rpc.blockNumber = BLOCK;
        work.rpc.filled = 55n;
        await fill(work);
        await work.processor.executeBatch();
        const before = stored(),
            demandBefore = work.store.get(1, ID);
        const storage = new SqliteStorage();
        db.exec(
            "CREATE TEMP TRIGGER fail_quantity_rollback BEFORE UPDATE ON order_validation_demand BEGIN SELECT RAISE(ABORT,'rollback demand unavailable'); END;",
        );
        try {
            expect(() =>
                storage.rollbackFromBlock({
                    plan: storage.prepareRollback({
                        chainId: 1,
                        fromBlock: BLOCK,
                    }),
                    snapshot: {
                        block: {
                            blockNumber: BLOCK - 1,
                            blockHash: work.rpc.blockHash,
                            parentHash: work.rpc.blockHash,
                            blockTimestamp: NOW,
                        },
                        owners: [],
                    },
                }),
            ).toThrow("rollback demand unavailable");
            expect(stored()).toEqual(before);
            expect(work.store.get(1, ID)).toEqual(demandBefore);
            expect(storage.captureSyncCheckpoint(1).revision).toBe(0);
        } finally {
            db.exec("DROP TRIGGER fail_quantity_rollback");
        }
    });

    it("uses the protocol fraction rather than assuming its denominator is NFT size", () => {
        expect(remainingOrderQuantity(100n, 11n, 20n)).toBe(45n);
        expect(remainingOrderQuantity(100n, 0n, 0n)).toBe(100n);
        expect(() => remainingOrderQuantity(100n, 1n, 3n)).toThrow(
            "Non-integral",
        );
    });
    function rollbackResult(
        work: ReturnType<typeof workflow>,
        fromBlock: number,
    ) {
        const storage = new SqliteStorage();
        storage.rollbackFromBlock({
            plan: storage.prepareRollback({ chainId: 1, fromBlock }),
            snapshot: {
                block: {
                    blockNumber: fromBlock - 1,
                    blockHash: work.rpc.blockHash,
                    parentHash: work.rpc.blockHash,
                    blockTimestamp: NOW,
                },
                owners: [],
            },
        });
    }

    it.each([ORDER_STATUS.Filled, ORDER_STATUS.Cancelled])(
        "retains %s result attribution after newer unneeded demand is drained",
        async (status) => {
            const work = workflow();
            await initialSnapshot(work);
            work.rpc.blockNumber = BLOCK;
            work.rpc.filled = status === ORDER_STATUS.Filled ? 100n : 55n;
            work.rpc.cancelled = status === ORDER_STATUS.Cancelled;
            await fill(work);
            let once = true;
            work.rpc.onRead = async () => {
                if (!once) return;
                once = false;
                work.store.admit(
                    eventValidationRequest(1, ID, BLOCK + 1),
                    Date.now(),
                );
            };
            await work.processor.executeBatch();
            work.rpc.onRead = undefined;
            expect(stored()).toMatchObject({ fillability_status: status });
            await work.processor.executeBatch();
            expect(work.store.get(1, ID)).toMatchObject({
                pending: false,
                proofBlock: null,
            });
            expect(
                db
                    .prepare("SELECT block_number FROM orders WHERE id=?")
                    .get(ID),
            ).toEqual({ block_number: BLOCK });
            rollbackResult(work, BLOCK);
            expect(stored()).toMatchObject({
                fillability_status: ORDER_STATUS.Unvalidated,
            });
            work.rpc.filled = 0n;
            work.rpc.cancelled = false;
            await work.processor.executeBatch();
            expect(stored()).toMatchObject({
                fillability_status: ORDER_STATUS.Fillable,
                quantity: "100",
            });
        },
    );

    it.each([55n, 100n])(
        "retains %s-filled result attribution across a trigger-only fork and a deeper fork",
        async (filled) => {
            const work = workflow();
            await initialSnapshot(work);
            work.rpc.blockNumber = BLOCK;
            work.rpc.filled = filled;
            await fill(work);
            let once = true;
            work.rpc.onRead = async () => {
                if (!once) return;
                once = false;
                work.store.admit(
                    eventValidationRequest(1, ID, BLOCK + 2),
                    Date.now(),
                );
            };
            await work.processor.executeBatch();
            work.rpc.onRead = undefined;
            rollbackResult(work, BLOCK + 1);
            expect(stored()).toMatchObject({
                quantity: filled === 100n ? "0" : "45",
            });
            rollbackResult(work, BLOCK);
            expect(stored()).toMatchObject({
                fillability_status: ORDER_STATUS.Unvalidated,
            });
            work.rpc.filled = 0n;
            await work.processor.executeBatch();
            expect(stored()).toMatchObject({
                fillability_status: ORDER_STATUS.Fillable,
                quantity: "100",
            });
        },
    );

    it.each(
        [ORDER_STATUS.Filled, ORDER_STATUS.Cancelled].flatMap((status) =>
            [false, true].map((sourceCancelled) => ({
                status,
                sourceCancelled,
            })),
        ),
    )(
        "retirement carries $status validation attribution while source cancellation remains independent (sourceCancelled=$sourceCancelled)",
        async ({ status, sourceCancelled }) => {
            const work = workflow();
            await initialSnapshot(work);
            work.rpc.blockNumber = BLOCK;
            work.rpc.filled = status === ORDER_STATUS.Filled ? 100n : 55n;
            work.rpc.cancelled = status === ORDER_STATUS.Cancelled;
            await fill(work);
            await work.processor.executeBatch();
            if (sourceCancelled)
                await work.domain.handleOrderUpdateById({
                    chainId: 1,
                    collectionId,
                    orderId: ID,
                    reason: ORDER_UPDATE_REASON.Cancel,
                    sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                    observedAt: NOW,
                });
            const afterGrace =
                NOW + MARKET_DATA_STORAGE_POLICY.orderReorgGraceSeconds + 1;
            db.prepare(
                "UPDATE orders SET updated_at=datetime(?,'unixepoch') WHERE id=?",
            ).run(NOW, ID);
            vi.spyOn(Date, "now").mockReturnValue(afterGrace * 1000);
            new SqliteMarketDataMaintenance(db).maintainBatch(afterGrace);
            expect(stored()).toBeUndefined();
            expect(
                db
                    .prepare(
                        "SELECT block_number FROM market_order_retirements WHERE order_id=?",
                    )
                    .get(ID),
            ).toEqual({ block_number: BLOCK });
            rollbackResult(work, BLOCK);
            const marker = db
                .prepare(
                    "SELECT order_id FROM market_order_retirements WHERE order_id=?",
                )
                .get(ID);
            expect(!!marker).toBe(sourceCancelled);
            const admitted = await work.domain.handleOrderUpsert(
                upsert({ observedAt: afterGrace, quantity: "100" }),
            );
            expect(admitted.validationNeeded).toBe(!sourceCancelled);
        },
    );

    it.each([
        [101n, 100n],
        [1n, 0n],
    ])(
        "retries impossible protocol fractions %s/%s without replacing current state",
        async (filled, size) => {
            const work = workflow();
            await initialSnapshot(work);
            work.rpc.blockNumber = BLOCK;
            work.rpc.filled = filled;
            work.rpc.size = size;
            await fill(work);
            await work.processor.executeBatch();
            expect(stored()).toMatchObject({
                fillability_status: ORDER_STATUS.Fillable,
                quantity: "100",
            });
            expect(work.store.get(1, ID)?.pending).toBe(true);
        },
    );

    function sourceExecution(
        work: ReturnType<typeof workflow>,
        hooks: { beforeReceipt?: () => void } = {},
    ) {
        const txHash = `0x${"31".repeat(32)}` as const;
        const receipt = vi.fn<RpcProviderPort["getTransactionReceipt"]>(
            async () => {
                hooks.beforeReceipt?.();
                return {
                    transactionHash: txHash,
                    blockNumber: BLOCK,
                    blockHash: work.rpc.blockHash,
                    logs: [],
                };
            },
        );
        const block = vi.fn<RpcProviderPort["getBlock"]>(
            async (number: number) => ({
                ...(await work.rpc.getBlock(number)),
                transactions: [txHash],
            }),
        );
        const requirements = new SqliteOrderExecutionRequirements(work.store);
        const request = vi.spyOn(requirements, "request");
        const resolver = new ResolveOrderExecutions({
            chainId: 1,
            store: requirements,
            admission: new FairOrderValidationAdmission(2),
            executionBlock: new CanonicalOrderExecutionBlock({
                getTransactionReceipt: receipt,
                getBlock: block,
            }),
        });
        const apply = new ApplyOrderUpdate({
            executionValidation: requirements,
            chainId: 1,
            lifecycle: work.domain,
            validation: new AdmitOrderValidation(1, work.store),
        });
        const update = normalizeOpenSeaOrderUpdate({
            event_type: OPENSEA_STREAM_EVENT_TYPE.ItemSold,
            payload: { order_hash: ID, transaction: { hash: txHash } },
        })!;
        async function validate() {
            await resolver.executeBatch();
        }
        return {
            apply,
            request,
            get pending() {
                return db
                    .prepare("SELECT * FROM order_execution_requirements")
                    .all();
            },
            async execute(payload: OrderUpdateByIdPayload, requiredAt: number) {
                await apply.execute(payload, requiredAt);
                await validate();
            },
            validate,
            receipt,
            block,
            payload: { ...update, chainId: 1, collectionId, observedAt: NOW },
        };
    }

    async function fullOnlyExecution(
        work: ReturnType<typeof workflow>,
        payload: OrderUpsertPayload,
        sourceFirst: boolean,
    ) {
        work.rpc.filled = 0n;
        work.rpc.size = 0n;
        work.rpc.blockNumber = BLOCK - 1;
        await work.domain.handleOrderUpsert(payload);
        expect((await work.processor.executeBatch())?.validated).toBe(1);
        expect(stored(payload.orderId)).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Active,
            fillability_status: ORDER_STATUS.Fillable,
        });
        const source = sourceExecution(work);
        const sale = () =>
            source.execute(
                { ...source.payload, orderId: payload.orderId },
                NOW * 1000,
            );
        const canonical = () =>
            work.domain.handleOrderUpdateById({
                chainId: 1,
                orderId: payload.orderId,
                reason: ORDER_UPDATE_REASON.Fill,
                blockNumber: BLOCK,
            });
        const executions = sourceFirst ? [sale, canonical] : [canonical, sale];
        for (const execute of executions) await execute();
        const completed = stored(payload.orderId);
        // Repeated deliveries before rollback must not add RPC or change state.
        for (const execute of executions) await execute();
        expect(stored(payload.orderId)).toEqual(completed);
        expect(completed).toMatchObject({
            fillability_status: ORDER_STATUS.Filled,
            source_status: sourceFirst
                ? ORDER_SOURCE_STATUS.Filled
                : ORDER_SOURCE_STATUS.Active,
            quantity: "0",
        });
        expect(source.receipt).not.toHaveBeenCalled();
        expect(work.rpc.reads.getOrderStatus).toBe(1);
        work.rpc.blockNumber = BLOCK;
    }

    it.each(
        FULL_ONLY_ORDERS.flatMap((order) =>
            [false, true].flatMap((sourceFirst) =>
                [false, true].map((refresh) => ({
                    ...order,
                    sourceFirst,
                    refresh,
                })),
            ),
        ),
    )(
        "recovers a full-only $side after rollback (type=$type, sourceFirst=$sourceFirst, refresh=$refresh)",
        async ({ type, side, sourceFirst, refresh }) => {
            const work = workflow();
            const payload = fullOnlyUpsert(type, side);
            await fullOnlyExecution(work, payload, sourceFirst);
            rollbackResult(work, BLOCK);
            work.rpc.blockHash = `0x${"cd".repeat(32)}`;
            expect(stored(payload.orderId)).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Active,
                fillability_status: ORDER_STATUS.Unvalidated,
                quantity: "1",
                fillable_quantity: null,
            });
            expect(work.store.get(1, payload.orderId)).toMatchObject({
                pending: true,
                minimumBlock: BLOCK,
            });
            if (refresh) {
                const refreshed = await work.domain.handleOrderUpsert(payload);
                expect(refreshed.validationNeeded).toBe(true);
            }
            const afterGrace =
                NOW + MARKET_DATA_STORAGE_POLICY.orderReorgGraceSeconds + 1;
            // Make the row eligible by age, so this checks lifecycle protection.
            db.prepare(
                "UPDATE orders SET updated_at=datetime(?,'unixepoch') WHERE id=?",
            ).run(NOW, payload.orderId);
            new SqliteMarketDataMaintenance(db).maintainBatch(afterGrace);
            expect(stored(payload.orderId)).toBeDefined();
            expect((await work.processor.executeBatch())?.validated).toBe(1);
            expect(stored(payload.orderId)).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Active,
                fillability_status: ORDER_STATUS.Fillable,
                quantity: "1",
            });
            expect(work.store.get(1, payload.orderId)?.pending).toBe(false);
            expect(work.rpc.reads.getOrderStatus).toBe(2);
        },
    );

    it("preserves source-only completion when no canonical filled result is orphaned", async () => {
        const work = workflow();
        const payload = fullOnlyUpsert(
            SEAPORT_ORDER_TYPE.FullOpen,
            ORDER_SIDE.Buy,
        );
        work.rpc.blockNumber = BLOCK - 1;
        work.rpc.filled = 0n;
        work.rpc.size = 0n;
        await work.domain.handleOrderUpsert(payload);
        await work.processor.executeBatch();
        const source = sourceExecution(work);
        await source.execute(
            { ...source.payload, orderId: payload.orderId },
            NOW * 1000,
        );
        const before = stored(payload.orderId);
        expect(before).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Filled,
            fillability_status: ORDER_STATUS.Fillable,
        });
        rollbackResult(work, BLOCK);
        expect(stored(payload.orderId)).toEqual(before);
        expect(work.store.get(1, payload.orderId)?.pending).toBe(false);
        expect(await work.processor.executeBatch()).toBeUndefined();
        expect(work.rpc.reads.getOrderStatus).toBe(1);
    });

    it.each(FULL_ONLY_ORDERS)(
        "retains signed size for a new full-only $side without an explicit original quantity (type=$type)",
        async ({ type, side }) => {
            const work = workflow();
            const payload = {
                ...fullOnlyUpsert(type, side),
                originalQuantity: undefined,
            };
            await fullOnlyExecution(work, payload, true);
            expect(stored(payload.orderId)).toMatchObject({
                original_quantity: "1",
                quantity: "0",
            });
            rollbackResult(work, BLOCK);
            expect((await work.processor.executeBatch())?.validated).toBe(1);
            expect(stored(payload.orderId)).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Active,
                fillability_status: ORDER_STATUS.Fillable,
                original_quantity: "1",
                quantity: "1",
            });
        },
    );

    it.each(
        FULL_ONLY_ORDERS.flatMap((order) =>
            [false, true].flatMap((retireFirst) =>
                [false, true].map((chainCancelled) => ({
                    ...order,
                    retireFirst,
                    chainCancelled,
                })),
            ),
        ),
    )(
        "preserves source completion across rollback of unrelated protocol evidence ($side, type=$type, retireFirst=$retireFirst, chainCancelled=$chainCancelled)",
        async ({ type, side, retireFirst, chainCancelled }) => {
            const work = workflow();
            const payload = fullOnlyUpsert(type, side);
            work.rpc.filled = 0n;
            work.rpc.size = 0n;
            await work.domain.handleOrderUpsert(payload);
            expect((await work.processor.executeBatch())?.validated).toBe(1);
            expect(
                db
                    .prepare("SELECT block_number FROM orders WHERE id=?")
                    .get(payload.orderId),
            ).toEqual({ block_number: BLOCK });
            const source = sourceExecution(work);
            await source.execute(
                { ...source.payload, orderId: payload.orderId },
                NOW * 1000,
            );
            if (chainCancelled)
                await work.domain.handleOrderUpdateById({
                    chainId: 1,
                    orderId: payload.orderId,
                    reason: ORDER_UPDATE_REASON.Cancel,
                    blockNumber: BLOCK + 1,
                });
            expect(stored(payload.orderId)).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Filled,
                fillability_status: chainCancelled
                    ? ORDER_STATUS.Cancelled
                    : ORDER_STATUS.Fillable,
            });

            const afterGrace =
                NOW + MARKET_DATA_STORAGE_POLICY.orderReorgGraceSeconds + 1;
            vi.spyOn(Date, "now").mockReturnValue(afterGrace * 1000);
            const retirement = () =>
                db
                    .prepare(
                        "SELECT block_number FROM market_order_retirements WHERE order_id=?",
                    )
                    .get(payload.orderId);
            const maintain = () => {
                db.prepare(
                    "UPDATE orders SET updated_at=datetime(?,'unixepoch') WHERE id=?",
                ).run(NOW, payload.orderId);
                new SqliteMarketDataMaintenance(db).maintainBatch(afterGrace);
                expect(stored(payload.orderId)).toBeUndefined();
            };
            if (retireFirst) maintain();
            rollbackResult(work, BLOCK);
            if (retireFirst) {
                expect(retirement()).toEqual({ block_number: null });
            } else {
                expect(stored(payload.orderId)).toMatchObject({
                    source_status: ORDER_SOURCE_STATUS.Filled,
                    fillability_status: ORDER_STATUS.Unvalidated,
                });
            }
            // Both delayed delivery and a freshly received active snapshot must
            // remain blocked by the independent source completion.
            for (const observedAt of [NOW, afterGrace]) {
                const refresh = await work.domain.handleOrderUpsert({
                    ...payload,
                    observedAt,
                });
                expect(refresh.validationNeeded).toBe(false);
            }
            if (!retireFirst) maintain();
            expect(retirement()).toEqual({ block_number: null });
            expect(stored(payload.orderId)).toBeUndefined();
            expect(await work.processor.executeBatch()).toBeUndefined();
            expect(work.rpc.reads.getOrderStatus).toBe(1);
            expect(source.receipt).not.toHaveBeenCalled();
        },
    );

    it.each(
        [false, true].flatMap((retireFirst) =>
            [false, true].map((sourceCancelled) => ({
                retireFirst,
                sourceCancelled,
            })),
        ),
    )(
        "keeps full-only rollback and retirement compatible (retireFirst=$retireFirst, sourceCancelled=$sourceCancelled)",
        async ({ retireFirst, sourceCancelled }) => {
            const work = workflow();
            const payload = fullOnlyUpsert(
                SEAPORT_ORDER_TYPE.FullOpen,
                ORDER_SIDE.Buy,
            );
            await fullOnlyExecution(work, payload, true);
            if (sourceCancelled)
                await work.domain.handleOrderUpdateById({
                    chainId: 1,
                    orderId: payload.orderId,
                    reason: ORDER_UPDATE_REASON.Cancel,
                    sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                    observedAt: NOW,
                });
            const afterGrace =
                NOW + MARKET_DATA_STORAGE_POLICY.orderReorgGraceSeconds + 1;
            vi.spyOn(Date, "now").mockReturnValue(afterGrace * 1000);
            const maintain = () => {
                db.prepare(
                    "UPDATE orders SET updated_at=datetime(?,'unixepoch') WHERE id=?",
                ).run(NOW, payload.orderId);
                new SqliteMarketDataMaintenance(db).maintainBatch(afterGrace);
            };
            if (retireFirst) {
                maintain();
                expect(stored(payload.orderId)).toBeUndefined();
                expect(
                    db
                        .prepare(
                            "SELECT block_number FROM market_order_retirements WHERE order_id=?",
                        )
                        .get(payload.orderId),
                ).toEqual({ block_number: BLOCK });
            }
            rollbackResult(work, BLOCK);
            work.rpc.blockHash = `0x${"cd".repeat(32)}`;
            maintain();
            expect(
                !!db
                    .prepare(
                        "SELECT 1 FROM market_order_retirements WHERE order_id=?",
                    )
                    .get(payload.orderId),
            ).toBe(sourceCancelled);
            if (sourceCancelled) {
                const refresh = await work.domain.handleOrderUpsert({
                    ...payload,
                    observedAt: afterGrace,
                });
                expect(refresh.validationNeeded).toBe(false);
                expect(stored(payload.orderId)).toBeUndefined();
                expect(await work.processor.executeBatch()).toBeUndefined();
            } else {
                if (retireFirst)
                    await work.domain.handleOrderUpsert({
                        ...payload,
                        observedAt: afterGrace,
                    });
                work.rpc.blockTimestamp = afterGrace;
                expect((await work.processor.executeBatch())?.validated).toBe(
                    1,
                );
                expect(stored(payload.orderId)).toMatchObject({
                    source_status: ORDER_SOURCE_STATUS.Active,
                    fillability_status: ORDER_STATUS.Fillable,
                    quantity: "1",
                });
            }
        },
    );

    it.each(FULL_ONLY_ORDERS)(
        "applies a full-only $side source sale immediately without RPC (type=$type)",
        async ({ type, side }) => {
            const work = workflow();
            const order = fullOnlyUpsert(type, side);
            await work.domain.handleOrderUpsert(order);
            const source = sourceExecution(work);
            await source.execute(
                {
                    ...source.payload,
                    orderId: order.orderId,
                    executionTransactionHash: null,
                },
                NOW * 1000,
            );
            expect(stored(order.orderId)).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Filled,
            });
            expect(source.receipt).not.toHaveBeenCalled();
            expect(source.block).not.toHaveBeenCalled();
            await work.processor.executeBatch();
            expect(work.rpc.reads.getOrderStatus).toBeUndefined();
            expect(work.store.get(1, order.orderId)?.pending).toBe(false);

            await work.domain.handleOrderUpdateById({
                chainId: 1,
                orderId: order.orderId,
                reason: ORDER_UPDATE_REASON.Cancel,
                sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                observedAt: NOW,
            });
            await source.execute(
                { ...source.payload, orderId: order.orderId },
                NOW * 1000,
            );
            expect(stored(order.orderId)).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Cancelled,
            });
            expect(source.receipt).not.toHaveBeenCalled();
        },
    );

    it("ignores a source sale before its order and preserves later optimistic admission with validation", async () => {
        const work = workflow();
        const source = sourceExecution(work);
        await source.apply.execute(source.payload, NOW * 1000);
        expect(source.request).not.toHaveBeenCalled();
        expect(source.receipt).not.toHaveBeenCalled();
        expect(work.store.get(1, ID)).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT 1 FROM market_order_retirements WHERE order_id=?",
                )
                .get(ID),
        ).toBeUndefined();

        await work.domain.handleOrderUpsert(upsert());
        expect(stored()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Active,
            fillability_status: ORDER_STATUS.Fillable,
        });
        expect(work.store.get(1, ID)?.pending).toBe(true);
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            quantity: "45",
            fillable_quantity: "10",
        });
        expect(work.store.get(1, ID)?.pending).toBe(false);
    });

    it("persists partial-sale checks before ACK without receipt RPC and retries failed writes", async () => {
        const work = workflow();
        await initialSnapshot(work);
        const source = sourceExecution(work);
        source.request.mockRejectedValueOnce(new Error("writer unavailable"));
        await expect(
            source.apply.execute(source.payload, NOW * 1000),
        ).rejects.toThrow("writer unavailable");
        expect(source.receipt).not.toHaveBeenCalled();
        expect(work.store.get(1, ID)?.pending).toBe(false);
        await source.apply.execute(source.payload, NOW * 1000);
        await source.apply.execute(source.payload, NOW * 1000);
        expect(source.pending).toHaveLength(1);
        expect(source.receipt).not.toHaveBeenCalled();
        await source.validate();
        expect(source.pending).toHaveLength(0);
        expect(work.store.get(1, ID)).toMatchObject({
            pending: true,
            minimumBlock: BLOCK,
        });
    });

    it("applies a full-only source sale while a partial-sale receipt lookup is blocked", async () => {
        const work = workflow();
        await initialSnapshot(work);
        const order = fullOnlyUpsert(
            SEAPORT_ORDER_TYPE.FullOpen,
            ORDER_SIDE.Buy,
        );
        await work.domain.handleOrderUpsert(order);
        const source = sourceExecution(work);
        const started = Promise.withResolvers<void>();
        const unblock = Promise.withResolvers<void>();
        const receipt = source.receipt.getMockImplementation()!;
        source.receipt.mockImplementationOnce(async (...args) => {
            started.resolve();
            await unblock.promise;
            return receipt(...args);
        });
        await source.apply.execute(source.payload, NOW * 1000);
        const validating = source.validate();
        await started.promise;
        try {
            await source.apply.execute(
                { ...source.payload, orderId: order.orderId },
                NOW * 1000,
            );
            expect(stored(order.orderId)).toMatchObject({
                source_status: ORDER_SOURCE_STATUS.Filled,
            });
            expect(source.receipt).toHaveBeenCalledOnce();
            expect(source.request).toHaveBeenCalledOnce();
        } finally {
            unblock.resolve();
            await validating;
        }
    });

    it("source sale cannot consume a retained pre-sale proof or complete against a lagging head", async () => {
        const work = workflow();
        await initialSnapshot(work);
        const source = sourceExecution(work);
        await source.execute(source.payload, NOW * 1000);
        expect(work.store.get(1, ID)).toMatchObject({
            pending: true,
            minimumBlock: BLOCK,
        });
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({ quantity: "100" });
        expect(work.store.get(1, ID)?.pending).toBe(true);
        work.rpc.blockNumber = BLOCK;
        work.rpc.filled = 55n;
        vi.spyOn(Date, "now").mockReturnValue((NOW + 2) * 1000);
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({
            quantity: "45",
            fillable_quantity: "10",
        });
        expect(work.store.get(1, ID)?.pending).toBe(false);
        const reads = work.rpc.reads.getOrderStatus;
        await source.execute(source.payload, NOW * 1000);
        await work.processor.executeBatch();
        expect(work.rpc.reads.getOrderStatus).toBe(reads);
        expect(source.receipt.mock.calls[0]?.[1]).toEqual({ fresh: true });
        expect(source.block.mock.calls[0]?.[1]).toEqual({ fresh: true });
    });

    it("receipt failure retains durable work and source cancellation cannot be revived on retry", async () => {
        const work = workflow();
        await initialSnapshot(work);
        const source = sourceExecution(work);
        source.receipt.mockRejectedValueOnce(new Error("receipt unavailable"));
        await source.apply.execute(source.payload, NOW * 1000);
        await source.validate();
        expect(source.pending).toHaveLength(1);
        expect(source.request).toHaveBeenCalledOnce();
        expect(work.store.get(1, ID)?.pending).toBe(false);
        expect(stored()).toMatchObject({ quantity: "100" });
        vi.spyOn(Date, "now").mockReturnValue((NOW + 2) * 1000);
        await source.validate();
        expect(source.pending).toHaveLength(0);
        expect(source.request).toHaveBeenCalledOnce();
        await work.domain.handleOrderUpdateById({
            chainId: 1,
            collectionId,
            orderId: ID,
            reason: ORDER_UPDATE_REASON.Cancel,
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
            observedAt: NOW,
        });
        work.rpc.blockNumber = BLOCK;
        await work.processor.executeBatch();
        source.receipt.mockRejectedValue(new Error("still unavailable"));
        const receiptReads = source.receipt.mock.calls.length;
        await source.execute(source.payload, NOW * 1000);
        expect(source.receipt.mock.calls.length).toBe(receiptReads);
        expect(stored()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Cancelled,
        });
        expect(work.store.get(1, ID)?.pending).toBe(false);
    });

    it("rejects a source inclusion whose canonical revision changed before admission", async () => {
        const work = workflow();
        await initialSnapshot(work);
        const source = sourceExecution(work, {
            beforeReceipt: () => {
                advanceChainSyncRevision(1);
            },
        });
        await source.execute(source.payload, NOW * 1000);
        expect(source.pending).toHaveLength(1);
        expect(work.store.get(1, ID)?.pending).toBe(false);
        expect(stored()).toMatchObject({ quantity: "100" });
    });

    it("keeps current source execution coverage independent of the bootstrap projection anchor", async () => {
        const work = workflow();
        await initialSnapshot(work);
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id=?",
        ).run(BLOCK + 1, collectionId);
        const source = sourceExecution(work);
        await source.execute(source.payload, NOW * 1000);
        expect(work.store.get(1, ID)).toMatchObject({
            pending: true,
            minimumBlock: BLOCK,
            anchorIndependent: true,
        });
        work.rpc.blockNumber = BLOCK;
        work.rpc.filled = 55n;
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({ quantity: "45" });
    });

    it("uses verified execution inclusion rather than an unrelated source delivery clock", async () => {
        const work = workflow();
        await initialSnapshot(work);
        const source = sourceExecution(work);
        const skewed = NOW + MARKET_DATA_STORAGE_POLICY.utcDaySeconds;
        await source.execute(
            { ...source.payload, observedAt: skewed },
            skewed * 1000,
        );
        expect(source.pending).toHaveLength(0);
        expect(work.store.get(1, ID)).toMatchObject({
            pending: true,
            minimumBlock: BLOCK,
        });
        work.rpc.blockNumber = BLOCK;
        work.rpc.filled = 55n;
        await work.processor.executeBatch();
        expect(stored()).toMatchObject({ quantity: "45" });
        expect(work.store.get(1, ID)?.pending).toBe(false);
    });

    it.each([null, "", "malformed"])(
        "discards a partial source sale with unusable transaction evidence (%s)",
        async (hash) => {
            const work = workflow();
            await initialSnapshot(work);
            const source = sourceExecution(work);
            await source.execute(
                { ...source.payload, executionTransactionHash: hash },
                NOW * 1000,
            );
            expect(source.request).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalled();
            expect(source.receipt).not.toHaveBeenCalled();
            expect(work.store.get(1, ID)?.pending).toBe(false);
        },
    );

    it.each([null, "", "malformed"])(
        "discards unusable transaction evidence in a validation delivery (%s)",
        async (hash) => {
            const work = workflow();
            await initialSnapshot(work);
            const source = sourceExecution(work);
            await source.apply.execute(
                {
                    ...source.payload,
                    reason: ORDER_UPDATE_REASON.SourceExecutionValidation,
                    executionTransactionHash: hash,
                },
                NOW * 1000,
            );
            expect(source.receipt).not.toHaveBeenCalled();
            expect(source.request).not.toHaveBeenCalled();
            expect(work.store.get(1, ID)?.pending).toBe(false);
            expect(logger.warn).toHaveBeenCalled();
        },
    );
});
