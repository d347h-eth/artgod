import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { SqliteCollectionDataCleanup } from "@artgod/shared/database/collection-data-cleanup";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import {
    COLLECTION_STATUS,
    OPENSEA_COLLECTION_STATUS,
    OPENSEA_STREAM_INGESTION_STATUS,
} from "@artgod/shared/types";
import { OPENSEA_STREAM_EVENT_TYPE } from "@artgod/shared/opensea/payload";
import { handleOpenSeaBootstrapJob } from "../src/application/offchain/opensea-bootstrap.js";
import { publishOpenSeaStreamEvent } from "../src/application/offchain/opensea-stream-publisher.js";
import { shouldProcessOffchainPayload } from "../src/application/offchain/ingestion-gate.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteBootstrapRuns } from "../src/infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { SqliteOpenSeaOrderbookRuns } from "../src/infra/offchain/sqlite-orderbook-runs.js";
import {
    OPENSEA_JOB_KIND,
    type OpenSeaBootstrapCollectionPayload,
} from "../src/domain/opensea-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import type { OffchainOrderRawPayload } from "../src/domain/offchain-jobs.js";
import type { QueuePort } from "../src/ports/queue.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const COLLECTION = 91;
const RUN = 92;
const SLUG = "post-live-market";
const ADDRESS = `0x${"12".repeat(20)}`;
const RETRY = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 };

