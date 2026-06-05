import { describe, expect, it } from "vitest";
import { publishOrderUpdateJobs } from "../src/application/order-update-fanout.js";
import {
    allowsGlobalMakerRevalidation,
    shouldFetchWethMakerLogs,
} from "../src/application/backfill-order-maintenance.js";
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
import { QUEUE_NAMES, type QueueName } from "../src/domain/queues.js";
import { BACKFILL_ORDER_MAINTENANCE_POLICY } from "../src/domain/sync-jobs.js";
import type {
    QueueMessage,
    QueuePort,
    SubscribeOptions,
} from "../src/ports/queue.js";

describe("backfill order maintenance", () => {
    it("does not fetch WETH maker logs for manual historical policy", () => {
        expect(
            shouldFetchWethMakerLogs({
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
                range: { fromBlock: 100, toBlock: 110 },
                bidderIndexActive: true,
                hasCurrentStateProjection: true,
            }),
        ).toBe(false);
    });

    it("fetches WETH maker logs only when current-state guards all pass", () => {
        expect(
            shouldFetchWethMakerLogs({
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                range: { fromBlock: 100, toBlock: 110 },
                bidderIndexActive: true,
                hasCurrentStateProjection: true,
            }),
        ).toBe(true);
        expect(
            shouldFetchWethMakerLogs({
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                range: { fromBlock: 100, toBlock: 110 },
                bidderIndexActive: false,
                hasCurrentStateProjection: true,
            }),
        ).toBe(false);
        expect(
            shouldFetchWethMakerLogs({
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                range: { fromBlock: 110, toBlock: 100 },
                bidderIndexActive: true,
                hasCurrentStateProjection: true,
            }),
        ).toBe(false);
        expect(
            shouldFetchWethMakerLogs({
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                range: { fromBlock: 100, toBlock: 110 },
                bidderIndexActive: true,
                hasCurrentStateProjection: false,
            }),
        ).toBe(false);
    });

    it("skips global maker fanout while keeping token-scoped maker triggers", async () => {
        const queue = new RecordingQueue();
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

        await publishOrderUpdateJobs(
            queue,
            1,
            [collectionWithAnchor(100)],
            data,
            BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
        );

        const makerPayloads = orderUpdateByMakerPayloads(queue);
        expect(makerPayloads).toHaveLength(2);
        expect(makerPayloads[0]).toMatchObject({
            scope: MAKER_TRIGGER_SCOPE.Token,
            reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
            collectionId: 7,
            tokenId: "1",
        });
        expect(makerPayloads[1]).toMatchObject({
            scope: MAKER_TRIGGER_SCOPE.Collection,
            reason: COLLECTION_SCOPED_MAKER_TRIGGER_REASON.NftApprovalForAll,
            collectionId: 7,
        });
    });

    it("keeps global maker fanout for current-state repair policy", async () => {
        const queue = new RecordingQueue();
        const data = emptyOnChainData();
        data.global.makerTriggers.push(
            globalTrigger(
                GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
                "0x00000000000000000000000000000000000000c1",
                2,
            ),
        );

        await publishOrderUpdateJobs(
            queue,
            1,
            [collectionWithAnchor(100)],
            data,
            BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
        );

        expect(orderUpdateByMakerPayloads(queue)).toEqual([
            expect.objectContaining({
                scope: MAKER_TRIGGER_SCOPE.Global,
                reason: GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
            }),
        ]);
    });

    it("treats order-counter as policy-gated global maker fanout", async () => {
        expect(
            allowsGlobalMakerRevalidation(
                BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            ),
        ).toBe(true);
        expect(
            allowsGlobalMakerRevalidation(
                BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
            ),
        ).toBe(false);

        const currentStateQueue = new RecordingQueue();
        const currentStateData = emptyOnChainData();
        currentStateData.global.makerTriggers.push(
            globalTrigger(
                GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
                "0x00000000000000000000000000000000000000d1",
                5,
            ),
        );
        await publishOrderUpdateJobs(
            currentStateQueue,
            1,
            [collectionWithAnchor(100)],
            currentStateData,
            BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
        );

        const manualQueue = new RecordingQueue();
        const manualData = emptyOnChainData();
        manualData.global.makerTriggers.push(
            globalTrigger(
                GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
                "0x00000000000000000000000000000000000000d1",
                5,
            ),
        );
        await publishOrderUpdateJobs(
            manualQueue,
            1,
            [collectionWithAnchor(100)],
            manualData,
            BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
        );

        expect(orderUpdateByMakerPayloads(currentStateQueue)).toEqual([
            expect.objectContaining({
                scope: MAKER_TRIGGER_SCOPE.Global,
                reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
            }),
        ]);
        expect(orderUpdateByMakerPayloads(manualQueue)).toEqual([]);
    });
});

class RecordingQueue implements QueuePort {
    readonly published: Array<{
        queue: QueueName;
        message: JobEnvelope<unknown>;
    }> = [];

    async publish<TPayload>(
        queue: QueueName,
        message: JobEnvelope<TPayload>,
    ): Promise<void> {
        this.published.push({
            queue,
            message: message as JobEnvelope<unknown>,
        });
    }

    async subscribe<TPayload>(
        _queue: QueueName,
        _handler: (message: QueueMessage<TPayload>) => Promise<void>,
        _options: SubscribeOptions,
    ): Promise<() => Promise<void>> {
        throw new Error("RecordingQueue does not support subscribe");
    }

    async close(): Promise<void> {}
}

function orderUpdateByMakerPayloads(
    queue: RecordingQueue,
): OrderUpdateByMakerPayload[] {
    return queue.published
        .filter(
            (entry) =>
                entry.queue === QUEUE_NAMES.OrdersUpdateByMaker &&
                entry.message.kind === ORDER_JOB_KIND.UpdateByMaker,
        )
        .map((entry) => entry.message.payload as OrderUpdateByMakerPayload);
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
