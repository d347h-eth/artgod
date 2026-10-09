import { logger } from "@artgod/shared/utils";
import {
    isCurrentSyncGapRepair,
    planSyncGapRepairBatches,
    type SyncGapRepairBatch,
    type SyncGapRepairCursor,
} from "../domain/sync-gap-repair.js";
import {
    REORG_RECOVERY_PHASE,
    type ReorgResyncRange,
} from "../domain/reorg-recovery.js";
import {
    SYNC_WORK_COMPLETION,
    type SyncWorkCompletion,
} from "../domain/sync-work.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    SYNC_JOB_KIND,
} from "../domain/sync-jobs.js";
import type { CollectionRecord } from "../domain/collections.js";
import type { DomainSyncSource } from "../domain/domain-jobs.js";
import type {
    CollectionRegistryPort,
    CollectionScopeResolverPort,
} from "../ports/collections.js";
import type { SyncRangeCommitPort } from "../ports/sync-range-commit.js";
import type { ReorgRecoveryStore } from "./reorg-recovery.js";
import {
    BACKFILL_EXECUTION_MODE,
    type BackfillExecutionGate,
} from "./backfill-execution.js";
import {
    processSyncRange,
    resolveBackfillCollections,
    type SyncRangeInput,
} from "./sync-range-processing.js";
import {
    SYNC_GAP_POLICY,
    type SyncGapStorePort,
    type SyncGapHeadRecheckPort,
} from "./sync-gap-scheduler.js";
import type { SyncRange } from "./sync.js";

export const AUTOMATIC_SYNC_POLICY = {
    PollMs: 12_000,
    RetryDelayMs: 5 * 60_000,
} as const;
const LOG_COMPONENT = "AutomaticSyncExecutor";
const LOG_ACTION = { Range: "range", Poll: "poll" } as const;

type AutomaticSyncInput = Omit<
    SyncRangeInput,
    | "collections"
    | "range"
    | "orderMaintenancePolicy"
    | "collectionScopeResolver"
> & {
    commit: SyncRangeCommitPort;
    collectionsPort: Pick<
        CollectionRegistryPort,
        "getCollection" | "listCollectionsForSync"
    > &
        CollectionScopeResolverPort;
    gaps: SyncGapStorePort;
    headGapRecheck: SyncGapHeadRecheckPort;
    recoveries: Pick<ReorgRecoveryStore, "getRecovery" | "deferResync">;
    gate: Pick<BackfillExecutionGate, "run">;
    batchSize: number;
    retryDelayMs?: number;
    now?: () => number;
};

// One bounded acquisition per pass. SQLite owns intent before and after a crash;
// no broker message, delivery generation or publication reply owns progression.
export class AutomaticSyncExecutor {
    private active: Promise<void> | null = null;
    private gapCursor: SyncGapRepairCursor | null = null;
    private readonly now: () => number;
    private readonly retryDelayMs: number;

    constructor(private readonly input: AutomaticSyncInput) {
        this.now = input.now ?? Date.now;
        this.retryDelayMs =
            input.retryDelayMs ?? AUTOMATIC_SYNC_POLICY.RetryDelayMs;
        if (
            !Number.isSafeInteger(input.batchSize) ||
            input.batchSize < 1 ||
            !Number.isSafeInteger(this.retryDelayMs) ||
            this.retryDelayMs < 1
        )
            throw new Error("Invalid automatic sync policy");
    }

    runDue(): Promise<void> {
        if (!this.active)
            this.active = this.run().finally(() => {
                this.active = null;
            });
        return this.active;
    }

    private async run(): Promise<void> {
        const recovery = this.input.recoveries.getRecovery(this.input.chainId);
        if (
            recovery?.phase === REORG_RECOVERY_PHASE.Resync &&
            recovery.retryAt <= this.now()
        ) {
            await this.runReorgResync();
            return;
        }
        const pending = this.input.gaps.listDuePage({
            chainId: this.input.chainId,
            now: this.now(),
            limit: SYNC_GAP_POLICY.CollectionsPerPass,
            after: this.gapCursor,
        });
        if (
            !pending.repairs.length &&
            !this.input.headGapRecheck.hasHeadRechecksDue()
        ) {
            this.gapCursor = null;
            return;
        }
        await this.input.gate.run(
            BACKFILL_EXECUTION_MODE.SerializedCurrentState,
            async () => {
                // Waiting for this gate must not freeze an old selection. HEAD
                // checks and replacement happen before fetching any block data,
                // after the previous current-state backfill has finished.
                if (
                    this.input.recoveries.getRecovery(this.input.chainId)
                        ?.phase === REORG_RECOVERY_PHASE.Resync
                )
                    return;
                const head = await this.input.rpc.getBlockNumber();
                if (this.input.headGapRecheck.recheckFromHead(head))
                    this.gapCursor = null;
                const page = this.input.gaps.listDuePage({
                    chainId: this.input.chainId,
                    now: this.now(),
                    limit: SYNC_GAP_POLICY.CollectionsPerPass,
                    after: this.gapCursor,
                });
                const eligible = page.repairs.filter(
                    (repair) => repair.toBlock <= head,
                );
                this.gapCursor = eligible.length ? null : page.cursor;
                const oldest = eligible[0];
                const batch =
                    oldest &&
                    planSyncGapRepairBatches(
                        eligible,
                        this.input.batchSize,
                    ).find((candidate) =>
                        candidate.repairs.some(
                            (repair) =>
                                repair.collectionId === oldest.collectionId,
                        ),
                    );
                if (batch) await this.runGapRepair(batch);
            },
        );
    }

