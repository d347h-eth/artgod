import {
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type ChainRecord,
    type CollectionListItem,
    type PersistedBiddingJobRecord,
    type PersistedCollectionBiddingJobRecord,
    type TradingCompetitionPreset,
    type TradingCompetitionPresetReapplySelection,
    type TradingCompetitionPresetVersion,
    type TradingJobCommandRecord,
} from "@artgod/shared/types";
import {
    assertCompetitionPresetSelection,
    TraitCompetitionValidationError,
} from "@artgod/shared/trading/trait-competition";
import type {
    CompetitionPresetScope,
    CompetitionPresetsInput,
} from "./bidding-competition-presets.js";
import {
    assertMarketplaceBiddingSupportedTargetTraits,
    type TraitBiddingTargetSupportReadPort,
} from "./trait-bidding-target.js";
import type { TradingJobCommandSignalPort } from "./trading-job-command-signal-port.js";
import {
    mapPersistedBiddingJobToView,
    TradingValidationError,
    type BiddingJobView,
} from "./types.js";

export type CompetitionPresetReapplyInput = CompetitionPresetsInput & {
    presetId: string;
};
export type ApplyCompetitionPresetReapplyInput =
    CompetitionPresetReapplyInput & {
        expectedRevision: number;
        jobs: TradingCompetitionPresetReapplySelection[];
    };
export type CompetitionPresetReapplyJobPreview = {
    job: BiddingJobView;
    before: TradingCompetitionPresetVersion;
    after: TradingCompetitionPresetVersion;
    changed: boolean;
    error: string | null;
};
export type CompetitionPresetReapplyPreview = {
    chain: ChainRecord;
    collection: CollectionListItem;
    preset: TradingCompetitionPreset;
    jobs: CompetitionPresetReapplyJobPreview[];
};
export type ApplyCompetitionPresetReapplyOutput = Omit<
    CompetitionPresetReapplyPreview,
    "jobs"
> & {
    jobs: BiddingJobView[];
};
export type ReapplyCompetitionPresetWriteInput = CompetitionPresetScope & {
    presetId: string;
    expectedRevision: number;
    jobs: TradingCompetitionPresetReapplySelection[];
    // Synchronous read-only guard, called with each reread job while holding
    // the writer lock. It must be safe to repeat after a transaction retry.
    assertTargetSupported: (job: PersistedCollectionBiddingJobRecord) => void;
};
export interface CompetitionPresetReapplyJobsPort {
    listCompetitionPresetJobs(
        input: CompetitionPresetScope & { presetId: string },
    ): PersistedCollectionBiddingJobRecord[];
    getJobById(jobId: string): PersistedBiddingJobRecord | null;
    // Recheck preset and selected job snapshots, including current target
    // support, inside one transaction. Preserve the rest of each declaration.
    reapplyCompetitionPreset(input: ReapplyCompetitionPresetWriteInput): {
        jobs: PersistedCollectionBiddingJobRecord[];
        commands: TradingJobCommandRecord[];
    };
}
export interface CompetitionPresetReapplyReadPort {
    getPreset(
        scope: CompetitionPresetScope,
        presetId: string,
    ): TradingCompetitionPreset | null;
}

export function requireReapplyCompetitionPreset(
    preset: TradingCompetitionPreset | null,
    expectedRevision?: number,
): TradingCompetitionPreset {
    if (!preset || preset.archivedAt !== null)
        throw new TradingValidationError(
            "Extra targets preset is unavailable. Refresh the presets.",
        );
    if (expectedRevision !== undefined && preset.revision !== expectedRevision)
        throw new TradingValidationError(
            "Extra targets preset changed. Preview reapply again.",
        );
    return preset;
}

// Shared by orchestration and the transactional writer, so stale or foreign
// selections cannot be applied even if they changed after the initial checks.
export function requireReapplyCompetitionPresetJob(
    job: PersistedBiddingJobRecord | null,
    scope: CompetitionPresetScope,
    preset: TradingCompetitionPreset,
    selection?: TradingCompetitionPresetReapplySelection,
): PersistedCollectionBiddingJobRecord & {
    status:
        | typeof TRADING_JOB_STATUS.Enabled
        | typeof TRADING_JOB_STATUS.Paused;
} {
    if (
        !job ||
        job.chainId !== scope.chainId ||
        job.collectionId !== scope.collectionId ||
        job.targetKind !== TRADING_JOB_TARGET_KIND.Collection ||
        job.status === TRADING_JOB_STATUS.Archived ||
        job.competitionPreset?.presetId !== preset.presetId
    )
        throw new TradingValidationError(
            "Selected jobs are no longer linked to this preset. Preview reapply again.",
        );
    if (
        selection &&
        (job.revision !== selection.expectedRevision ||
            job.competitionPreset.versionId !== selection.versionId ||
            job.competitionPreset.versionId === preset.versionId)
    )
        throw new TradingValidationError(
            "Selected jobs changed. Preview reapply again.",
        );
    try {
        assertCompetitionPresetSelection(
            { ...preset, currentRevision: preset.revision },
            job.targetTraits,
            false,
        );
    } catch (error) {
        if (error instanceof TraitCompetitionValidationError)
            throw new TradingValidationError(error.message);
        throw error;
    }
    return job as PersistedCollectionBiddingJobRecord & {
        status:
            | typeof TRADING_JOB_STATUS.Enabled
            | typeof TRADING_JOB_STATUS.Paused;
    };
}

export class BiddingCompetitionPresetReapplyUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chains: {
            resolveChainRef(
                ref: string | undefined,
                defaultChainId: number,
            ): ChainRecord;
        },
        readonly collections: {
            resolveCollectionRef(
                chainId: number,
                ref: string,
            ): CollectionListItem;
        },
        readonly presets: CompetitionPresetReapplyReadPort,
        readonly jobs: CompetitionPresetReapplyJobsPort,
        readonly targets: TraitBiddingTargetSupportReadPort,
        readonly signals: TradingJobCommandSignalPort,
    ) {}

    previewCompetitionPresetReapply(
        input: CompetitionPresetReapplyInput,
    ): CompetitionPresetReapplyPreview {
        const { chain, collection, scope } = this.resolveScope(input);
        const preset = requireReapplyCompetitionPreset(
            this.presets.getPreset(scope, input.presetId),
        );
        const jobs = this.jobs
            .listCompetitionPresetJobs({ ...scope, presetId: preset.presetId })
            .map((job) => {
                let error: string | null = null;
                try {
                    this.assertEligibleJob(job, scope, preset);
                } catch (cause) {
                    if (!(cause instanceof TradingValidationError)) throw cause;
                    error = cause.message;
                }
                // The read port returns only jobs with a pinned version of this preset.
                const before = job.competitionPreset!;
                return {
                    job: mapPersistedBiddingJobToView(job),
                    before,
                    after: preset,
                    changed: before.versionId !== preset.versionId,
                    error,
                };
            });
        return { chain, collection, preset, jobs };
    }

    applyCompetitionPresetReapply(
        input: ApplyCompetitionPresetReapplyInput,
    ): ApplyCompetitionPresetReapplyOutput {
        if (
            !Number.isSafeInteger(input.expectedRevision) ||
            input.expectedRevision < 1
        )
            throw new TradingValidationError(
                "expectedRevision must be a positive integer",
            );
        if (
            !input.jobs.length ||
            new Set(input.jobs.map((job) => job.jobId)).size !==
                input.jobs.length
        )
            throw new TradingValidationError(
                "Choose distinct jobs to reapply.",
            );
        const { chain, collection, scope } = this.resolveScope(input);
        const preset = requireReapplyCompetitionPreset(
            this.presets.getPreset(scope, input.presetId),
            input.expectedRevision,
        );
        for (const selection of input.jobs) {
            if (
                !selection.jobId.trim() ||
                !selection.versionId.trim() ||
                !Number.isSafeInteger(selection.expectedRevision) ||
                selection.expectedRevision < 1
            )
                throw new TradingValidationError(
                    "Each selected job needs its reviewed revision and preset version.",
                );
            this.assertEligibleJob(
                this.jobs.getJobById(selection.jobId),
                scope,
                preset,
                selection,
            );
        }
        const result = this.jobs.reapplyCompetitionPreset({
            ...scope,
            presetId: preset.presetId,
            expectedRevision: input.expectedRevision,
            jobs: input.jobs,
            assertTargetSupported: (job) =>
                this.assertTargetSupported(job, scope),
        });
        this.signals.publishBiddingJobCommandsChanged(result.commands);
        return {
            chain,
            collection,
            preset,
            jobs: result.jobs.map(mapPersistedBiddingJobToView),
        };
    }

    private assertEligibleJob(
        job: PersistedBiddingJobRecord | null,
        scope: CompetitionPresetScope,
        preset: TradingCompetitionPreset,
        selection?: TradingCompetitionPresetReapplySelection,
    ): void {
        const eligible = requireReapplyCompetitionPresetJob(
            job,
            scope,
            preset,
            selection,
        );
        this.assertTargetSupported(eligible, scope);
    }

    private assertTargetSupported(
        job: PersistedCollectionBiddingJobRecord,
        scope: CompetitionPresetScope,
    ): void {
        assertMarketplaceBiddingSupportedTargetTraits({
            ...scope,
            targetTraits: job.targetTraits,
            traitBiddingTargetSupportReadPort: this.targets,
        });
    }

    private resolveScope(input: CompetitionPresetsInput) {
        const chain = this.chains.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.collections.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        return {
            chain,
            collection,
            scope: {
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
            },
        };
    }
}
