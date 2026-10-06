import { db } from "@artgod/shared/database";
import {
    RecoverChainReorg,
    executeReorgResync,
} from "../../src/application/reorg-recovery.js";
import { RollbackChainRange } from "../../src/application/reorg-rollback.js";
import {
    domainSyncSource,
    processRange,
    publishDomainJobs,
} from "../../src/application/sync-range-processing.js";
import { REORG_RECOVERY_PHASE } from "../../src/domain/reorg-recovery.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    type BackfillSyncPayload,
} from "../../src/domain/sync-jobs.js";
import type { DomainSyncSource } from "../../src/domain/domain-jobs.js";
import type { JobEnvelope } from "../../src/domain/jobs.js";
import type { CollectionRecord } from "../../src/domain/collections.js";
import type {
    RpcProviderPort,
    RpcContractRead,
    RpcLogFilter,
} from "../../src/ports/rpc.js";
import type { ChainBlockReference } from "../../src/domain/chain-sync.js";
import type { QueuePort } from "../../src/ports/queue.js";
import { SqliteCollectionRegistry } from "../../src/infra/collections/sqlite.js";
import { SqliteQueueOutbox } from "../../src/infra/queue/sqlite-queue-outbox.js";
import { SqliteStorage } from "../../src/infra/storage/sqlite.js";
import { SqliteReorgRecoveries } from "../../src/infra/storage/sqlite-reorg-recoveries.js";
import { RpcRollbackOwnershipSnapshot } from "../../src/infra/ownership/rpc-rollback-snapshot.js";
import { syncBlockFixture } from "./chain-fixture.js";
import { emptyOnChainData, transferFixture } from "./ownership-fixture.js";

export const REORG_FIXTURE = {
    ChainId: 1,
    Anchor: 100,
    Fork: 104,
    Orphan: 105,
    Head: 107,
    BatchSize: 2,
    Owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    OrphanOwner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    Weth: "0x0000000000000000000000000000000000000001",
} as const;

export function canonicalRecoveryBlock(
    number: number,
    forkBlock: number = REORG_FIXTURE.Fork,
) {
    const header = syncBlockFixture(number);
    const hash = (n: number) =>
        syncBlockFixture(n > forkBlock ? n + 10_000 : n).hash;
    return {
        ...header,
        hash: hash(number),
        parentHash: hash(Math.max(0, number - 1)),
    };
}

// Deterministic chain fixture; orchestration, exact-block snapshot translation,
// persistence, revision fences and fanout all use the production implementations.
export class RecoveryRpc implements RpcProviderPort {
    constructor(private readonly forkBlock: number = REORG_FIXTURE.Fork) {}

    ownerReads: ChainBlockReference[] = [];
    logReads = 0;
    beforeOwnerRead?: () => Promise<void>;
    beforeBlockRead?: (number: number) => Promise<void>;
    beforeLogs?: (filter: RpcLogFilter) => Promise<void>;
    async getBlockNumber(): Promise<number> {
        return REORG_FIXTURE.Head;
    }
    async getBlock(number: number) {
        await this.beforeBlockRead?.(number);
        return canonicalRecoveryBlock(number, this.forkBlock);
    }
    async getLogs(filter: RpcLogFilter) {
        this.logReads++;
        await this.beforeLogs?.(filter);
        return [];
    }
    async readContractAtBlock<T>(
        input: RpcContractRead & { block: ChainBlockReference },
    ): Promise<T> {
        this.ownerReads.push(input.block);
        await this.beforeOwnerRead?.();
        if (
            input.block.chainId !== REORG_FIXTURE.ChainId ||
            input.block.blockHash !==
                canonicalRecoveryBlock(input.block.blockNumber, this.forkBlock)
                    .hash
        )
            throw new Error(
                "Fixture cannot serve the requested canonical hash",
            );
        return REORG_FIXTURE.Owner as T;
    }
    async readContract<T>(): Promise<T> {
        throw new Error("Unexpected numeric contract read");
    }
    async getTransaction(): Promise<never> {
        throw new Error("Unexpected transaction read");
    }
    async getTransactionReceipt(): Promise<never> {
        throw new Error("Unexpected receipt read");
    }
    async getBalance(): Promise<never> {
        throw new Error("Unexpected balance read");
    }
}

