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
import { SqliteCurrentAsks } from "@artgod/shared/database/current-asks";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { dispatchOffchainPayload } from "../src/application/offchain/dispatch.js";
import { OPENSEA_SALE_EVENT_TYPE } from "../src/application/offchain/opensea-sale.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { RevalidateMakerOrders } from "../src/application/orders/revalidate-maker.js";
import { getOpenSeaStreamDedupeKey } from "../src/application/offchain/opensea-stream-identity.js";
import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    OFFCHAIN_ORDER_SOURCE,
} from "../src/domain/offchain-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { MAKER_REVALIDATION_STATUS } from "../src/domain/maker-revalidation.js";
import {
    ORDER_JOB_KIND,
    type OrderUpdateByMakerPayload,
} from "../src/domain/order-jobs.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    type OrderRecord,
} from "../src/domain/orders.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import type { QueuePort } from "../src/ports/queue.js";
import type { RpcProviderPort } from "../src/ports/rpc.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    heavyMakerOrder,
    seedHeavyMaker,
    warmConduits,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

// Synthetic source event and chain replies, using real dispatch, migrated SQLite,
// Seaport snapshot validation and the current-ask selector. No live RPC or queue.
class SaleRpc extends HeavyMakerRpc {
    owner: string = HEAVY_MAKER.smallMaker;
    async readContract<T>(
        params: Parameters<RpcProviderPort["readContract"]>[0],
    ): Promise<T> {
        const result = await super.readContract<T>(params);
        return params.functionName === "ownerOf" ? (this.owner as T) : result;
    }
}

