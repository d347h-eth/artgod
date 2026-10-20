import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { ValidateOrderDemand } from "../src/application/orders/validate-order-demand.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import { computeSeaportOrderHash } from "../src/domain/seaport-protocol.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_STATUS,
    ORDER_VALIDATION_REASON,
    type OrderRecord,
} from "../src/domain/orders.js";
import { ORDER_VALIDATION_DEMAND_POLICY } from "../src/domain/order-validation-demand.js";
import type { OrderUpsertPayload } from "../src/domain/order-jobs.js";
import type { RpcBlock } from "../src/ports/rpc.js";
import {
    HEAVY_MAKER as H,
    heavyMakerOrder,
    HeavyMakerRpc,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";

const START = H.now + 600;
const anchor = { ...syncBlockFixture(900), timestamp: H.now };

describe("future-start order validation", () => {
    loadTestEnv();
    let clock: number;
    let path: string;
    let blocks: Map<number, RpcBlock>;
    let orders: SqliteOrdersDomain;
    let demand: SqliteOrderValidationDemand;
    let processor: ValidateOrderDemand;
    let rpc: HeavyMakerRpc;
    let owner: ReturnType<typeof createAppliedSyncFixture>;
    function openOwners() {
        orders = new SqliteOrdersDomain(H.weth, undefined, () => clock);
        demand = new SqliteOrderValidationDemand(orders);
        owner = createAppliedSyncFixture({
            chainId: 1,
            anchor,
            collections: [new SqliteCollectionRegistry().getCollection(1, 9)!],
        });
        rpc = new HeavyMakerRpc();
        rpc.getBlock = async (number) => {
            const block = blocks.get(number);
            if (!block) throw new Error(`Missing fixture block ${number}`);
            return block;
        };
        processor = new ValidateOrderDemand({
            chainId: 1,
            store: demand,
            createSnapshot: createSeaportOrderValidationFactory({
                chainId: 1,
                rpc,
                conduitController: H.controller,
                now: () => clock * 1_000,
            }),
            admission: new FairOrderValidationAdmission(2),
            now: () => clock * 1_000,
        });
    }
    beforeEach(async () => {
        clock = H.now;
        blocks = new Map([[anchor.number, anchor]]);
        vi.spyOn(Date, "now").mockImplementation(() => clock * 1_000);
        for (const level of ["info", "warn", "error", "debug"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        path = await createTempDbPath();
        setDbPath(path);
        await createMigrationRunner().runMigrations();
        db.prepare(
            "INSERT INTO collections(chain_id,collection_id,slug,address,standard,status,token_scope_kind,bootstrap_anchor_block) VALUES(1,9,'future-validity',?,'erc721','live','contract_all_tokens',900)",
        ).run(heavyMakerOrder(0).contract);
        openOwners();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        db.raw.close();
    });
    function declaration(
        start = START,
        index = 0,
        end = H.now + 86_400,
    ): OrderUpsertPayload {
        const base = heavyMakerOrder(index);
        const seaportData = {
            ...base.seaportData!,
            startTime: String(start),
            endTime: String(end),
        };
        return {
            ...base,
            orderId: computeSeaportOrderHash(seaportData),
            validFrom: start,
            validUntil: end,
            seaportData,
            source: "opensea",
            observedAt: clock,
            rawSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
        };
    }
    const state = (id: string) =>
        db
            .prepare(
                "SELECT fillability_status,proof_block_number FROM orders WHERE id=?",
            )
            .get(id);
    function sample() {
        owner.progress.recordHeadSample(
            owner.progress.captureHeadSample(1),
            owner.progress.chainProgress(1)!.applied,
            clock * 1_000,
        );
    }
    function advance(timestamp: number, collectionIds: number[] = [9]) {
        const number = owner.progress.chainProgress(1)!.applied.number + 1;
        const block = { ...syncBlockFixture(number), timestamp };
        blocks.set(number, block);
        owner.commit(
            owner.applied({
                blocks: [block],
                shared: true,
                collectionIds,
            }),
        );
    }

    it("retains future demand through restart and replay, then validates when accepted progress reaches start", async () => {
        const future = declaration();
        await orders.handleOrderUpsert(future);
        sample();
        const retained = demand.get(1, future.orderId)!;
        expect(await processor.executeBatch()).toBeUndefined();
        expect(rpc.reads.getOrderStatus ?? 0).toBe(0);
        expect(state(future.orderId)).toEqual({
            fillability_status: ORDER_STATUS.Unvalidated,
            proof_block_number: null,
        });
        expect(demand.get(1, future.orderId)).toMatchObject({
            pending: true,
            leaseOwner: null,
            generation: retained.generation,
        });

        db.raw.close();
        setDbPath(path);
        openOwners();
        clock = START;
        await orders.handleOrderUpsert({ ...future, observedAt: clock });
        sample();
        expect(await processor.executeBatch()).toBeUndefined();
        expect(demand.get(1, future.orderId)).toMatchObject({
            pending: true,
            admissionSequence: retained.admissionSequence,
            generation: retained.generation,
        });
        // Wall time alone cannot validate at a checkpoint preceding the start.
        advance(START, []);
        // Shared ingestion alone cannot make a lagging collection ready.
        expect(await processor.executeBatch()).toBeUndefined();
        owner.commit(
            owner.applied({
                blocks: [blocks.get(901)!],
                shared: false,
                collectionIds: [9],
            }),
        );
        expect(await processor.executeBatch()).toMatchObject({ applied: 1 });
        expect(state(future.orderId)).toEqual({
            fillability_status: ORDER_STATUS.Fillable,
            proof_block_number: 901,
        });
        expect(demand.get(1, future.orderId)).toMatchObject({ pending: false });
        expect(rpc.reads.getOrderStatus).toBe(1);
    });

    it("does not let more than a claim page of future orders hide a later ready order", async () => {
        const futureIds: string[] = [];
        for (let i = 0; i <= ORDER_VALIDATION_DEMAND_POLICY.batchOrders; i++) {
            const future = declaration(START, i);
            await orders.handleOrderUpsert(future);
            futureIds.push(future.orderId);
            clock++;
        }
        const ready = declaration(H.now - 1, futureIds.length);
        await orders.handleOrderUpsert(ready);
        sample();
        expect(await processor.executeBatch()).toMatchObject({
            scanned: 1,
            claimed: 1,
            applied: 1,
        });
        expect(state(ready.orderId)).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
        });
        for (const id of futureIds)
            expect(demand.get(1, id)).toMatchObject({
                pending: true,
                leaseOwner: null,
            });
        expect(rpc.reads.getOrderStatus).toBe(1);
    });

    it("uses checkpoint time for both sides of the signed validity interval", async () => {
        const future = declaration();
        const record = { ...future, id: future.orderId } as OrderRecord;
        const createSnapshot = createSeaportOrderValidationFactory({
            chainId: 1,
            rpc,
            conduitController: H.controller,
            now: () => clock * 1_000,
        });
        // Local time has crossed start; the accepted block still has not.
        clock = START + 1;
        let snapshot = await createSnapshot({
            checkpoint: owner.progress.validationCheckpoint(1, 9)!,
            candidates: [record],
        });
        expect(await snapshot.validate(record)).toEqual({
            status: ORDER_STATUS.Unvalidated,
            reason: ORDER_VALIDATION_REASON.NotActive,
        });
        await snapshot.finish();
        expect(rpc.reads.getOrderStatus ?? 0).toBe(0);

        // Conversely, a slow local clock cannot make accepted active time future.
        clock = H.now;
        advance(START);
        snapshot = await createSnapshot({
            checkpoint: owner.progress.validationCheckpoint(1, 9)!,
            candidates: [record],
        });
        expect(await snapshot.validate(record)).toMatchObject({
            status: ORDER_STATUS.Fillable,
        });
        await snapshot.finish();

        advance(future.validUntil!);
        snapshot = await createSnapshot({
            checkpoint: owner.progress.validationCheckpoint(1, 9)!,
            candidates: [record],
        });
        expect(await snapshot.validate(record)).toEqual({
            status: ORDER_STATUS.Expired,
            reason: ORDER_VALIDATION_REASON.Expired,
        });
        await snapshot.finish();
    });

    it("does not revive waiting work whose whole signed interval has expired", async () => {
        const future = declaration(START, 0, START + 10);
        await orders.handleOrderUpsert(future);
        sample();
        expect(await processor.executeBatch()).toBeUndefined();
        clock = START + 10;
        advance(clock);
        expect(await processor.executeBatch()).toBeUndefined();
        expect(demand.get(1, future.orderId)).toMatchObject({ pending: false });
        await orders.handleOrderUpsert({ ...future, observedAt: clock });
        expect(demand.get(1, future.orderId)).toMatchObject({ pending: false });
        expect(rpc.reads.getOrderStatus ?? 0).toBe(0);
    });
});
