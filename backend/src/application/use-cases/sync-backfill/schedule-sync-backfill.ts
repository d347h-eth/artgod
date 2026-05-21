import type { ChainRecord } from "@artgod/shared/types/browse";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import { SYNC_BACKFILL_CONTEXT_ANY } from "@artgod/shared/config/sync-backfill";
import {
    NOOP_APM,
    type ApmPort,
} from "@artgod/shared/observability/apm";
import type {
    SyncBackfillCollectionOption,
    SyncBackfillReadPort,
} from "./get-sync-backfill-state.js";
import {
    SYNC_BACKFILL_SPAN_ATTRIBUTE,
    syncBackfillRangeSpanAttributes,
} from "./sync-backfill-observability.js";

export type ScheduleSyncBackfillInput = {
    chainRef: string;
    collectionRef?: string | null;
    fromBlock: number;
    toBlock: number;
};

export type ScheduleSyncBackfillOutput = {
    chain: ChainRecord;
    collection: {
        collectionId: number;
        slug: string;
    } | null;
    fromBlock: number;
    toBlock: number;
    queuedJobs: number;
};

export type SyncBackfillRangeCommand = {
    chainId: number;
    collectionId: number | null;
    fromBlock: number;
    toBlock: number;
};

type ChainRefResolverPort = {
    resolveChainRef(
        chainRef: string | undefined,
        defaultPublicChainId: number,
    ): ChainRecord;
};

type SyncBackfillCommandQueuePort = {
    publishBackfillRanges(commands: SyncBackfillRangeCommand[]): Promise<void>;
};

export class ScheduleSyncBackfillUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly backfillBatchSize: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly syncBackfillReadPort: Pick<
            SyncBackfillReadPort,
            "listLiveCollections"
        >,
        private readonly syncBackfillCommandQueuePort: SyncBackfillCommandQueuePort,
        private readonly apm: ApmPort = NOOP_APM,
    ) {}

    async scheduleBackfill(
        input: ScheduleSyncBackfillInput,
    ): Promise<ScheduleSyncBackfillOutput> {
        assertBlockNumber(input.fromBlock, "fromBlock");
        assertBlockNumber(input.toBlock, "toBlock");
        if (input.fromBlock > input.toBlock) {
            throw new ReadModelBadRequestError(
                "fromBlock must be <= toBlock",
            );
        }

        const requestAttributes = {
            ...syncBackfillRangeSpanAttributes(input),
            [SYNC_BACKFILL_SPAN_ATTRIBUTE.CollectionRefPresent]: Boolean(
                input.collectionRef?.trim(),
            ),
        };
        // Resolve the requested chain before publishing chain-scoped backfill jobs.
        const chain = this.apm.withSyncSpan(
            "backend.sync_backfill.schedule.chain",
            requestAttributes,
            () =>
                this.chainRefResolverPort.resolveChainRef(
                    input.chainRef,
                    this.defaultChainId,
                ),
        );
        const chainAttributes = {
            ...requestAttributes,
            [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chain.publicChainId,
        };
        // Load live collections to validate optional collection-scoped backfill.
        const collections = this.apm.withSyncSpan(
            "backend.sync_backfill.schedule.live_collections",
            chainAttributes,
            () =>
                this.syncBackfillReadPort.listLiveCollections(
                    chain.publicChainId,
                ),
        );
        const collection = resolveBackfillCollection(
            input.collectionRef,
            collections,
        );
        const commands = buildBackfillCommands({
            chainId: chain.publicChainId,
            collectionId: collection?.collectionId ?? null,
            fromBlock: input.fromBlock,
            toBlock: input.toBlock,
            batchSize: this.backfillBatchSize,
        });

        // Publish range commands through the configured sync/backfill queue adapter.
        await this.apm.withSpan(
            "backend.sync_backfill.schedule.publish_ranges",
            {
                ...chainAttributes,
                ...(collection
                    ? {
                          [SYNC_BACKFILL_SPAN_ATTRIBUTE.CollectionId]:
                              collection.collectionId,
                      }
                    : {}),
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.CommandsCount]: commands.length,
            },
            () =>
                this.syncBackfillCommandQueuePort.publishBackfillRanges(
                    commands,
                ),
        );

        return {
            chain,
            collection: collection
                ? {
                      collectionId: collection.collectionId,
                      slug: collection.slug,
                  }
                : null,
            fromBlock: input.fromBlock,
            toBlock: input.toBlock,
            queuedJobs: commands.length,
        };
    }
}

function resolveBackfillCollection(
    collectionRef: string | null | undefined,
    collections: SyncBackfillCollectionOption[],
): SyncBackfillCollectionOption | null {
    const normalized =
        collectionRef && collectionRef.trim()
            ? normalizeSlugRef(collectionRef)
            : SYNC_BACKFILL_CONTEXT_ANY;
    if (normalized === SYNC_BACKFILL_CONTEXT_ANY) {
        return null;
    }

    const collection = collections.find(
        (candidate) => candidate.slug === normalized,
    );
    if (!collection) {
        throw new ReadModelNotFoundError("Unknown live collection");
    }
    return collection;
}

function buildBackfillCommands(input: {
    chainId: number;
    collectionId: number | null;
    fromBlock: number;
    toBlock: number;
    batchSize: number;
}): SyncBackfillRangeCommand[] {
    const size = Math.max(1, input.batchSize);
    const commands: SyncBackfillRangeCommand[] = [];
    for (let start = input.fromBlock; start <= input.toBlock; start += size) {
        commands.push({
            chainId: input.chainId,
            collectionId: input.collectionId,
            fromBlock: start,
            toBlock: Math.min(input.toBlock, start + size - 1),
        });
    }
    return commands;
}

function assertBlockNumber(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 0) {
        throw new ReadModelBadRequestError(`${field} must be a block number`);
    }
}
