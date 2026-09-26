import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { zeroAddress } from "viem";
import { db, setDbPath } from "@artgod/shared/database";
import { SqliteCurrentAsks } from "@artgod/shared/database/current-asks";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { MARKET_DATA_STORAGE_POLICY } from "@artgod/shared/market-data/storage-policy";
import { logger } from "@artgod/shared/utils";
import { validateSeaportOrder } from "../src/application/offchain/seaport-validate.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { ValidateOrderDemand } from "../src/application/orders/validate-order-demand.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    type OrderRecord,
} from "../src/domain/orders.js";
import {
    ORDER_UPDATE_REASON,
    type OrderUpsertPayload,
} from "../src/domain/order-jobs.js";
import { OrderValidationSnapshotUnavailable } from "../src/domain/order-validation-failure.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import type { RpcProviderPort } from "../src/ports/rpc.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    warmConduits,
} from "./fixtures/heavy-maker.js";
import {
    BULK_ORDER_OBSERVED_AT,
    capturedBulkOrder,
} from "./fixtures/seaport-bulk-order.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

// Chain replies are synthetic. The captured signature/terms remain unchanged.
class BulkListingRpc extends HeavyMakerRpc {
    blockTimestamp = BULK_ORDER_OBSERVED_AT;
    owner = capturedBulkOrder().maker;
    cancelled = false;
    filled = false;
    approved = true;

    async readContract<T>(
        params: Parameters<RpcProviderPort["readContract"]>[0],
    ): Promise<T> {
        if (params.functionName === "getApproved") return zeroAddress as T;
        const value = await super.readContract<T>(params);
        if (params.functionName === "getOrderStatus")
            return [false, this.cancelled, this.filled ? 1n : 0n, 1n] as T;
        if (params.functionName === "ownerOf") return this.owner as T;
        if (params.functionName === "isApprovedForAll")
            return this.approved as T;
        return value;
    }
}

function snapshotFactory(rpc: BulkListingRpc) {
    return createSeaportOrderValidationFactory({
        chainId: capturedBulkOrder().chainId,
        rpc,
        conduits: warmConduits,
        conduitController: HEAVY_MAKER.controller,
    });
}

beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(BULK_ORDER_OBSERVED_AT * 1_000);
    for (const level of ["debug", "info", "warn", "error"] as const)
        vi.spyOn(logger, level).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(["scalar", "snapshot"] as const)(
    "bulk listing %s validation",
    (mode) => {
        async function validate(order: OrderRecord, rpc: BulkListingRpc) {
            if (mode === "scalar")
                return validateSeaportOrder(
                    rpc,
                    warmConduits,
                    { conduitController: HEAVY_MAKER.controller },
                    order,
                );
            const snapshot = await snapshotFactory(rpc)({
                chainId: order.chainId,
                minimumBlock: null,
                candidates: [order],
            });
            const result = await snapshot.validate(order);
            await snapshot.finish();
            return result;
        }

        it("checks the captured leaf's status, counter, ownership and approval after verifying its proof", async () => {
            const order = capturedBulkOrder();
            const rpc = new BulkListingRpc();
            const read = vi.spyOn(rpc, "readContract");
            expect(await validate(order, rpc)).toEqual({
                status: ORDER_STATUS.Fillable,
                reason: "approved",
            });
            expect(rpc.reads).toEqual({
                getOrderStatus: 1,
                getCounter: 1,
                ownerOf: 1,
                isApprovedForAll: 1,
            });
            expect(read).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "getOrderStatus",
                    args: [order.id],
                }),
            );
            if (mode === "snapshot")
                expect(
                    read.mock.calls.every(
                        ([params]) => params.blockNumber === rpc.blockNumber,
                    ),
                ).toBe(true);
        });

        it.each([
            "cancelled",
            "filled",
            "counter",
            "owner",
            "approval",
        ] as const)(
            "does not restore fillability when the %s check fails",
            async (failure) => {
                const rpc = new BulkListingRpc();
                if (failure === "cancelled") rpc.cancelled = true;
                if (failure === "filled") rpc.filled = true;
                if (failure === "counter") rpc.counter = 1n;
                if (failure === "owner") rpc.owner = zeroAddress;
                if (failure === "approval") rpc.approved = false;
                const expected = {
                    cancelled: ORDER_STATUS.Cancelled,
                    filled: ORDER_STATUS.Filled,
                    counter: ORDER_STATUS.Cancelled,
                    owner: ORDER_STATUS.NoBalance,
                    approval: ORDER_STATUS.NoApproval,
                };
                expect((await validate(capturedBulkOrder(), rpc)).status).toBe(
                    expected[failure],
                );
            },
        );

        it("rejects a corrupt proof before reading chain state", async () => {
            const order = capturedBulkOrder();
            order.seaportData!.signature =
                order.seaportData!.signature!.slice(0, -2) + "00";
            const rpc = new BulkListingRpc();
            expect(await validate(order, rpc)).toEqual({
                status: ORDER_STATUS.Invalid,
                reason: "bad-signature",
            });
            expect(rpc.reads).toEqual({});
        });
    },
);

