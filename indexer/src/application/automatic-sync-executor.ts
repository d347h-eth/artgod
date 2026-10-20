import { RpcBudgetDeferred } from "@artgod/shared/evm/rpc-budget";
import {
    SYNC_WORK_CLASS,
    type SyncWorkClass,
} from "@artgod/shared/types/sync-work-class";
import { logger } from "@artgod/shared/utils";
import {
    automaticGapUpperBound,
    ChainSyncConflict,
    StoredBlockHashConflict,
} from "../domain/chain-sync.js";
import {
    isCurrentSyncGapRepair,
    planSyncGapRepairBatches,
    type SyncGapRepairBatch,
} from "../domain/sync-gap-repair.js";
import { REORG_RECOVERY_PHASE } from "../domain/reorg-recovery.js";
import {
    SYNC_WORK_COMPLETION,
    SYNC_APPLICATION_KIND,
    AUTOMATIC_GAP_WORK_POLICY,
    type SyncWorkCompletion,
    type SyncApplication,
} from "../domain/sync-work.js";
import { BACKFILL_ORDER_MAINTENANCE_POLICY, SYNC_JOB_KIND } from "../domain/sync-jobs.js";
import type { CollectionRecord } from "../domain/collections.js";
import type { DomainSyncSource } from "../domain/domain-jobs.js";
import type {
    CollectionRegistryPort,
    CollectionScopeResolverPort,
} from "../ports/collections.js";
import type { SyncRangeCommitPort } from "../ports/sync-range-commit.js";
import type { CanonicalChecksPort } from "../ports/canonical-checks.js";
import type {
    RecoverChainReorg,
    ReorgRecoveryStore,
} from "./reorg-recovery.js";
import type { ChainProgressPort } from "../ports/chain-progress.js";
import type { SyncCoordinationPort } from "../ports/sync-coordination.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import {
    processSyncRange,
    type SyncRangeInput,
} from "./sync-range-processing.js";
import {
    SYNC_GAP_POLICY,
    type SyncGapStorePort,
    type SyncGapHeadRecheckPort,
    type SyncGapDetectorPort,
} from "./sync-gap-scheduler.js";
import type { SyncRange } from "./sync.js";
import { observeBestEffort } from "./processing-observability.js";

export type AutomaticSyncRangeReport = {
    kind: SyncWorkCompletion["kind"];
    blocksProcessed: number;
    collectionsProcessed: number;
    toBlock: number;
    durationMs: number;
    completedAtMs: number;
};

export interface AutomaticSyncObserver {
    // Called only after the range's facts, coverage and follow-ups commit.
    rangeCompleted(report: AutomaticSyncRangeReport): void;
}

export const AUTOMATIC_SYNC_POLICY = {
    PollMs: 12_000,
    RetryDelayMs: AUTOMATIC_GAP_WORK_POLICY.RetryDelayMs,
    CollectionBasesPerPass: 64,
} as const;
const LOG_COMPONENT = "AutomaticSyncExecutor";
const LOG_ACTION = { Range: "range", Poll: "poll" } as const;

type AutomaticSyncInput = Omit<
    SyncRangeInput,
    "collections" | "range" | "orderMaintenancePolicy" | "collectionScopeResolver" | "application"
> & {
    commit: SyncRangeCommitPort;
    canonicalChecks: Pick<CanonicalChecksPort, "retain">;
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
    recovery: Pick<RecoverChainReorg, "resumeDue" | "checkDue">;
    progress: ChainProgressPort;
    coordination: SyncCoordinationPort;
    historicalRpc: RpcProviderPort;
    batchSize: number;
    reorgDepth: number;
    retryDelayMs?: number;
    now?: () => number;
    observer?: AutomaticSyncObserver;
};

// One bounded acquisition per pass. SQLite owns intent before and after a crash;
// no broker message, delivery generation or publication reply owns progression.
export class AutomaticSyncExecutor {
    private active: Promise<boolean> | null = null;
    private discoveryHead: { block: number; readAt: number } | null = null;
    private discoveryRevision: number | null = null;
    private resumeHeadCheckPending = true;
    private preferShared = true;
    private readonly now: () => number;
    private readonly retryDelayMs: number;

