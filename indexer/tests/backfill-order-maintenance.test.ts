import { setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { encodeEventTopics, erc20Abi, toHex } from "viem";
import { acquireSyncRange } from "../src/application/sync-range-processing.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    insertCollection,
    loadCollection,
} from "./helpers/ownership-fixture.js";
import {
    RecoveryRpc,
    REORG_FIXTURE,
} from "./helpers/reorg-recovery-fixture.js";
import { OPENSEA_STREAM_INGESTION_STATUS } from "@artgod/shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOrderUpdateFollowUps } from "../src/application/order-update-fanout.js";
import { CollectionRecord } from "../src/domain/collections.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import {
    COLLECTION_SCOPED_MAKER_TRIGGER_REASON,
    GLOBAL_MAKER_TRIGGER_REASON,
    TOKEN_SCOPED_MAKER_TRIGGER_REASON,
} from "../src/domain/maker-triggers.js";
import type { OnChainData } from "../src/domain/onchain.js";
import {
    MAKER_TRIGGER_SCOPE,
    ORDER_JOB_KIND,
    type OrderUpdateByMakerPayload,
} from "../src/domain/order-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { BACKFILL_ORDER_MAINTENANCE_POLICY } from "../src/domain/sync-jobs.js";

describe("backfill order maintenance", () => {
    it("keeps historical facts-only acquisition out of every current order lane", async () => {
        const data = emptyOnChainData();
        data.collectionScoped.makerTriggers.push({
            collectionId: 7,
            contract: "0x0000000000000000000000000000000000000007",
            tokenId: "1",
            maker: "0x00000000000000000000000000000000000000a1",
            reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
            blockNumber: 101,
            blockHash: "0xblock",
            txHash: "0xtoken",
            logIndex: 1,
        });
        data.collectionScoped.makerTriggers.push({
            collectionId: 7,
            contract: "0x0000000000000000000000000000000000000007",
            maker: "0x00000000000000000000000000000000000000a2",
            reason: COLLECTION_SCOPED_MAKER_TRIGGER_REASON.NftApprovalForAll,
            blockNumber: 101,
            blockHash: "0xblock",
            txHash: "0xcollection",
            logIndex: 2,
        });
        data.global.makerTriggers.push(
            globalTrigger(
                GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
                "0x00000000000000000000000000000000000000b1",
                2,
            ),
            globalTrigger(
                GLOBAL_MAKER_TRIGGER_REASON.ApprovalChange,
                "0x00000000000000000000000000000000000000b2",
                3,
            ),
            globalTrigger(
                GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
                "0x00000000000000000000000000000000000000b3",
                4,
            ),
        );

        const jobs = buildOrderUpdateFollowUps(
            1,
            [collectionWithAnchor(100)],
            data,
            BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
            false,
        ).map((followUp) => followUp.job);

        expect(jobs).toEqual([]);
    });

    it("keeps global maker fanout for current-state repair policy", async () => {
        const data = emptyOnChainData();
        data.global.makerTriggers.push(
            globalTrigger(
                GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
                "0x00000000000000000000000000000000000000c1",
                2,
            ),
        );

        const jobs = buildOrderUpdateFollowUps(
            1,
            [collectionWithAnchor(100)],
            data,
            BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            true,
        ).map((followUp) => followUp.job);

        expect(orderUpdateByMakerPayloads(jobs)).toEqual([
            expect.objectContaining({
                scope: MAKER_TRIGGER_SCOPE.Global,
                reason: GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
            }),
        ]);
    });

    it("treats order-counter as policy-gated global maker fanout", async () => {
        const currentStateData = emptyOnChainData();
        currentStateData.global.makerTriggers.push(
            globalTrigger(
                GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
                "0x00000000000000000000000000000000000000d1",
                5,
            ),
        );
        const currentStateJobs = buildOrderUpdateFollowUps(
            1,
            [collectionWithAnchor(100)],
            currentStateData,
            BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            true,
        ).map((followUp) => followUp.job);

        const manualData = emptyOnChainData();
        manualData.global.makerTriggers.push(
            globalTrigger(
                GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
                "0x00000000000000000000000000000000000000d1",
                5,
            ),
        );
        const manualJobs = buildOrderUpdateFollowUps(
            1,
            [collectionWithAnchor(100)],
            manualData,
            BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
            false,
        ).map((followUp) => followUp.job);

        expect(orderUpdateByMakerPayloads(currentStateJobs)).toEqual([
            expect.objectContaining({
                scope: MAKER_TRIGGER_SCOPE.Global,
                reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
            }),
        ]);
        expect(orderUpdateByMakerPayloads(manualJobs)).toEqual([]);
    });
});

function orderUpdateByMakerPayloads(
    jobs: JobEnvelope[],
): OrderUpdateByMakerPayload[] {
    return jobs
        .filter(
            (job) =>
                (job.queue === QUEUE_NAMES.OrdersUpdateByMaker ||
                    job.queue === QUEUE_NAMES.OrdersUpdateByToken) &&
                job.kind === ORDER_JOB_KIND.UpdateByMaker,
        )
        .map((job) => job.payload as OrderUpdateByMakerPayload);
}