describe("OpenSea follows collection liveness", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        new SqliteCollectionDataCleanup().purgeCollectionData({
            chainId: 1,
            collectionId: COLLECTION,
        });
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,token_scope_kind,status,opensea_slug,opensea_status) VALUES (?,1,?,?,'erc721','contract_all_tokens',?,?,?)",
        ).run(
            COLLECTION,
            SLUG,
            ADDRESS,
            COLLECTION_STATUS.Bootstrapping,
            SLUG,
            OPENSEA_COLLECTION_STATUS.Pending,
        );
        db.prepare(
            "INSERT INTO bootstrap_runs(run_id,chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status) VALUES (?,1,?,?,?,'erc721',?,?,?)",
        ).run(
            RUN,
            COLLECTION,
            SLUG,
            ADDRESS,
            BOOTSTRAP_METADATA_MODE.Strict,
            BOOTSTRAP_ENUMERATION_MODE.Enumerable,
            BOOTSTRAP_RUN_STATUS.Backfill,
        );
        for (const step of [
            BOOTSTRAP_STEP_KEY.CollectionLive,
            BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
            BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
            BOOTSTRAP_STEP_KEY.OpenSeaReady,
        ])
            db.prepare(
                "INSERT INTO bootstrap_run_steps(run_id,step_key,status,blocking) VALUES (?,?,?,?)",
            ).run(
                RUN,
                step,
                BOOTSTRAP_STEP_STATUS.Pending,
                step === BOOTSTRAP_STEP_KEY.CollectionLive ? 1 : 0,
            );
    });

    function harness() {
        const collections = new SqliteCollectionRegistry();
        const steps = new SqliteBootstrapSteps();
        const runs = new SqliteBootstrapRuns();
        const bookRuns = new SqliteOpenSeaOrderbookRuns();
        const publish = vi
            .fn<QueuePort["publish"]>()
            .mockResolvedValue(undefined);
        const sync = {
            syncCollection: vi.fn(async () => ({
                activeOrders: 3,
                deactivatedOrders: 0,
            })),
        };
        const job: JobEnvelope<OpenSeaBootstrapCollectionPayload> = {
            jobId: "post-live-snapshot",
            kind: OPENSEA_JOB_KIND.BootstrapCollection,
            queue: QUEUE_NAMES.OpenSeaBootstrap,
            chainId: 1,
            collectionId: COLLECTION,
            payload: {
                chainId: 1,
                collectionId: COLLECTION,
                bootstrap: { runId: RUN },
            },
            attempt: 1,
            scheduledAt: Date.now(),
        };
        return {
            collections,
            steps,
            runs,
            sync,
            publish,
            execute: () =>
                handleOpenSeaBootstrapJob(
                    { publish },
                    collections,
                    steps,
                    bookRuns,
                    sync,
                    RETRY,
                    30_000,
                    job,
                ),
        };
    }

    function becomeLive() {
        db.writeTransaction(() => {
            db.prepare(
                "UPDATE collections SET status=?,bootstrap_finished_at=CURRENT_TIMESTAMP WHERE collection_id=?",
            ).run(COLLECTION_STATUS.Live, COLLECTION);
            db.prepare("UPDATE bootstrap_runs SET status=? WHERE run_id=?").run(
                BOOTSTRAP_RUN_STATUS.Completed,
                RUN,
            );
            db.prepare(
                "UPDATE bootstrap_run_steps SET status=? WHERE run_id=? AND step_key=?",
            ).run(
                BOOTSTRAP_STEP_STATUS.Succeeded,
                RUN,
                BOOTSTRAP_STEP_KEY.CollectionLive,
            );
        })();
    }

    it("does no snapshot work before live, then completes its visible side steps on a completed core run", async () => {
        const h = harness();
        await h.execute();
        expect(h.sync.syncCollection).not.toHaveBeenCalled();
        expect(
            db.prepare("SELECT 1 FROM opensea_orderbook_runs").all(),
        ).toEqual([]);

        becomeLive();
        await h.execute();
        expect(h.sync.syncCollection).toHaveBeenCalledOnce();
        expect(h.runs.getRun(RUN)?.status).toBe(BOOTSTRAP_RUN_STATUS.Completed);
        for (const step of [
            BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
            BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
            BOOTSTRAP_STEP_KEY.OpenSeaReady,
        ])
            expect(h.steps.getStep(RUN, step)?.status).toBe(
                BOOTSTRAP_STEP_STATUS.Succeeded,
            );
        expect(h.collections.getCollection(1, COLLECTION)?.openseaStatus).toBe(
            OPENSEA_COLLECTION_STATUS.Ready,
        );
        await h.execute();
        expect(h.sync.syncCollection).toHaveBeenCalledOnce();
    });

    it("finishes pending OpenSea steps while the live run is retrying metadata", async () => {
        becomeLive();
        const h = harness();
        h.runs.updateRunStatus(RUN, BOOTSTRAP_RUN_STATUS.Metadata);
        await h.execute();
        expect(h.sync.syncCollection).toHaveBeenCalledOnce();
        expect(h.runs.getRun(RUN)?.status).toBe(BOOTSTRAP_RUN_STATUS.Metadata);
        expect(
            h.steps.getStep(RUN, BOOTSTRAP_STEP_KEY.OpenSeaReady)?.status,
        ).toBe(BOOTSTRAP_STEP_STATUS.Succeeded);
        expect(h.collections.getCollection(1, COLLECTION)?.openseaStatus).toBe(
            OPENSEA_COLLECTION_STATUS.Ready,
        );
    });

    it("rejects a queued snapshot from a replaced run even when the collection is live", async () => {
        becomeLive();
        const h = harness();
        db.prepare(
            "INSERT INTO bootstrap_runs(run_id,chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status) SELECT run_id+1,chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status FROM bootstrap_runs WHERE run_id=?",
        ).run(RUN);
        await h.execute();
        expect(h.sync.syncCollection).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        "fences a lifecycle reset immediately before the snapshot outcome writer (failure=%s)",
        async (fail) => {
            becomeLive();
            const h = harness();
            const commit = h.collections.commitOpenSeaSync.bind(h.collections);
            let resolved = false;
            h.sync.syncCollection.mockImplementation(async () => {
                resolved = true;
                if (fail) throw new Error("fixture late failure");
                return { activeOrders: 3, deactivatedOrders: 0 };
            });
            vi.spyOn(h.collections, "commitOpenSeaSync").mockImplementation(
                (identity, write) => {
                    if (resolved) {
                        db.prepare(
                            "UPDATE collections SET status=?,opensea_status=NULL,opensea_ready_at=NULL,opensea_snapshot_completed_at=NULL WHERE collection_id=?",
                        ).run(COLLECTION_STATUS.Bootstrapping, COLLECTION);
                    }
                    return commit(identity, write);
                },
            );
            await h.execute();
            expect(h.collections.getCollection(1, COLLECTION)).toMatchObject({
                status: COLLECTION_STATUS.Bootstrapping,
                openseaStatus: null,
                openseaReadyAt: null,
                openseaSnapshotCompletedAt: null,
            });
            expect(
                h.steps.getStep(RUN, BOOTSTRAP_STEP_KEY.OpenSeaReady)?.status,
            ).toBe(BOOTSTRAP_STEP_STATUS.Pending);
            expect(h.publish).not.toHaveBeenCalled();
        },
    );

    it("fences same-timestamp lifecycle replacement during a snapshot", async () => {
        becomeLive();
        const h = harness();
        const commit = h.collections.commitOpenSeaSync.bind(h.collections);
        let resolved = false;
        h.sync.syncCollection.mockImplementation(async () => {
            resolved = true;
            return { activeOrders: 3, deactivatedOrders: 0 };
        });
        vi.spyOn(h.collections, "commitOpenSeaSync").mockImplementation(
            (identity, write) => {
                if (resolved)
                    db.prepare(
                        "INSERT INTO bootstrap_runs(run_id,chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status) SELECT run_id+1,chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status FROM bootstrap_runs WHERE run_id=?",
                    ).run(RUN);
                return commit(identity, write);
            },
        );
        await h.execute();
        expect(
            h.collections.getCollection(1, COLLECTION)?.openseaReadyAt,
        ).toBeNull();
        expect(
            h.steps.getStep(RUN, BOOTSTRAP_STEP_KEY.OpenSeaReady)?.status,
        ).toBe(BOOTSTRAP_STEP_STATUS.Pending);
    });

    it("drops a queued side step from a failed run even if its collection row says live", async () => {
        becomeLive();
        const h = harness();
        h.runs.updateRunStatus(RUN, BOOTSTRAP_RUN_STATUS.Failed);
        await h.execute();
        expect(h.sync.syncCollection).not.toHaveBeenCalled();
        expect(
            h.collections.getCollection(1, COLLECTION)?.openseaReadyAt,
        ).toBeNull();
        expect(h.publish).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        "cannot restore readiness or retry after collection removal during a snapshot (failure=%s)",
        async (fail) => {
            becomeLive();
            const h = harness();
            h.sync.syncCollection.mockImplementation(async () => {
                new SqliteCollectionDataCleanup().purgeCollectionData({
                    chainId: 1,
                    collectionId: COLLECTION,
                });
                if (fail) throw new Error("fixture late request failure");
                return { activeOrders: 3, deactivatedOrders: 0 };
            });
            await h.execute();
            expect(h.collections.getCollection(1, COLLECTION)).toBeNull();
            expect(h.publish).not.toHaveBeenCalled();
            expect(
                db.prepare("SELECT 1 FROM opensea_orderbook_runs").all(),
            ).toEqual([]);
        },
    );

    it("rechecks live state, pause and deletion despite a cached stream route", async () => {
        becomeLive();
        const h = harness();
        const routes = new Map([
            [SLUG, [h.collections.getCollection(1, COLLECTION)!]],
        ]);
        const rawEvent = {
            event_type: OPENSEA_STREAM_EVENT_TYPE.ItemSold,
            payload: {
                item: { nft_id: `ethereum/${ADDRESS}/7` },
                order_hash: `0x${"34".repeat(32)}`,
            },
        };
        const send = () =>
            publishOpenSeaStreamEvent(
                { publish: h.publish },
                h.collections,
                SLUG,
                routes,
                rawEvent,
            );
        db.prepare("UPDATE collections SET status=? WHERE collection_id=?").run(
            COLLECTION_STATUS.Bootstrapping,
            COLLECTION,
        );
        await send();
        expect(h.publish).not.toHaveBeenCalled();
        becomeLive();
        await send();
        expect(h.publish).toHaveBeenCalledOnce();
        const admitted = (
            h.publish.mock.calls[0]![1] as JobEnvelope<OffchainOrderRawPayload>
        ).payload;
        db.prepare(
            "UPDATE collections SET opensea_stream_ingestion_status=? WHERE collection_id=?",
        ).run(OPENSEA_STREAM_INGESTION_STATUS.Paused, COLLECTION);
        expect(shouldProcessOffchainPayload(h.collections, admitted)).toBe(
            false,
        );
        await send();
        expect(h.publish).toHaveBeenCalledOnce();
        db.prepare("DELETE FROM collections WHERE collection_id=?").run(
            COLLECTION,
        );
        expect(shouldProcessOffchainPayload(h.collections, admitted)).toBe(
            false,
        );
        await send();
        expect(h.publish).toHaveBeenCalledOnce();
    });
});