describe("stored bulk listing recovery", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => db.exec("DELETE FROM orders; DELETE FROM collections;"));

    async function staleListing() {
        const order = capturedBulkOrder();
        const rpc = new BulkListingRpc();
        const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth, async () => {
            throw new Error(
                "Recovery must use the runtime validation snapshot",
            );
        });
        const store = new SqliteOrderValidationDemand(domain);
        const processor = new ValidateOrderDemand({
            admission: new FairOrderValidationAdmission(2),
            chainId: order.chainId,
            store,
            createSnapshot: snapshotFactory(rpc),
        });
        db.prepare(
            "INSERT INTO collections (chain_id,collection_id,slug,address,standard,status,token_scope_kind,bootstrap_anchor_block) VALUES (?,?,'bulk-listing',?,'erc721','live','contract_all_tokens',0)",
        ).run(order.chainId, order.collectionId, order.contract);
        const oldTime =
            BULK_ORDER_OBSERVED_AT -
            MARKET_DATA_STORAGE_POLICY.orderRevalidationSeconds -
            1;
        const payload: OrderUpsertPayload = {
            ...order,
            orderId: order.id,
            source: order.source!,
            side: "sell",
            sourceScopeKind: order.sourceScopeKind!,
            rawSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Stream,
            observedAt: oldTime,
            validateAfterUpsert: true,
        };
        vi.mocked(Date.now).mockReturnValue(oldTime * 1_000);
        await domain.handleOrderUpsert(payload);
        const claim = store.claimBatch(
            order.chainId,
            "old-verifier",
            oldTime * 1_000,
        ).claims[0]!;
        // Persist the former verifier's verdict and completed coverage, so the
        // regression includes the real freshness/admission/revision rules.
        store.completeBatch(
            [
                {
                    claim,
                    result: {
                        status: ORDER_STATUS.Invalid,
                        reason: "signature-error:Error: invalid signature length",
                    },
                },
            ],
            { observedAt: oldTime * 1_000, blockNumber: rpc.blockNumber },
            oldTime * 1_000,
        );
        expect(store.get(order.chainId, order.id)?.pending).toBe(false);
        const asks = new SqliteCurrentAsks(db.raw, [order.currency!]);
        const ask = () =>
            asks.forSeller(
                order.chainId,
                order.collectionId,
                order.tokenId!,
                order.maker,
                BULK_ORDER_OBSERVED_AT,
            );
        expect(ask()).toBeUndefined();
        vi.mocked(Date.now).mockReturnValue(BULK_ORDER_OBSERVED_AT * 1_000);
        // REST reconciliation often omits signatures. Canonical merging must
        // retain the stream's proof and admit its revalidation.
        await domain.handleOrderUpsert({
            ...payload,
            rawSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
            seaportData: { ...order.seaportData!, signature: null },
            observedAt: BULK_ORDER_OBSERVED_AT,
        });
        expect(store.get(order.chainId, order.id)?.pending).toBe(true);
        expect(ask()).toBeUndefined();
        return { order, rpc, domain, store, processor, ask };
    }

    it("restores a previously invalid listing through fresh reconciliation demand and the shared current-ask selector", async () => {
        const work = await staleListing();
        expect(await work.processor.executeBatch()).toMatchObject({
            applied: 1,
            covered: 1,
            retried: 0,
        });
        expect(work.store.get(work.order.chainId, work.order.id)).toMatchObject(
            { pending: false, failures: 0 },
        );
        expect(work.ask()).toMatchObject({
            id: work.order.id,
            price: work.order.price,
        });
        const row = db
            .prepare(
                "SELECT fillability_status,source_status,seaport_data_json FROM orders WHERE id=?",
            )
            .get(work.order.id) as {
            fillability_status: string;
            source_status: string;
            seaport_data_json: string;
        };
        expect(row.fillability_status).toBe(ORDER_STATUS.Fillable);
        expect(row.source_status).toBe(ORDER_SOURCE_STATUS.Active);
        expect(JSON.parse(row.seaport_data_json).signature).toBe(
            work.order.seaportData!.signature,
        );
    });

    it("keeps an RPC failure pending without publishing an ask", async () => {
        const work = await staleListing();
        work.rpc.onRead = () => {
            throw new Error("synthetic RPC outage");
        };
        expect(await work.processor.executeBatch()).toMatchObject({
            applied: 0,
            retried: 1,
        });
        expect(work.store.get(work.order.chainId, work.order.id)).toMatchObject(
            { pending: true, failures: 1 },
        );
        expect(work.ask()).toBeUndefined();
    });

    it("preserves a source cancellation received while the recovered listing is being validated", async () => {
        const work = await staleListing();
        work.rpc.onRead = async ({ functionName }) => {
            if (functionName === "getOrderStatus")
                await work.domain.handleOrderUpdateById({
                    chainId: work.order.chainId,
                    collectionId: work.order.collectionId,
                    orderId: work.order.id,
                    reason: ORDER_UPDATE_REASON.Cancel,
                    sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                    observedAt: BULK_ORDER_OBSERVED_AT + 1,
                });
        };
        await work.processor.executeBatch();
        expect(work.ask()).toBeUndefined();
        expect(
            db
                .prepare("SELECT source_status FROM orders WHERE id=?")
                .get(work.order.id),
        ).toEqual({
            source_status: ORDER_SOURCE_STATUS.Cancelled,
        });
    });

    it("rejects snapshot completion when chain state cannot be read", async () => {
        const rpc = new BulkListingRpc();
        rpc.onRead = () => {
            throw new Error("synthetic RPC outage");
        };
        const snapshot = await snapshotFactory(rpc)({
            chainId: capturedBulkOrder().chainId,
            minimumBlock: null,
        });
        await expect(snapshot.validate(capturedBulkOrder())).rejects.toThrow(
            OrderValidationSnapshotUnavailable,
        );
        await expect(snapshot.finish()).rejects.toThrow(
            OrderValidationSnapshotUnavailable,
        );
    });
});
