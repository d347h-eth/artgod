import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import {
    OPENSEA_COLLECTION_SLUG_PROBE_STATUS,
    type OpenSeaCollectionSlugProbeStatus,
} from "@artgod/shared/opensea/collection-slug-probe";
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
    verificationTokenIds: readonly string[];
};

export type ProbeCollectionOpenSeaSlugInput = {
    chainRef: string;
    collectionRef: string;
    slug?: string;
};

export type ProbeCollectionOpenSeaSlugOutput = {
    chain: ChainRecord;
    address: string;
    requestedSlug: string | null;
    status: OpenSeaCollectionSlugProbeStatus;
    slug: string | null;
    reason: string | null;
};

export type StartOpenSeaCollectionSyncOutput = {
    chain: ChainRecord;
    collection: Omit<OpenSeaCollectionSyncState, "verificationTokenIds">;
    openseaStatus: OpenSeaCollectionStatus;
};

type MaybePromise<T> = T | Promise<T>;

// Outbound lookup boundary for verifying OpenSea collection identity before sync.
export interface OpenSeaCollectionSyncSlugProbePort {
    resolveVerifiedSlug(input: {
        address: string | null;
        requestedSlug: string | null;
        verificationTokenIds: readonly string[];
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
        const { chain, collection } = this.resolveCollection(
            input.chainRef,
            input.collectionRef,
        );
        assertOpenSeaSyncBaseCanStart(collection, this.openseaIntegration);
        const openseaSlug = await this.resolveSyncOpenSeaSlug(
            collection,
            input.openseaSlug,
        );

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
                collection: withoutVerificationTokenIds(pending),
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

    async probeSlug(
        input: ProbeCollectionOpenSeaSlugInput,
    ): Promise<ProbeCollectionOpenSeaSlugOutput> {
        const { chain, collection } = this.resolveCollection(
            input.chainRef,
            input.collectionRef,
        );
        const requestedSlug = normalizeOptionalOpenSeaSlug(input.slug);
        if (!this.openseaIntegration.enabled) {
            return {
                chain,
                address: collection.address,
                requestedSlug,
                status: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Disabled,
                slug: null,
                reason:
                    this.openseaIntegration.reason ??
                    "OpenSea integration is disabled",
            };
        }
        assertOpenSeaSyncCollectionCanStart(collection);

        const slug = await this.resolveVerifiedOpenSeaSlug(
            collection,
            requestedSlug,
        );
        if (!slug) {
            return {
                chain,
                address: collection.address,
                requestedSlug,
                status: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Missing,
                slug: null,
                reason: requestedSlug
                    ? "Check this collection's OpenSea slug, then resolve again"
                    : "Enter this collection's OpenSea slug, then select resolve",
            };
        }
        return {
            chain,
            address: collection.address,
            requestedSlug,
            status: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Found,
            slug,
            reason: null,
        };
    }

    private resolveCollection(
        chainRef: string,
        collectionRef: string,
    ): {
        chain: ChainRecord;
        collection: OpenSeaCollectionSyncState;
    } {
        const chain = this.chainRefResolverPort.resolveChainRef(
            chainRef,
            this.defaultChainId,
        );
        const collection = this.collectionSyncPort.resolveCollectionRef(
            chain.publicChainId,
            collectionRef,
        );
        if (!collection) {
            throw new ReadModelNotFoundError("Unknown collection_ref");
        }
        return { chain, collection };
    }

    private async resolveSyncOpenSeaSlug(
        collection: OpenSeaCollectionSyncState,
        inputSlug: string,
    ): Promise<string> {
        const requestedSlug = normalizeOpenSeaSlug(inputSlug);
        const resolvedSlug = await this.resolveVerifiedOpenSeaSlug(
            collection,
            requestedSlug,
        );
        if (!resolvedSlug) {
            throw new BootstrapValidationError(
                "OpenSea could not verify this collection slug; resolve it again",
            );
        }
        return resolvedSlug;
    }

    private async resolveVerifiedOpenSeaSlug(
        collection: OpenSeaCollectionSyncState,
        requestedSlug: string | null,
    ): Promise<string | null> {
        if (!this.openSeaCollectionSyncSlugProbePort) {
            throw new Error("OpenSea slug probe client is not configured");
        }

        // Verify contract membership and representative token boundaries before persistence.
        const resolvedSlug =
            await this.openSeaCollectionSyncSlugProbePort.resolveVerifiedSlug({
                address: collection.address,
                requestedSlug,
                verificationTokenIds: collection.verificationTokenIds,
            });
        if (
            !resolvedSlug ||
            (requestedSlug !== null && resolvedSlug !== requestedSlug)
        ) {
            return null;
        }
        const owner = this.collectionSyncPort.resolveOpenSeaSlugOwner(
            collection.chainId,
            resolvedSlug,
        );
        if (owner && owner.collectionId !== collection.collectionId) {
            throw new BootstrapConflictError(
                "OpenSea slug is already assigned to another collection",
            );
        }
        return resolvedSlug;
    }
}

function assertOpenSeaSyncBaseCanStart(
    collection: OpenSeaCollectionSyncState,
    openseaIntegration: OpenSeaIntegrationStatus,
): void {
    assertOpenSeaSyncCollectionCanStart(collection);
    if (!openseaIntegration.enabled) {
        throw new BootstrapValidationError(
            openseaIntegration.reason ?? "OpenSea integration is disabled",
        );
    }
}

function assertOpenSeaSyncCollectionCanStart(
    collection: OpenSeaCollectionSyncState,
): void {
    if (collection.status !== COLLECTION_STATUS.Live) {
        throw new BootstrapConflictError(
            "Collection must be live before OpenSea sync can start",
        );
    }
    if (collection.openseaStatus === OPENSEA_COLLECTION_STATUS.Ready) {
        throw new BootstrapConflictError("Collection is already OpenSea ready");
    }
    if (isOpenSeaCollectionSyncActive(collection.openseaStatus)) {
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

function normalizeOptionalOpenSeaSlug(
    value: string | undefined,
): string | null {
    if (value === undefined || !value.trim()) return null;
    return normalizeOpenSeaSlug(value);
}

function withoutVerificationTokenIds(
    collection: OpenSeaCollectionSyncState,
): Omit<OpenSeaCollectionSyncState, "verificationTokenIds"> {
    const { verificationTokenIds: _verificationTokenIds, ...output } =
        collection;
    return output;
}