    constructor(private readonly input: AutomaticSyncInput) {
        this.now = input.now ?? Date.now;
        this.retryDelayMs =
            input.retryDelayMs ?? AUTOMATIC_SYNC_POLICY.RetryDelayMs;
        if (
            !Number.isSafeInteger(input.batchSize) ||
            input.batchSize < 1 ||
            !Number.isSafeInteger(input.reorgDepth) ||
            input.reorgDepth < 1 ||
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
        // Proof, rollback and forward acceptance are serial transitions of this
        // owner. One delayed check per pass cannot starve foreground catch-up.
        const progressed = await this.input.workScope.run(
            SYNC_WORK_CLASS.Main,
            async () => {
                await this.input.recovery.resumeDue();
                const checked = await this.input.recovery.checkDue();
                return (await this.runCurrentState()) || checked;
            },
        );
        if (progressed) return true;
        if (
            !this.input.coordination.canAdvance(this.input.chainId) ||
            this.input.recoveries.getRecovery(this.input.chainId) ||
            !this.input.gapWorkEnabled ||
            !this.input.gapScheduler.hasCollections()
        )
            return false;
        return this.input.workScope.run(SYNC_WORK_CLASS.GapRepair, async () => {
            // Reload retained recovery before background discovery.
            if (
                this.input.recoveries.getRecovery(this.input.chainId)?.phase ===
                REORG_RECOVERY_PHASE.Resync
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
            const revision = this.input.storage.captureSyncCheckpoint(
                this.input.chainId,
            ).revision;
            if (
                this.discoveryRevision !== null &&
                revision !== this.discoveryRevision
            )
                this.input.gapScheduler.resetDiscovery();
            this.discoveryRevision = revision;
            let upperBound = automaticGapUpperBound(
                head,
                this.input.reorgDepth,
            );
            if (upperBound < 1) return false;
            if (this.resumeHeadCheckPending) {
                // Restart-required settings also reenable gap filling here.
                // Complete every bounded collection page before older work.
                if (this.input.gapScheduler.recheckOnResume(upperBound))
                    return true;
                this.resumeHeadCheckPending = false;
            }
            this.input.gapScheduler.recheckFromHead(upperBound);
            if (this.input.gapScheduler.recheckNewlyEligible(upperBound))
                return true;
            const moreToScan = await this.input.gapScheduler.scan(upperBound);
            let pending = this.dueGaps(upperBound);
            if (pending.length && !freshHead) {
                head = await this.readHead();
                upperBound = automaticGapUpperBound(
                    head,
                    this.input.reorgDepth,
                );
                this.input.gapScheduler.recheckFromHead(upperBound);
                if (this.input.gapScheduler.recheckNewlyEligible(upperBound))
                    return true;
                pending = this.dueGaps(upperBound);
            }
            // Manual history may have committed coverage during discovery.
            // Inspect only the next bounded window before RPC.
            const candidates = pending.flatMap((repair) => {
                const candidate = this.input.gaps.reconcileRepairCoverage({
                    chainId: this.input.chainId,
                    repair,
                    batchSize: this.input.batchSize,
                    now: this.now(),
                });
                return candidate ? [candidate] : [];
            });
            // Removing a covered suffix can reveal newer work beyond this
            // bounded page. Reconsider global priority before fetching.
            const newestReady = this.dueGaps(upperBound)[0]?.toBlock;
            const batch = planSyncGapRepairBatches(
                candidates.filter(
                    (candidate) => candidate.repair.toBlock === newestReady,
                ),
                this.input.batchSize,
            )[0];
            return batch
                ? this.runGapRepair(batch)
                : pending.length > 0 || moreToScan;
        });
    }

    private dueGaps(upperBound: number) {
        return this.input.gaps.listDueRepairsAtNewestPendingHeight({
            chainId: this.input.chainId,
            now: this.now(),
            limit: SYNC_GAP_POLICY.CollectionsPerPass,
            upperBound,
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
            await this.process(
                collections,
                batch,
                sources,
                {
                    kind: SYNC_WORK_COMPLETION.GapRepair,
                    batch,
                    retryAt: this.now(),
                },
                { kind: SYNC_APPLICATION_KIND.Historical },
            );
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

    private async runCurrentState(): Promise<boolean> {
        const { chainId, progress, coordination } = this.input;
        let chain = progress.chainProgress(chainId);
        if (!chain) {
            const base = coordination.firstInstalledBase(chainId);
            if (!base) return false;
            const anchor = await this.input.rpc.getBlock(base.blockNumber, {
                fresh: true,
            });
            if (
                anchor.number !== base.blockNumber ||
                anchor.hash !== base.blockHash
            )
                throw new ChainSyncConflict(
                    "Installed ownership base is no longer canonical",
                );
            progress.initializeChain(base.checkpoint, anchor);
            chain = progress.chainProgress(chainId)!;
        }
        if (!coordination.canAdvance(chainId)) return false;
        const bases = coordination.unacceptedCollectionBases(
            chainId,
            this.now(),
            AUTOMATIC_SYNC_POLICY.CollectionBasesPerPass,
        );
        let acceptedBases = 0;
        let verifiedOlderBase = false;
        for (const base of bases) {
            if (!base.acceptedHeader && verifiedOlderBase) continue;
            if (!base.acceptedHeader) verifiedOlderBase = true;
            coordination.recordBaseAttempt(base, this.now(), 0);
            try {
                const anchor =
                    base.acceptedHeader ??
                    (await this.input.rpc.getBlock(base.anchor.number, {
                        fresh: true,
                    }));
                if (
                    anchor.number !== base.anchor.number ||
                    anchor.hash !== base.anchor.hash
                )
                    throw new ChainSyncConflict(
                        "Installed collection base is no longer canonical",
                    );
                progress.acceptCollectionBase(
                    base.checkpoint,
                    base.collectionId,
                    anchor,
                );
                acceptedBases++;
            } catch (error) {
                if (error instanceof StoredBlockHashConflict)
                    this.input.canonicalChecks.retain(error.check, {
                        disputed: true,
                    });
                coordination.recordBaseAttempt(
                    base,
                    this.now(),
                    this.now() +
                        (error instanceof RpcBudgetDeferred
                            ? error.retryAfterMs
                            : this.retryDelayMs),
                );
                if (!(error instanceof RpcBudgetDeferred))
                    this.logFailure(
                        SYNC_WORK_COMPLETION.Unmanaged,
                        {
                            fromBlock: base.anchor.number,
                            toBlock: base.anchor.number,
                        },
                        error,
                    );
            }
        }
        // Base acceptance may have detected a competing retained identity.
        if (!coordination.canAdvance(chainId)) return acceptedBases > 0;

        const recovery = this.input.recoveries.getRecovery(chainId);
        const resync =
            recovery?.phase === REORG_RECOVERY_PHASE.Resync ? recovery : null;
        const target =
            resync?.targetBlock ?? progress.headTarget(chainId)?.blockNumber;
        const sharedReady =
            target !== undefined &&
            target > chain.applied.number &&
            coordination.sharedDue(chainId, this.now()) &&
            (!resync || resync.retryAt <= this.now());
        const scope = coordination.nextCollectionCatchup(chainId, this.now());
        if (!sharedReady && !scope) return acceptedBases > 0;

        let application: SyncApplication;
        let collections: CollectionRecord[];
        let range: SyncRange;
        let completion: SyncWorkCompletion = {
            kind: SYNC_WORK_COMPLETION.Unmanaged,
        };
        if (sharedReady && (this.preferShared || !scope)) {
            application = {
                kind: SYNC_APPLICATION_KIND.Applied,
                chain,
                collections: [],
            };
            collections = [];
            range = {
                fromBlock: chain.applied.number + 1,
                toBlock: Math.min(
                    target!,
                    chain.applied.number + this.input.batchSize,
                ),
            };
            if (resync) {
                if (resync.fromBlock !== range.fromBlock)
                    throw new ChainSyncConflict(
                        "Recovery range is not the next applied prefix",
                    );
                range.toBlock = resync.toBlock;
                completion = {
                    kind: SYNC_WORK_COMPLETION.ReorgResync,
                    range: {
                        chainId,
                        recoveryId: resync.recoveryId,
                        revision: resync.revision,
                        ...range,
                    },
                    batchSize: this.input.batchSize,
                    retryAt: this.now(),
                };
            }
            this.preferShared = false;
        } else {
            if (!scope) return false;
            const collection = this.input.collectionsPort.getCollection(
                chainId,
                scope.collectionId,
            );
            if (!collection) return false;
            application = {
                kind: SYNC_APPLICATION_KIND.Applied,
                chain: null,
                collections: [scope],
            };
            collections = [collection];
            range = {
                fromBlock: scope.applied.number + 1,
                toBlock: Math.min(
                    chain.applied.number,
                    scope.applied.number + this.input.batchSize,
                ),
            };
            this.preferShared = true;
        }
        // Each pass has one bounded range and no speculative future buffer.
        // Failed scopes retain their own retry time, so ready scopes remain selectable.
        coordination.recordAttempt(application, this.now(), 0);
        const scopeId = application.chain
            ? "shared"
            : application.collections[0]!.collectionId;
        const id = `sync:applied:${chainId}:${chain.checkpoint.revision}:${scopeId}:${range.fromBlock}-${range.toBlock}`;
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
                completion,
                application,
            );
            return true;
        } catch (error) {
            const retryAt =
                this.now() +
                (error instanceof RpcBudgetDeferred
                    ? error.retryAfterMs
                    : this.retryDelayMs);
            coordination.recordAttempt(application, this.now(), retryAt);
            if (completion.kind === SYNC_WORK_COMPLETION.ReorgResync)
                this.input.recoveries.deferResync({
                    range: completion.range,
                    retryAt,
                    error: String(error),
                });
            if (!(error instanceof RpcBudgetDeferred))
                this.logFailure(completion.kind, range, error);
            // Reconsider another ready scope without waiting for this retry.
            return true;
        }
    }

    private async process(
        collections: CollectionRecord[],
        range: SyncRange,
        sources: DomainSyncSource[],
        completion: SyncWorkCompletion,
        application: SyncApplication,
    ): Promise<void> {
        const startedAtMs = this.now();
        const result = await processSyncRange({
            rpc:
                application.kind === SYNC_APPLICATION_KIND.Historical
                    ? this.input.historicalRpc
                    : this.input.rpc,
            storage: this.input.storage,
            commit: this.input.commit,
            canonicalChecks: this.input.canonicalChecks,
            collectionExtensions: this.input.collectionExtensions,
            chainId: this.input.chainId,
            reorgDepth: this.input.reorgDepth,
            application,
            wethAddress: this.input.wethAddress,
            collectionScopeResolver: this.input.collectionsPort,
            collections,
            range,
            sources,
            completion,
            mode: "backfill",
            orderMaintenancePolicy:
                application.kind === SYNC_APPLICATION_KIND.Applied
                    ? BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState
                    : BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation,
        });
        const completedAtMs = this.now();
        observeBestEffort(() =>
            this.input.observer?.rangeCompleted({
                kind: completion.kind,
                blocksProcessed: result.blocks.length,
                collectionsProcessed: collections.length,
                toBlock: range.toBlock,
                durationMs: Math.max(0, completedAtMs - startedAtMs),
                completedAtMs,
            }),
        );
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
): { wake(): void; stop(): Promise<void> } {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1)
        throw new Error("Invalid automatic sync polling interval");
    let stopped = false;
    let wakeRequested = false;
    let resume: (() => void) | undefined;
    const active = (async () => {
        while (!stopped) {
            wakeRequested = false;
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
                    busy || wakeRequested ? 0 : pollMs,
                );
                resume = () => {
                    clearTimeout(timer);
                    resume = undefined;
                    resolve();
                };
            });
        }
    })();
    return {
        wake: () => {
            wakeRequested = true;
            resume?.();
        },
        stop: async () => {
            stopped = true;
            resume?.();
            await active;
        },
    };
}
