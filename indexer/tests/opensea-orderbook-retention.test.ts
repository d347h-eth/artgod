import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { handleOpenSeaBootstrapJob } from "../src/application/offchain/opensea-bootstrap.js";
import { handleReconcileJob } from "../src/application/offchain/opensea-reconcile.js";
import { OpenSeaReconcilePolicy } from "../src/domain/opensea-reconcile-policy.js";
import {
    OPENSEA_JOB_KIND,
    OPENSEA_ORDERBOOK_RUN_KIND,
    OPENSEA_RECONCILE_REASON,
} from "../src/domain/opensea-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteOpenSeaOrderbookRuns } from "../src/infra/offchain/sqlite-orderbook-runs.js";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { captureOpenSeaSyncIdentity } from "../src/infra/offchain/sqlite-opensea-sync-identity.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import {
    COLLECTION_STATUS,
    OPENSEA_COLLECTION_STATUS,
} from "@artgod/shared/types";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import { OpenSeaOrderbookSync } from "../src/application/offchain/opensea-orderbook-sync.js";
import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    OFFCHAIN_ORDER_SOURCE,
} from "../src/domain/offchain-jobs.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../src/domain/orders.js";
import { SqliteOrderSourceStateStore } from "../src/infra/offchain/sqlite-order-source-state.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderObservations } from "../src/infra/orders/sqlite-order-observations.js";
import { SqliteDailyListingPrices } from "../src/infra/storage/sqlite-daily-listing-prices.js";
import { loadOpenSeaConfig } from "../src/config/opensea.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const NOW = 1_800_000_000;