describe("hashless sale recovery", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(HEAVY_MAKER.now * 1_000);
        for (const level of ["debug", "info", "warn", "error"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        db.exec(
            "DELETE FROM maker_order_revalidation_runs; DELETE FROM queue_outbox; DELETE FROM orders; DELETE FROM collections;",
        );
    });
    afterEach(() => vi.restoreAllMocks());

    async function setup() {
        const { sale, small } = seedHeavyMaker(1);
        const rpc = new SaleRpc();
        const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth, async () => {
            throw new Error("Expected pinned batch validation");
        });
        const store = new SqliteMakerRevalidations(
            domain,
            new SqliteOrderValidationDemand(domain),
        );
        const processor = new RevalidateMakerOrders({
            store,
            admission: new FairOrderValidationAdmission(2),
            createSnapshot: createSeaportOrderValidationFactory({
                chainId: sale.chainId,
                rpc,
                conduits: warmConduits,
                conduitController: HEAVY_MAKER.controller,
            }),
        });
        const other = heavyMakerOrder(3, {
            maker: sale.maker,
            side: "sell",
            tokenId: "6763",
        });
        await domain.handleOrderUpsert({
            ...other,
            orderId: other.id,
            side: "sell",
            source: OFFCHAIN_ORDER_SOURCE.OpenSea,
            sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
            rawSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
            observedAt: HEAVY_MAKER.now,
            validateAfterUpsert: false,
        });
        const asks = new SqliteCurrentAsks(db.raw, [HEAVY_MAKER.weth]);
        const ask = (order: OrderRecord) =>
            asks.forSeller(
                order.chainId,
                order.collectionId,
                order.tokenId!,
                order.maker,
                HEAVY_MAKER.now,
            );
        expect(ask(sale)?.id).toBe(sale.id);
        expect(ask(other)?.id).toBe(other.id);

        const published: JobEnvelope<unknown>[] = [];
        const queue: QueuePort = {
            publish: async (_queue, job) => {
                published.push(job);
            },
            subscribe: async () => {
                throw new Error("Unexpected subscription");
            },
            close: async () => {},
        };
        const raw = {
            event_type: OPENSEA_SALE_EVENT_TYPE,
            payload: {
                item: { nft_id: `ethereum/${sale.contract}/${sale.tokenId}` },
                maker: { address: sale.maker },
                transaction: { hash: `0x${"77".repeat(32)}` },
            },
        };
        await dispatchOffchainPayload(
            queue,
            {
                ensureTokenSet: () => {
                    throw new Error("Unexpected token set");
                },
            },
            {
                source: OFFCHAIN_ORDER_SOURCE.OpenSea,
                chainId: sale.chainId,
                collectionId: sale.collectionId,
                receivedAt: Date.now(),
                channel: OFFCHAIN_OBSERVATION_CHANNEL.Stream,
                dedupeKey: getOpenSeaStreamDedupeKey(raw, Date.now()),
                eventType: OPENSEA_SALE_EVENT_TYPE,
                payload: raw,
            },
        );
        expect(published).toHaveLength(1);
        expect(published[0]).toMatchObject({
            kind: ORDER_JOB_KIND.UpdateByMaker,
            queue: QUEUE_NAMES.OrdersUpdateByToken,
        });
        return {
            sale,
            small,
            other,
            rpc,
            store,
            processor,
            ask,
            request: {
                jobId: published[0]!.jobId,
                payload: published[0]!.payload as OrderUpdateByMakerPayload,
                requiredAt: published[0]!.scheduledAt,
            },
        };
    }

    it("removes only the seller's stale token ask after ownership validation", async () => {
        const work = await setup();
        const read = vi.spyOn(work.rpc, "readContract");
        await work.processor.execute(work.request);
        expect(work.ask(work.sale)).toBeUndefined();
        expect(work.ask(work.other)?.id).toBe(work.other.id);
        expect(
            db
                .prepare(
                    "SELECT source_status,fillability_status FROM orders WHERE id=?",
                )
                .get(work.sale.id),
        ).toEqual({
            source_status: ORDER_SOURCE_STATUS.Active,
            fillability_status: ORDER_STATUS.NoBalance,
        });
        expect(
            db
                .prepare("SELECT validated_at FROM orders WHERE id=?")
                .get(work.small.id),
        ).toEqual({ validated_at: 0 });
        expect(work.rpc.reads).toEqual({
            getOrderStatus: 1,
            getCounter: 1,
            ownerOf: 1,
        });
        expect(
            read.mock.calls.every(
                ([params]) => params.blockNumber === work.rpc.blockNumber,
            ),
        ).toBe(true);
        expect(
            work.store.admit({ ...work.request, now: Date.now() }),
        ).toMatchObject({
            status: MAKER_REVALIDATION_STATUS.Completed,
            resolvedOrders: 1,
        });
    });

    it("keeps a still-owned and approved ask fillable despite the sale hint", async () => {
        const work = await setup();
        work.rpc.owner = work.sale.maker;
        await work.processor.execute(work.request);
        expect(work.ask(work.sale)?.id).toBe(work.sale.id);
        expect(work.rpc.reads.isApprovedForAll).toBe(1);
    });

    it.each(["rpc", "reorg"])(
        "does not commit an uncertain %s snapshot",
        async (fault) => {
            const work = await setup();
            work.rpc.onRead = ({ functionName }) => {
                if (functionName !== "ownerOf") return;
                if (fault === "rpc") throw new Error("synthetic RPC outage");
                work.rpc.blockHash = `0x${"cd".repeat(32)}`;
            };
            await expect(
                work.processor.execute(work.request),
            ).rejects.toThrow();
            expect(work.ask(work.sale)?.id).toBe(work.sale.id);
            expect(
                db
                    .prepare(
                        "SELECT source_status,validated_at FROM orders WHERE id=?",
                    )
                    .get(work.sale.id),
            ).toEqual({
                source_status: ORDER_SOURCE_STATUS.Active,
                validated_at: 0,
            });
            expect(
                work.store.admit({ ...work.request, now: Date.now() }),
            ).toMatchObject({
                status: MAKER_REVALIDATION_STATUS.Pending,
                resolvedOrders: 0,
                failures: 1,
            });
            work.rpc.onRead = undefined;
            await work.processor.execute(work.request);
            expect(work.ask(work.sale)).toBeUndefined();
        },
    );
});
