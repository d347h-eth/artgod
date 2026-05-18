import type { ChainRecord } from "@artgod/shared/types/browse";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import { SYNC_BACKFILL_CONTEXT_ANY } from "@artgod/shared/config/sync-backfill";
import type {
    SyncBackfillCollectionOption,
    SyncBackfillReadPort,
} from "./get-sync-backfill-state.js";

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

        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collections = this.syncBackfillReadPort.listLiveCollections(
            chain.publicChainId,
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

        await this.syncBackfillCommandQueuePort.publishBackfillRanges(commands);

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