    private async runGapRepair(planned: SyncGapRepairBatch): Promise<void> {
        const admitted = planned.repairs.flatMap((repair) => {
            const collection = this.input.collectionsPort.getCollection(
                this.input.chainId,
                repair.collectionId,
            );
            if (
                !collection ||
                !isCurrentSyncGapRepair({
                    chainId: this.input.chainId,
                    repair,
                    collection,
                    progress: this.input.gaps.getProgress(
                        this.input.chainId,
                        repair.collectionId,
                    ),
                })
            )
                return [];
            return [{ repair, collection }];
        });
        if (!admitted.length) return;
        const repairs = admitted.map((member) => member.repair);
        const batch = { ...planned, repairs };
        const collections = admitted.map((member) => member.collection);
        const sources = repairs.map((repair) => {
            const id = `${repair.repairId}:range:${batch.fromBlock}-${batch.toBlock}`;
            return {
                fanoutId: id,
                sourceJobId: id,
                sourceKind: SYNC_JOB_KIND.BackfillRange,
                collectionId: repair.collectionId,
            };
        });
        try {
            await this.process(collections, batch, sources, {
                kind: SYNC_WORK_COMPLETION.GapRepair,
                batch,
                retryAt: this.now(),
            });
        } catch (error) {
            for (const repair of repairs)
                this.input.gaps.deferRetry(
                    this.input.chainId,
                    repair,
                    this.now() + this.retryDelayMs,
                );
            this.logFailure(SYNC_WORK_COMPLETION.GapRepair, batch, error);
        }
    }

    private async runReorgResync(): Promise<void> {
        await this.input.gate.run(
            BACKFILL_EXECUTION_MODE.SerializedCurrentState,
            async () => {
                const current = this.input.recoveries.getRecovery(
                    this.input.chainId,
                );
                if (
                    current?.phase !== REORG_RECOVERY_PHASE.Resync ||
                    current.retryAt > this.now()
                )
                    return;
                const collections = resolveBackfillCollections(
                    this.input.collectionsPort,
                    this.input.chainId,
                    null,
                );
                if (!collections.length) return;
                const range: ReorgResyncRange = {
                    chainId: current.chainId,
                    recoveryId: current.recoveryId,
                    revision: current.revision,
                    fromBlock: current.fromBlock,
                    toBlock: current.toBlock,
                };
                const id = `sync:reorg:${current.recoveryId}:${current.fromBlock}-${current.toBlock}`;
                try {
                    await this.process(
                        collections,
                        range,
                        [
                            {
                                fanoutId: id,
                                sourceJobId: id,
                                sourceKind: SYNC_JOB_KIND.BackfillRange,
                            },
                        ],
                        {
                            kind: SYNC_WORK_COMPLETION.ReorgResync,
                            range,
                            batchSize: this.input.batchSize,
                            retryAt: this.now(),
                        },
                    );
                } catch (error) {
                    this.input.recoveries.deferResync({
                        range,
                        retryAt: this.now() + this.retryDelayMs,
                        error: String(error),
                    });
                    this.logFailure(
                        SYNC_WORK_COMPLETION.ReorgResync,
                        range,
                        error,
                    );
                }
            },
        );
    }

    private async process(
        collections: CollectionRecord[],
        range: SyncRange,
        sources: DomainSyncSource[],
        completion: SyncWorkCompletion,
    ): Promise<void> {
        const result = await processSyncRange({
            rpc: this.input.rpc,
            storage: this.input.storage,
            commit: this.input.commit,
            collectionExtensions: this.input.collectionExtensions,
            chainId: this.input.chainId,
            bidderIndex: this.input.bidderIndex,
            wethAddress: this.input.wethAddress,
            collectionScopeResolver: this.input.collectionsPort,
            collections,
            range,
            sources,
            completion,
            mode: "backfill",
            orderMaintenancePolicy:
                BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
        });
        logger.info("Automatic sync range acquired", {
            component: LOG_COMPONENT,
            action: LOG_ACTION.Range,
            chainId: this.input.chainId,
            kind: completion.kind,
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            collectionIds: collections.map((collection) => collection.id),
            blocks: result.blocks.length,
        });
    }

    private logFailure(
        kind: SyncWorkCompletion["kind"],
        range: SyncRange,
        error: unknown,
    ): void {
        logger.warn("Automatic sync acquisition remains pending", {
            component: LOG_COMPONENT,
            action: LOG_ACTION.Range,
            chainId: this.input.chainId,
            kind,
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            error: String(error),
        });
    }
}

export function startAutomaticSyncLoop(
    executor: Pick<AutomaticSyncExecutor, "runDue">,
    pollMs: number = AUTOMATIC_SYNC_POLICY.PollMs,
): () => Promise<void> {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1)
        throw new Error("Invalid automatic sync polling interval");
    const tick = () =>
        executor.runDue().catch((error) =>
            logger.warn("Automatic sync pass failed", {
                component: LOG_COMPONENT,
                action: LOG_ACTION.Poll,
                error: String(error),
            }),
        );
    let active = tick();
    const timer = setInterval(() => {
        active = tick();
    }, pollMs);
    return async () => {
        clearInterval(timer);
        await active;
    };
}
