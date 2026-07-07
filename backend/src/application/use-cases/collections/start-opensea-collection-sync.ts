import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import {
    COLLECTION_STATUS,
    OPENSEA_COLLECTION_STATUS,
    isOpenSeaCollectionSyncActive,
    type ChainRecord,
    type CollectionStatus,
    type OpenSeaCollectionStatus,
} from "@artgod/shared/types";
import {
    BootstrapConflictError,
    BootstrapValidationError,
} from "../bootstrap/types.js";

export type StartOpenSeaCollectionSyncInput = {
    chainRef: string;
    collectionRef: string;
};

export type OpenSeaCollectionSyncState = {
    chainId: number;
    collectionId: number;
    slug: string;
    status: CollectionStatus;
    openseaSlug: string | null;
    openseaStatus: OpenSeaCollectionStatus | null;
    openseaLastError: string | null;
};

export type StartOpenSeaCollectionSyncOutput = {
    chain: ChainRecord;
    collection: OpenSeaCollectionSyncState;
    openseaStatus: OpenSeaCollectionStatus;
};

type MaybePromise<T> = T | Promise<T>;

export class StartOpenSeaCollectionSyncUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly openseaIntegration: OpenSeaIntegrationStatus,
        private readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        private readonly collectionSyncPort: {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): OpenSeaCollectionSyncState | null;
            markOpenSeaPending(
                chainId: number,
                collectionId: number,
            ): OpenSeaCollectionSyncState | null;
            restoreOpenSeaState(input: {
                chainId: number;
                collectionId: number;
                openseaStatus: OpenSeaCollectionStatus | null;
                openseaLastError: string | null;
            }): OpenSeaCollectionSyncState | null;
        },
        private readonly openSeaSyncQueuePort: {
            publishOpenSeaBootstrap(input: {
                chainId: number;
                collectionId: number;
            }): MaybePromise<void>;
        },
    ) {}

    async startSync(
        input: StartOpenSeaCollectionSyncInput,
    ): Promise<StartOpenSeaCollectionSyncOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.collectionSyncPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        if (!collection) {
            throw new ReadModelNotFoundError("Unknown collection_ref");
        }
        assertOpenSeaSyncCanStart(collection, this.openseaIntegration);

        let pending: OpenSeaCollectionSyncState | null = null;
        try {
            // Mark the collection pending before the worker claims the sync job.
            pending = this.collectionSyncPort.markOpenSeaPending(
                collection.chainId,
                collection.collectionId,
            );
            if (!pending) {
                throw new ReadModelNotFoundError("Unknown collection_ref");
            }

            // Publish an OpenSea bootstrap job without historical bootstrap-run coupling.
            await this.openSeaSyncQueuePort.publishOpenSeaBootstrap({
                chainId: pending.chainId,
                collectionId: pending.collectionId,
            });
            return {
                chain,
                collection: pending,
                openseaStatus:
                    pending.openseaStatus ?? OPENSEA_COLLECTION_STATUS.Pending,
            };
        } catch (cause) {
            if (pending) {
                this.collectionSyncPort.restoreOpenSeaState({
                    chainId: collection.chainId,
                    collectionId: collection.collectionId,
                    openseaStatus: collection.openseaStatus,
                    openseaLastError: collection.openseaLastError,
                });
            }
            throw cause;
        }
    }
}

function assertOpenSeaSyncCanStart(
    collection: OpenSeaCollectionSyncState,
    openseaIntegration: OpenSeaIntegrationStatus,
): void {
    if (collection.status !== COLLECTION_STATUS.Live) {
        throw new BootstrapConflictError(
            "Collection must be live before OpenSea sync can start",
        );
    }
    if (!collection.openseaSlug) {
        throw new BootstrapValidationError(
            "Collection has no OpenSea slug configured",
        );
    }
    if (!openseaIntegration.enabled) {
        throw new BootstrapValidationError(
            openseaIntegration.reason ?? "OpenSea integration is disabled",
        );
    }
    if (collection.openseaStatus === OPENSEA_COLLECTION_STATUS.Ready) {
        throw new BootstrapConflictError("Collection is already OpenSea ready");
    }
    if (
        isOpenSeaCollectionSyncActive(collection.openseaStatus)
    ) {
        throw new BootstrapConflictError(
            "Collection OpenSea sync is already running",
        );
    }
}
