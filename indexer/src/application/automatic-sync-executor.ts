import { RpcBudgetDeferred } from "@artgod/shared/evm/rpc-budget";
import {
    SYNC_WORK_CLASS,
    type SyncWorkClass,
} from "@artgod/shared/types/sync-work-class";
import { logger } from "@artgod/shared/utils";
import {
    isCurrentSyncGapRepair,
    planSyncGapRepairBatches,
    type SyncGapRepairBatch,
} from "../domain/sync-gap-repair.js";
import {
    REORG_RECOVERY_PHASE,
    type ReorgResyncRange,
} from "../domain/reorg-recovery.js";
import {
    SYNC_WORK_COMPLETION,
    AUTOMATIC_GAP_WORK_POLICY,
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
    type SyncGapDetectorPort,
} from "./sync-gap-scheduler.js";
import type { SyncRange } from "./sync.js";

export const AUTOMATIC_SYNC_POLICY = {
    PollMs: 12_000,
    RetryDelayMs: AUTOMATIC_GAP_WORK_POLICY.RetryDelayMs,
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
    gapScheduler: SyncGapHeadRecheckPort & SyncGapDetectorPort;
    gapWorkEnabled: boolean;
    workScope: { run<T>(workClass: SyncWorkClass, task: () => T): T };
    recoveries: Pick<ReorgRecoveryStore, "getRecovery" | "deferResync">;
    gate: Pick<BackfillExecutionGate, "run">;
    batchSize: number;
    retryDelayMs?: number;
    now?: () => number;
};

// One bounded acquisition per pass. SQLite owns intent before and after a crash;
// no broker message, delivery generation or publication reply owns progression.
export class AutomaticSyncExecutor {
    private active: Promise<boolean> | null = null;
    private discoveryHead: { block: number; readAt: number } | null = null;
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

    // True requests another immediate pass; false means idle, paused or waiting.
    runDue(): Promise<boolean> {
        if (!this.active)
            this.active = this.run().finally(() => {
                this.active = null;
            });
        return this.active;
    }

    private async run(): Promise<boolean> {
        const recovery = this.input.recoveries.getRecovery(this.input.chainId);
        if (recovery?.phase === REORG_RECOVERY_PHASE.Resync) {
            if (recovery.retryAt > this.now()) return false;
            return this.input.workScope.run(SYNC_WORK_CLASS.Main, () =>
                this.runReorgResync(),
            );
        }
        if (
            !this.input.gapWorkEnabled ||
            !this.input.gapScheduler.hasCollections()
        )
            return false;
        return this.input.workScope.run(SYNC_WORK_CLASS.GapRepair, () =>
            this.input.gate.run(
                BACKFILL_EXECUTION_MODE.SerializedCurrentState,
                async () => {
                    // Reselect after any manual/recovery work admitted ahead of this pass.
                    if (
                        this.input.recoveries.getRecovery(this.input.chainId)
                            ?.phase === REORG_RECOVERY_PHASE.Resync
                    )
                        return false;
                    // Reuse a briefly observed HEAD for local-only discovery pages.
                    // Fetch-and-save work always reads a fresh HEAD before selection.
                    let freshHead =
                        !this.discoveryHead ||
                        this.now() - this.discoveryHead.readAt >=
                            AUTOMATIC_SYNC_POLICY.PollMs ||
                        this.input.gapScheduler.hasHeadRechecksDue();
                    let head = freshHead
                        ? await this.readHead()
                        : this.discoveryHead!.block;
                    this.input.gapScheduler.recheckFromHead(head);
                    const moreToScan = await this.input.gapScheduler.scan(head);
                    let pending = this.dueGaps();
                    if (pending.length && !freshHead) {
                        head = await this.readHead();
                        this.input.gapScheduler.recheckFromHead(head);
                        pending = this.dueGaps();
                    }
                    // Keep the newest retained height even during backoff or RPC lag.
                    const batch = planSyncGapRepairBatches(
                        pending.filter((repair) => repair.toBlock <= head),
                        this.input.batchSize,
                    )[0];
                    return batch ? this.runGapRepair(batch) : moreToScan;
                },
                SYNC_WORK_CLASS.GapRepair,
            ),
        );
    }

    private dueGaps() {
        return this.input.gaps.listDueRepairsAtNewestPendingHeight({
            chainId: this.input.chainId,
            now: this.now(),
            limit: SYNC_GAP_POLICY.CollectionsPerPass,
        });
    }

    private async readHead(): Promise<number> {
        const block = await this.input.rpc.getBlockNumber();
        this.discoveryHead = { block, readAt: this.now() };
        return block;
    }

    private async runGapRepair(planned: SyncGapRepairBatch): Promise<boolean> {
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
        if (!admitted.length) return false;
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
            return true;
        } catch (error) {
            for (const repair of repairs)
                this.input.gaps.deferRetry(
                    this.input.chainId,
                    repair,
                    this.now() +
                        (error instanceof RpcBudgetDeferred
                            ? error.retryAfterMs
                            : this.retryDelayMs),
                );
            if (!(error instanceof RpcBudgetDeferred))
                this.logFailure(SYNC_WORK_COMPLETION.GapRepair, batch, error);
            return false;
        }
    }

    private async runReorgResync(): Promise<boolean> {
        return this.input.gate.run(
            BACKFILL_EXECUTION_MODE.SerializedCurrentState,
            async () => {
                const current = this.input.recoveries.getRecovery(
                    this.input.chainId,
                );
                if (
                    current?.phase !== REORG_RECOVERY_PHASE.Resync ||
                    current.retryAt > this.now()
                )
                    return false;
                const collections = resolveBackfillCollections(
                    this.input.collectionsPort,
                    this.input.chainId,
                    null,
                );
                if (!collections.length) return false;
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
                    return true;
                } catch (error) {
                    this.input.recoveries.deferResync({
                        range,
                        retryAt:
                            this.now() +
                            (error instanceof RpcBudgetDeferred
                                ? error.retryAfterMs
                                : this.retryDelayMs),
                        error: String(error),
                    });
                    this.logFailure(
                        SYNC_WORK_COMPLETION.ReorgResync,
                        range,
                        error,
                    );
                    return false;
                }
            },
            SYNC_WORK_CLASS.Main,
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
    let stopped = false;
    let resume: (() => void) | undefined;
    const active = (async () => {
        while (!stopped) {
            let busy = false;
            try {
                busy = await executor.runDue();
            } catch (error) {
                if (!(error instanceof RpcBudgetDeferred))
                    logger.warn("Automatic sync pass failed", {
                        component: LOG_COMPONENT,
                        action: LOG_ACTION.Poll,
                        error: String(error),
                    });
            }
            if (stopped) break;
            await new Promise<void>((resolve) => {
                const timer = setTimeout(
                    () => {
                        resume = undefined;
                        resolve();
                    },
                    busy ? 0 : pollMs,
                );
                resume = () => {
                    clearTimeout(timer);
                    resume = undefined;
                    resolve();
                };
            });
        }
    })();
    return async () => {
        stopped = true;
        resume?.();
        await active;
    };
}