export function reorgRecoveryServices(
    rpc: RecoveryRpc,
    options: { now?: () => number; retryDelayMs?: number } = {},
) {
    const storage = new SqliteStorage();
    const outbox = new SqliteQueueOutbox();
    const recoveries = new SqliteReorgRecoveries(storage, outbox);
    const registry = new SqliteCollectionRegistry();
    const recovery = new RecoverChainReorg(
        rpc,
        storage,
        recoveries,
        new RollbackChainRange(storage, new RpcRollbackOwnershipSnapshot(rpc)),
        {
            chainId: REORG_FIXTURE.ChainId,
            reorgDepth: 3,
            batchSize: REORG_FIXTURE.BatchSize,
            ...options,
        },
    );
    const syncAndPublish = async (
        job: JobEnvelope<BackfillSyncPayload>,
        queue: QueuePort,
        admission?: {
            collections: CollectionRecord[];
            sources: DomainSyncSource[];
        },
    ) => {
        const collections =
            admission?.collections ??
            registry.listCollectionsForSync(job.chainId, "backfill");
        if (!collections.length)
            throw new Error("No admitted fixture collection");
        const range = {
            fromBlock: job.payload.fromBlock,
            toBlock: job.payload.toBlock,
        };
        const { data } = await processRange({
            rpc,
            storage,
            collectionScopeResolver: registry,
            collectionExtensions: { getInstall: () => null },
            chainId: job.chainId,
            collections,
            range,
            bidderIndex: { isActive: () => false, shouldEmit: () => false },
            wethAddress: REORG_FIXTURE.Weth,
            orderMaintenancePolicy:
                BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
        });
        await publishDomainJobs(
            queue,
            job.chainId,
            collections,
            range,
            admission?.sources ?? [domainSyncSource(job)],
            "backfill",
            data,
            job.payload.orderMaintenancePolicy,
        );
    };
    return {
        storage,
        outbox,
        recoveries,
        registry,
        recovery,
        syncAndPublish,
        execute: (job: JobEnvelope<BackfillSyncPayload>, queue: QueuePort) =>
            executeReorgResync(
                job,
                recoveries,
                { batchSize: REORG_FIXTURE.BatchSize, ...options },
                () => syncAndPublish(job, queue),
            ),
    };
}

export function seedRecoveryHistory(includeAncestor = true) {
    const fixture = transferFixture();
    const collections = [
        new SqliteCollectionRegistry().getCollection(1, fixture.collectionId)!,
    ];
    fixture.storage.persistSyncResult({
        checkpoint: fixture.storage.captureSyncCheckpoint(1),
        blocks: [
            REORG_FIXTURE.Anchor,
            ...(includeAncestor ? [REORG_FIXTURE.Fork] : []),
        ].map(syncBlockFixture),
        data: emptyOnChainData(),
        collections,
    });
    fixture.persist([
        fixture.transfer(
            REORG_FIXTURE.Orphan,
            1,
            REORG_FIXTURE.Owner,
            REORG_FIXTURE.OrphanOwner,
        ),
    ]);
    return fixture;
}

export function pendingRecoveryJob() {
    const state = db
        .prepare("SELECT phase FROM chain_reorg_recoveries")
        .get() as { phase: string } | undefined;
    if (state?.phase !== REORG_RECOVERY_PHASE.Resync)
        throw new Error("No resync continuation");
    const row = db
        .prepare(
            "SELECT job_json FROM queue_outbox ORDER BY outbox_id DESC LIMIT 1",
        )
        .get() as { job_json: string } | undefined;
    if (!row) throw new Error("Missing durable continuation publication");
    return JSON.parse(row.job_json) as JobEnvelope<BackfillSyncPayload>;
}