describe("streamed orderbook reconciliation", () => {
    loadTestEnv();
    let sourceState: SqliteOrderSourceStateStore;
    beforeEach(async () => {
        const config = loadOpenSeaConfig();
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind,opensea_slug) VALUES (99,1,'fixture','0xcollection','erc721',?,'contract_all_tokens','fixture')",
        ).run(COLLECTION_STATUS.Live);
        sourceState = new SqliteOrderSourceStateStore(
            new SqliteOrdersDomain(
                config.tokens.wethAddress,
                undefined,
                () => NOW,
            ),
        );
    });
    afterEach(() => {
        vi.restoreAllMocks();
        db.raw.close();
    });

    const begin = () =>
        sourceState.beginObservation({
            identity: captureOpenSeaSyncIdentity(1, 99)!,
            source: OFFCHAIN_ORDER_SOURCE.OpenSea,
            startedAt: NOW,
        });
    function order(id: string, observedAt = NOW - 3600) {
        db.prepare(
            "INSERT INTO orders(id,chain_id,collection_id,kind,maker,contract_address,source,source_status,fillability_status,observed_at) VALUES (?,1,99,'seaport','maker','0xcollection',?,?,?,?)",
        ).run(
            id,
            OFFCHAIN_ORDER_SOURCE.OpenSea,
            ORDER_SOURCE_STATUS.Active,
            ORDER_STATUS.Fillable,
            observedAt,
        );
        observe(id, observedAt);
    }
    function observe(id: string, observedAt: number) {
        db.writeTransaction(() =>
            new SqliteOrderObservations().retain({
                chainId: 1,
                collectionId: 99,
                orderId: id,
                sourceId: OFFCHAIN_ORDER_SOURCE.OpenSea,
                observationKey: id,
                status: ORDER_SOURCE_STATUS.Active,
                declaration: true,
                now: observedAt * 1_000,
            }),
        )();
    }
    const status = (id: string) =>
        db.prepare("SELECT source_status FROM orders WHERE id=?").get(id);
    const tempTables = () =>
        db
            .prepare(
                "SELECT name FROM sqlite_temp_schema WHERE type='table' AND name LIKE 'market_observation_%'",
            )
            .all();

    it("deactivates absent older orders without overriding stream observations or their coalesced freshness bucket", async () => {
        order("absent");
        order("seen");
        order("during-crawl", NOW + 1);
        order("fresh-bucket", NOW - POLICY.orderRevalidationSeconds + 1);
        const observation = begin();
        expect(observation.recordActiveOrder("SEEN")).toBe(true);
        expect(await observation.complete()).toBe(1);
        expect(await observation.complete()).toBe(0);
        expect(status("absent")).toEqual({
            source_status: ORDER_SOURCE_STATUS.Inactive,
        });
        for (const id of ["seen", "during-crawl", "fresh-bucket"]) {
            expect(status(id)).toEqual({
                source_status: ORDER_SOURCE_STATUS.Active,
            });
        }
        expect(
            db
                .prepare("SELECT observed_at FROM market_order_observations")
                .get(),
        ).toEqual({ observed_at: NOW });
        observation.close();
        observation.close();
        expect(tempTables()).toEqual([]);
    });

    it("rechecks eligibility between bounded update batches", async () => {
        db.raw.transaction(() => {
            for (let i = 0; i <= POLICY.maintenanceBatchRows; i++)
                order(String(i).padStart(5, "0"));
        })();
        const observation = begin();
        const completing = observation.complete();
        const lastId = String(POLICY.maintenanceBatchRows).padStart(5, "0");
        observe(lastId, NOW + 1);
        expect(await completing).toBe(POLICY.maintenanceBatchRows);
        expect(status(lastId)).toEqual({
            source_status: ORDER_SOURCE_STATUS.Active,
        });
        observation.close();
    });

    it("refreshes each changed ask seller once and ignores bids and recently observed asks", async () => {
        for (const id of ["ask-one", "ask-two", "bid", "fresh-ask"])
            order(id, id === "fresh-ask" ? NOW + 1 : NOW - 3600);
        db.prepare("UPDATE orders SET side='sell',token_id='1'").run();
        db.prepare("UPDATE orders SET side='buy' WHERE id='bid'").run();
        db.prepare("UPDATE orders SET token_id='2' WHERE id='fresh-ask'").run();
        const refreshSeller = vi
            .spyOn(SqliteDailyListingPrices.prototype, "refreshSeller")
            .mockImplementation(() => {});

        const observation = begin();
        expect(await observation.complete()).toBe(3);
        expect(refreshSeller).toHaveBeenCalledTimes(1);
        expect(refreshSeller).toHaveBeenCalledWith(
            {
                chain_id: 1,
                collection_id: 99,
                token_id: "1",
                maker: "maker",
            },
            NOW,
        );
        expect(status("fresh-ask")).toEqual({
            source_status: ORDER_SOURCE_STATUS.Active,
        });
        observation.close();
    });

    it("rolls back order deactivation if the coupled price refresh fails", async () => {
        order("ask");
        db.prepare("UPDATE orders SET side='sell',token_id='1'").run();
        vi.spyOn(
            SqliteDailyListingPrices.prototype,
            "refreshSeller",
        ).mockImplementation(() => {
            throw new Error("fixture price failure");
        });

        const observation = begin();
        await expect(observation.complete()).rejects.toThrow(
            "fixture price failure",
        );
        expect(status("ask")).toEqual({
            source_status: ORDER_SOURCE_STATUS.Active,
        });
        expect(
            db
                .prepare(
                    "SELECT source_status FROM order_source_observations WHERE order_id='ask'",
                )
                .get(),
        ).toEqual({
            source_status: ORDER_SOURCE_STATUS.Active,
        });
        expect(
            db.prepare("SELECT * FROM market_order_observations").all(),
        ).toEqual([]);
        observation.close();
    });

    it("closes admission and does not recreate freshness state after collection deletion", async () => {
        const observation = begin();
        db.prepare("DELETE FROM collections WHERE collection_id=99").run();
        expect(observation.recordActiveOrder("late")).toBe(false);
        expect(await observation.complete()).toBe(0);
        expect(
            db.prepare("SELECT * FROM market_order_observations").all(),
        ).toEqual([]);
        observation.close();
        expect(tempTables()).toEqual([]);
    });

    it("closes an old scan when the collection starts a new bootstrap", async () => {
        order("surviving-observation");
        const observation = begin();
        db.prepare(
            "UPDATE collections SET status=?,bootstrap_finished_at=NULL WHERE collection_id=99",
        ).run(COLLECTION_STATUS.Bootstrapping);
        expect(observation.recordActiveOrder("late")).toBe(false);
        expect(await observation.complete()).toBe(0);
        expect(status("surviving-observation").source_status).toBe(
            ORDER_SOURCE_STATUS.Active,
        );
        expect(
            db.prepare("SELECT * FROM market_order_observations").all(),
        ).toEqual([]);
        observation.close();
    });

    it("cannot resume an old scan against a later completed collection lifecycle", async () => {
        order("surviving-observation");
        const observation = begin();
        db.prepare(
            "UPDATE collections SET bootstrap_finished_at='2030-01-01 00:00:00' WHERE collection_id=99",
        ).run();
        expect(observation.recordActiveOrder("late")).toBe(false);
        expect(await observation.complete()).toBe(0);
        expect(status("surviving-observation").source_status).toBe(
            ORDER_SOURCE_STATUS.Active,
        );
        observation.close();
    });

    describe.each([
        OPENSEA_ORDERBOOK_RUN_KIND.Snapshot,
        OPENSEA_ORDERBOOK_RUN_KIND.Reconcile,
    ])("%s retains the source identity accepted by its worker", (kind) => {
        async function execute() {
            db.prepare(
                "UPDATE collections SET opensea_status=? WHERE collection_id=99",
            ).run(OPENSEA_COLLECTION_STATUS.Ready);
            const collections = new SqliteCollectionRegistry();
            const runs = new SqliteOpenSeaOrderbookRuns();
            const queue = { publish: vi.fn().mockResolvedValue(undefined) };
            const api = {
                forEachListing: vi.fn().mockResolvedValue(undefined),
                forEachOffer: vi.fn().mockResolvedValue(undefined),
            };
            const sync = new OpenSeaOrderbookSync(api, queue, sourceState);
            const retry = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 };
            const common = {
                jobId: "retained-source-identity",
                chainId: 1,
                collectionId: 99,
                attempt: 1,
                scheduledAt: Date.now(),
            };
            if (kind === OPENSEA_ORDERBOOK_RUN_KIND.Snapshot) {
                await handleOpenSeaBootstrapJob(
                    queue,
                    collections,
                    new SqliteBootstrapSteps(),
                    runs,
                    sync,
                    retry,
                    30_000,
                    {
                        ...common,
                        kind: OPENSEA_JOB_KIND.BootstrapCollection,
                        queue: QUEUE_NAMES.OpenSeaBootstrap,
                        payload: { chainId: 1, collectionId: 99 },
                    },
                );
            } else {
                await handleReconcileJob(
                    queue,
                    collections,
                    runs,
                    sync,
                    new OpenSeaReconcilePolicy(loadOpenSeaConfig().opensea),
                    retry,
                    {
                        ...common,
                        kind: OPENSEA_JOB_KIND.ReconcileCollection,
                        queue: QUEUE_NAMES.OpenSeaReconcile,
                        payload: {
                            chainId: 1,
                            collectionId: 99,
                            reason: OPENSEA_RECONCILE_REASON.Manual,
                        },
                    },
                );
            }
            return { api, queue, collections };
        }

        // The writer can release before the worker is rescheduled. Change the
        // persisted identity precisely around observation creation to exercise
        // both sides of that process boundary without timing-dependent sleeps.
        it.each([
            ["before", "slug"],
            ["after", "slug"],
            ["before", "bootstrap"],
            ["after", "bootstrap"],
        ])(
            "rejects a replacement %s observation capture (%s)",
            async (timing, replacement) => {
                vi.setSystemTime(NOW * 1_000);
                order("current-source-order");
                const beginObservation =
                    sourceState.beginObservation.bind(sourceState);
                const replace = () => {
                    if (replacement === "slug") {
                        db.prepare(
                            "UPDATE collections SET opensea_slug='replacement' WHERE collection_id=99",
                        ).run();
                    } else {
                        // A new completed run revokes the old scan even when all
                        // collection fields and timestamps happen to be equal.
                        db.prepare(
                            `INSERT INTO bootstrap_runs(chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status)
                        VALUES (1,99,'fixture','0xcollection','erc721',?,?,?)`,
                        ).run(
                            BOOTSTRAP_METADATA_MODE.Strict,
                            BOOTSTRAP_ENUMERATION_MODE.Enumerable,
                            BOOTSTRAP_RUN_STATUS.Completed,
                        );
                    }
                };
                let lateOrderAccepted: boolean | undefined;
                vi.spyOn(sourceState, "beginObservation").mockImplementation(
                    (input) => {
                        if (timing === "before") replace();
                        const observation = beginObservation(input);
                        if (timing === "after") replace();
                        lateOrderAccepted = observation.recordActiveOrder(
                            "late-old-source-order",
                        );
                        return observation;
                    },
                );
                const { api, queue, collections } = await execute();
                expect(lateOrderAccepted).toBe(false);
                expect(status("current-source-order")).toEqual({
                    source_status: ORDER_SOURCE_STATUS.Active,
                });
                expect(
                    db.prepare("SELECT * FROM market_order_observations").all(),
                ).toEqual([]);
                expect(
                    collections.getCollection(1, 99)?.openseaReadyAt,
                ).toBeNull();
                expect(queue.publish).not.toHaveBeenCalled();
                expect(api.forEachListing.mock.calls[0]?.[0]).toBe("fixture");
                expect(tempTables()).toEqual([]);
            },
        );

        it("withdraws an absent old observation when the accepted identity remains current", async () => {
            vi.setSystemTime(NOW * 1_000);
            order("absent-current-source-order");
            const { collections } = await execute();
            expect(status("absent-current-source-order")).toEqual({
                source_status: ORDER_SOURCE_STATUS.Inactive,
            });
            expect(
                collections.getCollection(1, 99)?.openseaReadyAt,
            ).not.toBeNull();
            expect(
                db
                    .prepare(
                        "SELECT observed_at FROM market_order_observations WHERE collection_id=99",
                    )
                    .get(),
            ).toEqual({ observed_at: NOW });
            expect(tempTables()).toEqual([]);
        });
    });

    it("releases its temporary membership tables when an upstream crawl fails", async () => {
        const api = {
            forEachListing: vi
                .fn()
                .mockRejectedValue(new Error("fixture failure")),
            forEachOffer: vi.fn(),
        };
        const sync = new OpenSeaOrderbookSync(
            api,
            { publish: vi.fn() },
            sourceState,
        );
        const identity = captureOpenSeaSyncIdentity(1, 99)!;
        await expect(
            sync.syncCollection(
                identity,
                OFFCHAIN_OBSERVATION_CHANNEL.Snapshot,
                1,
            ),
        ).rejects.toThrow("fixture failure");
        expect(tempTables()).toEqual([]);
        expect(api.forEachOffer).not.toHaveBeenCalled();
    });

    it("stops an active REST producer before publishing late work after purge", async () => {
        const api = {
            async forEachListing(
                _slug: string,
                _contract: string,
                handler: (record: {
                    eventType: string;
                    orderId: string;
                    sourceEventAt: number | null;
                    payload: Record<string, unknown>;
                }) => Promise<void>,
            ) {
                db.prepare(
                    "DELETE FROM collections WHERE collection_id=99",
                ).run();
                await handler({
                    eventType: "fixture",
                    orderId: "late",
                    sourceEventAt: NOW,
                    payload: {},
                });
            },
            forEachOffer: vi.fn(),
        };
        const publish = vi.fn();
        const sync = new OpenSeaOrderbookSync(api, { publish }, sourceState);
        const identity = captureOpenSeaSyncIdentity(1, 99)!;
        expect(
            await sync.syncCollection(
                identity,
                OFFCHAIN_OBSERVATION_CHANNEL.Snapshot,
                1,
            ),
        ).toEqual({ activeOrders: 0, deactivatedOrders: 0 });
        expect(publish).not.toHaveBeenCalled();
        expect(api.forEachOffer).not.toHaveBeenCalled();
        expect(tempTables()).toEqual([]);
    });
});
