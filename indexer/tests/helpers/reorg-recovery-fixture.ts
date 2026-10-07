import { db } from "@artgod/shared/database";
import { RecoverChainReorg } from "../../src/application/reorg-recovery.js";
import { RollbackChainRange } from "../../src/application/reorg-rollback.js";
import { AutomaticSyncExecutor } from "../../src/application/automatic-sync-executor.js";
import { BackfillExecutionGate } from "../../src/application/backfill-execution.js";
import { drainQueueOutbox } from "../../src/application/queue-outbox/drainer.js";
import { SqliteSyncGapStore } from "../../src/infra/storage/sqlite-sync-gaps.js";
import { SqliteSyncRangeCommit } from "../../src/infra/storage/sqlite-sync-range-commit.js";
import {
    REORG_RECOVERY_PHASE,
    isCurrentReorgRange,
    type ReorgResyncRange,
} from "../../src/domain/reorg-recovery.js";
import type {
    RpcProviderPort,
    RpcContractRead,
    RpcLogFilter,
    RpcLog,
    RpcTransaction,
    RpcTransactionReceipt,
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
    logs: RpcLog[] = [];
    transactions = new Map<string, RpcTransaction>();
    receipts = new Map<string, RpcTransactionReceipt>();
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
        return this.logs.filter(
            (log) =>
                log.blockNumber >= filter.fromBlock &&
                log.blockNumber <= filter.toBlock &&
                (!filter.address ||
                    (Array.isArray(filter.address)
                        ? filter.address.includes(log.address)
                        : filter.address === log.address)),
        );
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
    async getTransaction(hash: string): Promise<RpcTransaction> {
        const transaction = this.transactions.get(hash);
        if (transaction) return transaction;
        throw new Error("Unexpected transaction read");
    }
    async getTransactionReceipt(hash: string): Promise<RpcTransactionReceipt> {
        const receipt = this.receipts.get(hash);
        if (receipt) return receipt;
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
    const recoveries = new SqliteReorgRecoveries(storage);
    const gaps = new SqliteSyncGapStore();
    const registry = new SqliteCollectionRegistry();
    const commit = new SqliteSyncRangeCommit({
        storage,
        outbox,
        gaps,
        recoveries,
        collections: registry,
    });
    const executor = new AutomaticSyncExecutor({
        rpc,
        storage,
        commit,
        gaps,
        recoveries,
        collectionsPort: registry,
        collectionExtensions: { getInstall: () => null },
        chainId: REORG_FIXTURE.ChainId,
        bidderIndex: { isActive: () => false, shouldEmit: () => false },
        wethAddress: REORG_FIXTURE.Weth,
        batchSize: REORG_FIXTURE.BatchSize,
        gate: new BackfillExecutionGate(),
        ...options,
    });
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
    return {
        storage,
        outbox,
        gaps,
        commit,
        executor,
        recoveries,
        registry,
        recovery,
        acquireRecoveryRange: async (range: ReorgResyncRange) => {
            if (
                !isCurrentReorgRange(
                    recoveries.getRecovery(range.chainId),
                    range,
                )
            )
                return false;
            await executor.runDue();
            return !isCurrentReorgRange(
                recoveries.getRecovery(range.chainId),
                range,
            );
        },
        publishRetained: (queue: QueuePort) =>
            drainQueueOutbox(outbox, queue, { retryBaseDelayMs: 0 }),
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

export function pendingRecoveryRange(): ReorgResyncRange {
    const row = db
        .prepare(
            "SELECT chain_id, recovery_id, revision, phase, range_from, range_to FROM chain_reorg_recoveries",
        )
        .get() as
        | {
              chain_id: number;
              recovery_id: string;
              revision: number;
              phase: string;
              range_from: number;
              range_to: number;
          }
        | undefined;
    if (row?.phase !== REORG_RECOVERY_PHASE.Resync)
        throw new Error("No pending resync range");
    return {
        chainId: row.chain_id,
        recoveryId: row.recovery_id,
        revision: row.revision,
        fromBlock: row.range_from,
        toBlock: row.range_to,
    };
}