function globalTrigger(
    reason: OnChainData["global"]["makerTriggers"][number]["reason"],
    maker: string,
    logIndex: number,
): OnChainData["global"]["makerTriggers"][number] {
    return {
        maker,
        reason,
        blockNumber: 101,
        blockHash: "0xblock",
        txHash: `0xglobal${logIndex}`,
        logIndex,
    };
}

function emptyOnChainData(): OnChainData {
    return {
        transactions: [],
        collectionScoped: {
            nftTransferEvents: [],
            nftApprovalEvents: [],
            nftBalanceDeltas: [],
            fillEvents: [],
            orderInfos: [],
            makerTriggers: [],
            metadataRefreshEvents: [],
            metadataRefreshRangeEvents: [],
            collectionExtensionEvents: [],
            collectionExtensionEventMedia: [],
        },
        global: {
            cancelEvents: [],
            makerTriggers: [],
        },
    };
}

function collectionWithAnchor(anchorBlock: number): CollectionRecord {
    return CollectionRecord.fromPersistence({
        chainId: 1,
        id: 7,
        slug: "fixture",
        address: "0x0000000000000000000000000000000000000007",
        standard: "erc721",
        status: "live",
        tokenScopeKind: "contract_all_tokens",
        scopeStartTokenId: null,
        scopeTotalSupply: null,
        deploymentBlock: 1,
        bootstrapAnchorBlock: anchorBlock,
        bootstrapStartedAt: null,
        bootstrapFinishedAt: null,
        bootstrapLastSyncedBlock: null,
        openseaSlug: null,
        openseaStatus: null,
        openseaStreamIngestionStatus: OPENSEA_STREAM_INGESTION_STATUS.Enabled,
        openseaReadyAt: null,
        openseaSnapshotStartedAt: null,
        openseaSnapshotCompletedAt: null,
        openseaReconcileStartedAt: null,
        openseaReconcileCompletedAt: null,
        openseaLastStreamEventAt: null,
        openseaLastStreamHealthyAt: null,
        openseaLastError: null,
    });
}

describe("current protocol acquisition ownership", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    function fixture(withCollection = false) {
        const collections = withCollection
            ? [
                  loadCollection(
                      1,
                      insertCollection({
                          chainId: 1,
                          slug: "scope",
                          address: "0x0000000000000000000000000000000000000007",
                          anchorBlock: 100,
                      }),
                  ),
              ]
            : [];
        const f = createAppliedSyncFixture({
            chainId: 1,
            anchor: block(100),
            collections,
        });
        const rpc = new RecoveryRpc(200, 110);
        rpc.logs.push({
            address: REORG_FIXTURE.Weth,
            data: toHex(1n, { size: 32 }),
            topics: encodeEventTopics({
                abi: erc20Abi,
                eventName: "Transfer",
                args: {
                    from: REORG_FIXTURE.Owner,
                    to: REORG_FIXTURE.OrphanOwner,
                },
            }),
            blockNumber: 101,
            blockHash: block(101).hash,
            transactionHash: toHex(1n, { size: 32 }),
            logIndex: 0,
        });
        const logs = vi.spyOn(rpc, "getLogs");
        const acquire = (
            application: Parameters<typeof acquireSyncRange>[0]["application"],
            fromBlock = 101,
        ) =>
            acquireSyncRange({
                rpc,
                storage: f.storage,
                collectionScopeResolver: f.registry,
                collectionExtensions: { getInstall: () => null },
                chainId: 1,
                reorgDepth: 3,
                collections,
                range: { fromBlock, toBlock: fromBlock },
                application,
                wethAddress: REORG_FIXTURE.Weth,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            });
        return { ...f, collections, rpc, logs, acquire };
    }

    it("acquires global WETH effects when shared progress advances without any collections", async () => {
        const f = fixture();
        const result = await f.acquire(
            f.applied({ blocks: [block(101)], shared: true, collectionIds: [] })
                .application,
        );
        expect(
            result.data.global.makerTriggers.map((trigger) => trigger.maker),
        ).toEqual([REORG_FIXTURE.Owner, REORG_FIXTURE.OrphanOwner]);
        expect(
            f.logs.mock.calls.some(
                ([filter]) => filter.address === REORG_FIXTURE.Weth,
            ),
        ).toBe(true);
    });

    it("does not acquire WETH effects during historical enrichment", async () => {
        const f = fixture();
        const result = await f.acquire(
            f.historical({ blocks: [block(100)], collectionIds: [] })
                .application,
            100,
        );
        expect(result.data.global.makerTriggers).toEqual([]);
        expect(
            f.logs.mock.calls.some(
                ([filter]) => filter.address === REORG_FIXTURE.Weth,
            ),
        ).toBe(false);
    });

    it("does not repeat shared WETH acquisition during collection-only replay", async () => {
        const f = fixture(true);
        f.commit(
            f.applied({
                blocks: [block(101)],
                shared: true,
                collectionIds: [],
            }),
        );
        const result = await f.acquire(
            f.applied({
                blocks: [block(101)],
                shared: false,
                collectionIds: f.collections.map((collection) => collection.id),
            }).application,
        );
        expect(result.data.global.makerTriggers).toEqual([]);
        expect(
            f.logs.mock.calls.some(
                ([filter]) => filter.address === REORG_FIXTURE.Weth,
            ),
        ).toBe(false);
    });
});
