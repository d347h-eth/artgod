import { db } from "@artgod/shared/database";
import {
    AutomaticSyncExecutor,
    type AutomaticSyncObserver,
} from "../../src/application/automatic-sync-executor.js";
import { RecoverChainReorg } from "../../src/application/reorg-recovery.js";
import { RollbackChainRange } from "../../src/application/reorg-rollback.js";
import { SyncGapScheduler } from "../../src/application/sync-gap-scheduler.js";
import { SqliteCanonicalChecks } from "../../src/infra/storage/sqlite-canonical-checks.js";
import { SqliteReorgRecoveries } from "../../src/infra/storage/sqlite-reorg-recoveries.js";
import { SqliteSyncCoordination } from "../../src/infra/storage/sqlite-sync-coordination.js";
import { SqliteSyncGapStore } from "../../src/infra/storage/sqlite-sync-gaps.js";
import { SqliteSyncRangeCommit } from "../../src/infra/storage/sqlite-sync-range-commit.js";
import { SqliteStorage } from "../../src/infra/storage/sqlite.js";
import { SqliteChainProgress } from "../../src/infra/storage/sqlite-chain-progress.js";
import { SqliteCollectionRegistry } from "../../src/infra/collections/sqlite.js";
import { SqliteQueueOutbox } from "../../src/infra/queue/sqlite-queue-outbox.js";
import { RpcRollbackOwnershipSnapshot } from "../../src/infra/ownership/rpc-rollback-snapshot.js";
import { RpcWorkScope } from "../../src/infra/rpc/work-scope.js";
import type {
    RpcProviderPort,
    RpcBlock,
    RpcLogFilter,
} from "../../src/ports/rpc.js";
import { createAppliedSyncFixture } from "./applied-sync-fixture.js";
import { syncBlockFixture } from "./chain-fixture.js";
import { insertCollection, loadCollection } from "./ownership-fixture.js";

export const COORDINATED_SYNC_FIXTURE = {
    chainId: 1,
    anchor: 900,
    head: 904,
    batchSize: 1,
    reorgDepth: 4,
    retryDelayMs: 100,
    weth: "0x0000000000000000000000000000000000000001",
} as const;

/** Only the remote provider is a double. Selection, recovery, acquisition,
 * acceptance, outbox and progress use their real application/SQLite owners. */
export function coordinatorRpc(head = COORDINATED_SYNC_FIXTURE.head) {
    const state = {
        head: Number(head),
        headers: new Map<number, RpcBlock>(),
        blockReads: [] as number[],
        logReads: [] as RpcLogFilter[],
        beforeLogs: undefined as
            | ((filter: RpcLogFilter) => Promise<void>)
            | undefined,
        beforeBlock: undefined as
            | ((number: number) => Promise<void>)
            | undefined,
    };
    const unexpected = async (): Promise<never> => {
        throw new Error(
            "Unexpected state RPC in empty-log coordinator fixture",
        );
    };
    const rpc: RpcProviderPort = {
        getBlockNumber: async () => state.head,
        getBlock: async (number) => {
            state.blockReads.push(number);
            await state.beforeBlock?.(number);
            return state.headers.get(number) ?? syncBlockFixture(number);
        },
        getLogs: async (filter) => {
            state.logReads.push(filter);
            await state.beforeLogs?.(filter);
            return [];
        },
        getTransaction: unexpected,
        getTransactionReceipt: unexpected,
        readContract: unexpected,
        readContractAtBlock: unexpected,
        getBalanceAtBlock: unexpected,
        getBalance: unexpected,
    };
    return { rpc, state };
}

export function installedCoordinatorCollection(
    slug: string,
    anchor = COORDINATED_SYNC_FIXTURE.anchor,
) {
    const collectionId = insertCollection({
        chainId: COORDINATED_SYNC_FIXTURE.chainId,
        slug,
        address: `0x${Buffer.from(slug).toString("hex").slice(0, 40).padEnd(40, "0")}`,
        anchorBlock: anchor,
    });
    return loadCollection(COORDINATED_SYNC_FIXTURE.chainId, collectionId);
}

