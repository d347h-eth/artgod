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
    openseaSlug: string;
};

export type OpenSeaCollectionSyncState = {
    chainId: number;
    collectionId: number;
    slug: string;
    address: string;
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

// Outbound lookup boundary for verifying OpenSea collection identity before sync.
export interface OpenSeaCollectionSyncSlugProbePort {
    resolveCollectionSlugByContract(input: {
        address: string;
    }): Promise<string | null>;
}

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
            resolveOpenSeaSlugOwner(
                chainId: number,
                openseaSlug: string,
            ): { collectionId: number } | null;
            markOpenSeaPending(input: {
                chainId: number;
                collectionId: number;
                openseaSlug: string;
            }): OpenSeaCollectionSyncState | null;
            restoreOpenSeaState(input: {
                chainId: number;
                collectionId: number;
                openseaSlug: string | null;
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
        private readonly openSeaCollectionSyncSlugProbePort: OpenSeaCollectionSyncSlugProbePort | null,
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
        assertOpenSeaSyncBaseCanStart(collection, this.openseaIntegration);
        const openseaSlug = await this.resolveSyncOpenSeaSlug(collection, input.openseaSlug);

        let pending: OpenSeaCollectionSyncState | null = null;
        try {
            // Store the verified slug and mark the collection pending before the worker claims the job.
            pending = this.collectionSyncPort.markOpenSeaPending({
                chainId: collection.chainId,
                collectionId: collection.collectionId,
                openseaSlug,
            });
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
                    openseaSlug: collection.openseaSlug,
                    openseaStatus: collection.openseaStatus,
                    openseaLastError: collection.openseaLastError,
                });
            }
            throw cause;
        }
    }

    private async resolveSyncOpenSeaSlug(
        collection: OpenSeaCollectionSyncState,
        inputSlug: string,
    ): Promise<string> {
        const requestedSlug = normalizeOpenSeaSlug(inputSlug);
        const owner = this.collectionSyncPort.resolveOpenSeaSlugOwner(
            collection.chainId,
            requestedSlug,
        );
        if (owner && owner.collectionId !== collection.collectionId) {
            throw new BootstrapConflictError(
                "OpenSea slug is already assigned to another collection",
            );
        }
        if (!this.openSeaCollectionSyncSlugProbePort) {
            throw new Error("OpenSea slug probe client is not configured");
        }

        // Confirm the submitted slug is the OpenSea slug for this collection contract.
        const resolvedSlug =
            await this.openSeaCollectionSyncSlugProbePort.resolveCollectionSlugByContract(
                {
                    address: collection.address,
                },
            );
        if (resolvedSlug !== requestedSlug) {
            throw new BootstrapValidationError(
                "OpenSea did not confirm this collection slug for this contract",
            );
        }
        return requestedSlug;
    }
}

function assertOpenSeaSyncBaseCanStart(
    collection: OpenSeaCollectionSyncState,
    openseaIntegration: OpenSeaIntegrationStatus,
): void {
    if (collection.status !== COLLECTION_STATUS.Live) {
        throw new BootstrapConflictError(
            "Collection must be live before OpenSea sync can start",
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

function normalizeOpenSeaSlug(value: string): string {
    const slug = value.trim().toLowerCase();
    if (!slug) {
        throw new BootstrapValidationError("Invalid OpenSea slug");
    }
    return slug;
}