export function retainInstalledCoordinatorBase(
    collectionId: number,
    anchor: number,
    revision = 0,
) {
    db.prepare(
        "INSERT INTO collection_ownership_bases(chain_id,collection_id,run_id,revision,anchor_block,anchor_hash) VALUES (?,?,?,?,?,?)",
    ).run(
        COORDINATED_SYNC_FIXTURE.chainId,
        collectionId,
        collectionId,
        revision,
        anchor,
        syncBlockFixture(anchor).hash,
    );
}

export function createCoordinatorFixture(
    options: {
        collectionCount?: number;
        gapWorkEnabled?: boolean;
        batchSize?: number;
        now?: () => number;
        observer?: AutomaticSyncObserver;
    } = {},
) {
    const collections = Array.from(
        { length: options.collectionCount ?? 1 },
        (_, index) => installedCoordinatorCollection(`scope-${index}`),
    );
    const remote = coordinatorRpc();
    const historical = coordinatorRpc();
    const now = options.now ?? (() => 1_000);
    const fixture = createAppliedSyncFixture({
        chainId: COORDINATED_SYNC_FIXTURE.chainId,
        anchor: syncBlockFixture(COORDINATED_SYNC_FIXTURE.anchor),
        collections,
        now,
    });
    const construct = () => {
        const storage = new SqliteStorage();
        const progress = new SqliteChainProgress();
        const registry = new SqliteCollectionRegistry();
        const outbox = new SqliteQueueOutbox();
        const checks = new SqliteCanonicalChecks();
        const recoveries = new SqliteReorgRecoveries(storage, checks);
        const gaps = new SqliteSyncGapStore();
        const coordination = new SqliteSyncCoordination(progress);
        const workScope = new RpcWorkScope();
        const batchSize =
            options.batchSize ?? COORDINATED_SYNC_FIXTURE.batchSize;
        const recovery = new RecoverChainReorg(
            remote.rpc,
            storage,
            recoveries,
            new RollbackChainRange(
                storage,
                new RpcRollbackOwnershipSnapshot(remote.rpc),
            ),
            checks,
            {
                chainId: COORDINATED_SYNC_FIXTURE.chainId,
                reorgDepth: COORDINATED_SYNC_FIXTURE.reorgDepth,
                batchSize,
                now,
                retryDelayMs: COORDINATED_SYNC_FIXTURE.retryDelayMs,
            },
        );
        const commit = new SqliteSyncRangeCommit({
            storage,
            progress,
            outbox,
            collections: registry,
            gaps,
            recoveries,
            now,
            orderEffects: {
                retain({ effects }) {
                    if (effects.length)
                        throw new Error(
                            "Coordinator fixture requires empty order effects",
                        );
                },
            },
        });
        const executor = new AutomaticSyncExecutor({
            chainId: COORDINATED_SYNC_FIXTURE.chainId,
            rpc: remote.rpc,
            historicalRpc: historical.rpc,
            storage,
            commit,
            progress,
            coordination,
            canonicalChecks: checks,
            recoveries,
            recovery,
            gaps,
            collectionsPort: registry,
            collectionExtensions: { getInstall: () => null },
            gapScheduler: new SyncGapScheduler(registry, gaps, {
                chainId: COORDINATED_SYNC_FIXTURE.chainId,
                batchSize,
                now,
            }),
            gapWorkEnabled: options.gapWorkEnabled ?? false,
            workScope,
            batchSize,
            reorgDepth: COORDINATED_SYNC_FIXTURE.reorgDepth,
            wethAddress: COORDINATED_SYNC_FIXTURE.weth,
            now,
            retryDelayMs: COORDINATED_SYNC_FIXTURE.retryDelayMs,
            observer: options.observer,
        });
        return {
            storage,
            progress,
            registry,
            outbox,
            checks,
            recoveries,
            gaps,
            coordination,
            workScope,
            recovery,
            commit,
            executor,
        };
    };
    const sample = (number: number) =>
        fixture.progress.recordHeadSample(
            fixture.progress.captureHeadSample(
                COORDINATED_SYNC_FIXTURE.chainId,
            ),
            remote.state.headers.get(number) ?? syncBlockFixture(number),
            now(),
        );
    return {
        ...fixture,
        ...construct(),
        commitFixture: fixture.commit,
        collections,
        remote,
        historical,
        sample,
        restart: construct,
    };
}
