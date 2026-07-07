import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import {
    COLLECTION_STANDARD,
    COLLECTION_CUSTOMIZATION_SOURCE_KIND,
    COLLECTION_STATUS,
    type CollectionCustomizationSourceKind,
    type ImageCachePolicyFeatureState,
} from "@artgod/shared/types";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    type BootstrapEnumerationMode,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import {
    EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND,
    type CollectionExtensionKey,
    type EmbeddedCollectionExtensionScopeKind,
} from "@artgod/shared/extensions";
import {
    defaultImageCachePolicyConfig,
    normalizeImageCachePolicyConfig,
    type ImageCachePolicyConfig,
} from "@artgod/shared/media/token-image-cache";
import { TOKEN_METADATA_ANIMATION_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-animation-source";
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import {
    BootstrapConflictError,
    BootstrapValidationError,
    type CreateBootstrapRunOutput,
} from "./types.js";
import type {
    BootstrapCommandQueuePort,
    BootstrapRunsWritePort,
    ChainRefResolverPort,
    CollectionBootstrapState,
} from "./ports.js";
import {
    assertCollectionScopeDoesNotOverlap,
    assertImageCacheSourceMatchesExtension,
    resolveRequestedExtensionKey,
    type EmbeddedCollectionExtensionResolverPort,
    type ResolvedBootstrapImageCache,
} from "./create-bootstrap-run.js";
import {
    BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT,
    BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT,
} from "./bootstrap-limits.js";
import { planBootstrapRunSteps } from "./bootstrap-pipeline-planner.js";

const PREPARED_BOOTSTRAP_FAILURE_CODE = {
    StartSchedulingFailed: "start_scheduling_failed",
} as const;

export type StartPreparedCollectionBootstrapInput = {
    chainRef: string;
    collectionRef: string;
};

type PreparedCollectionExtensionResolverPort =
    EmbeddedCollectionExtensionResolverPort & {
        resolveImageCachePolicyConfig(input: {
            chainId: number;
            collectionId?: number;
            extensionKey: CollectionExtensionKey;
        }): ImageCachePolicyConfig | null;
    };

type PreparedBootstrapEnumeration = {
    mode: BootstrapEnumerationMode;
    tokenScopeKind: EmbeddedCollectionExtensionScopeKind;
    scopeStartTokenId: string | null;
    scopeTotalSupply: number | null;
    explicitTokenIds: string[];
    manualTokenIdsJson: string | null;
    manualRangeStartTokenId: string | null;
    manualRangeTotalSupply: number | null;
};

export class StartPreparedCollectionBootstrapUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly openseaIntegration: OpenSeaIntegrationStatus,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly bootstrapRunsPort: BootstrapRunsWritePort,
        private readonly embeddedExtensionResolverPort: PreparedCollectionExtensionResolverPort,
        private readonly collectionCustomizationPort: {
            updateImageCachePolicyState(params: {
                chainId: number;
                collectionId: number;
                selectedSource: CollectionCustomizationSourceKind;
                userConfig: ImageCachePolicyConfig;
            }): ImageCachePolicyFeatureState;
        },
        private readonly bootstrapQueuePort: BootstrapCommandQueuePort,
    ) {}

    async startBootstrap(
        input: StartPreparedCollectionBootstrapInput,
    ): Promise<CreateBootstrapRunOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.bootstrapRunsPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        if (!collection) {
            throw new ReadModelNotFoundError("Unknown collection_ref");
        }
        if (collection.status !== COLLECTION_STATUS.Prepared) {
            throw new BootstrapConflictError(
                "Collection is not prepared for bootstrap",
            );
        }
        if (collection.standard !== COLLECTION_STANDARD.Erc721) {
            throw new BootstrapValidationError("Only ERC-721 is supported");
        }
        if (
            this.bootstrapRunsPort.hasActiveRun(
                chain.publicChainId,
                collection.collectionId,
            )
        ) {
            throw new BootstrapConflictError(
                "Collection already bootstrapping",
            );
        }

        const enumeration = resolvePreparedEnumeration(
            collection,
            this.bootstrapRunsPort,
        );
        const siblingCollections = this.bootstrapRunsPort
            .listCollectionsByAddress(chain.publicChainId, collection.address)
            .filter(
                (sibling) =>
                    sibling.collectionId !== collection.collectionId,
            );
        assertCollectionScopeDoesNotOverlap(
            chain.publicChainId,
            siblingCollections,
            enumeration,
            this.bootstrapRunsPort,
        );

        const requestExtensionKey = resolveRequestedExtensionKey(
            this.embeddedExtensionResolverPort,
            chain.publicChainId,
            collection.address,
            enumeration,
        );
        const requestImageCache = resolvePreparedImageCache({
            collection,
            requestExtensionKey,
            embeddedExtensionResolverPort: this.embeddedExtensionResolverPort,
        });
        assertImageCacheSourceMatchesExtension(
            requestImageCache.selectedSource,
            requestExtensionKey,
        );

        const plannedSteps = planBootstrapRunSteps({
            imageCache: requestImageCache.config,
            openseaSlug: collection.openseaSlug,
            openseaIntegration: this.openseaIntegration,
            requestExtensionKey,
        });
        if (
            requestImageCache.selectedSource ===
            COLLECTION_CUSTOMIZATION_SOURCE_KIND.User
        ) {
            this.collectionCustomizationPort.updateImageCachePolicyState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                selectedSource: requestImageCache.selectedSource,
                userConfig: requestImageCache.config,
            });
        }

        // Persist the prepared status transition and requested run as one unit.
        const run = this.bootstrapRunsPort.createPreparedCollectionRun({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            requestSlug: collection.slug,
            requestOpenseaSlug: collection.openseaSlug,
            requestAddress: collection.address,
            requestStandard: collection.standard,
            imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
            animationSourceField: TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl,
            requestExtensionKey,
            metadataMode: BOOTSTRAP_METADATA_MODE.BestEffort,
            enumerationMode: enumeration.mode,
            manualTokenIdsJson: enumeration.manualTokenIdsJson,
            manualRangeStartTokenId: enumeration.manualRangeStartTokenId,
            manualRangeTotalSupply: enumeration.manualRangeTotalSupply,
            imageCacheMode: requestImageCache.config.imageCacheMode,
            imageCacheMaxDimension: requestImageCache.config.maxDimension,
            deploymentBlock: collection.deploymentBlock,
            steps: plannedSteps,
            requestedEvent: {
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunRequested,
                eventLevel: "info",
                message: "Bootstrap run requested",
                payloadJson: null,
            },
        });

        try {
            this.bootstrapRunsPort.updateRunStatus(
                run.runId,
                BOOTSTRAP_RUN_STATUS.Queued,
            );
            this.bootstrapRunsPort.appendRunEvent({
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunQueued,
                eventLevel: "info",
                message: "Bootstrap run queued",
                payloadJson: null,
            });
            await this.bootstrapQueuePort.publishBootstrapStart({
                chainId: run.chainId,
                runId: run.runId,
                collectionId: run.collectionId,
            });
        } catch (cause) {
            this.bootstrapRunsPort.abortPreparedCollectionRun({
                chainId: run.chainId,
                collectionId: run.collectionId,
                runId: run.runId,
                error: {
                    code: PREPARED_BOOTSTRAP_FAILURE_CODE.StartSchedulingFailed,
                    message: String(cause),
                },
                event: {
                    eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunFailed,
                    eventLevel: "error",
                    message: "Bootstrap run start scheduling failed",
                    payloadJson: null,
                },
            });
            throw cause;
        }

        const queued = this.bootstrapRunsPort.getLatestRun(
            run.chainId,
            run.collectionId,
        );
        return {
            runId: run.runId,
            collectionId: run.collectionId,
            status: queued?.status ?? BOOTSTRAP_RUN_STATUS.Queued,
            createdAt: queued?.createdAt ?? run.createdAt,
        };
    }
}

function resolvePreparedEnumeration(
    collection: CollectionBootstrapState,
    bootstrapRunsPort: Pick<
        BootstrapRunsWritePort,
        "listCollectionScopeTokenIds"
    >,
): PreparedBootstrapEnumeration {
    if (
        collection.tokenScopeKind ===
        EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens
    ) {
        return {
            mode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
            tokenScopeKind: collection.tokenScopeKind,
            scopeStartTokenId: null,
            scopeTotalSupply: null,
            explicitTokenIds: [],
            manualTokenIdsJson: null,
            manualRangeStartTokenId: null,
            manualRangeTotalSupply: null,
        };
    }

    if (
        collection.tokenScopeKind ===
        EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.TokenRange
    ) {
        if (
            collection.scopeStartTokenId === null ||
            collection.scopeTotalSupply === null
        ) {
            throw new BootstrapValidationError(
                "Prepared token range requires start token and supply",
            );
        }
        if (
            collection.scopeTotalSupply >
            BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT
        ) {
            throw new BootstrapValidationError(
                "Prepared token range supply is too large",
            );
        }
        return {
            mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
            tokenScopeKind: collection.tokenScopeKind,
            scopeStartTokenId: collection.scopeStartTokenId,
            scopeTotalSupply: collection.scopeTotalSupply,
            explicitTokenIds: [],
            manualTokenIdsJson: null,
            manualRangeStartTokenId: collection.scopeStartTokenId,
            manualRangeTotalSupply: collection.scopeTotalSupply,
        };
    }

    const explicitTokenIds = bootstrapRunsPort.listCollectionScopeTokenIds(
        collection.chainId,
        collection.collectionId,
    );
    if (explicitTokenIds.length === 0) {
        throw new BootstrapValidationError(
            "Prepared explicit token scope cannot be empty",
        );
    }
    if (explicitTokenIds.length > BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT) {
        throw new BootstrapValidationError(
            "Prepared explicit token scope is too large",
        );
    }
    return {
        mode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
        tokenScopeKind:
            EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.ExplicitTokenIds,
        scopeStartTokenId: null,
        scopeTotalSupply: null,
        explicitTokenIds,
        manualTokenIdsJson: JSON.stringify(explicitTokenIds),
        manualRangeStartTokenId: null,
        manualRangeTotalSupply: null,
    };
}

function resolvePreparedImageCache(input: {
    collection: CollectionBootstrapState;
    requestExtensionKey: CollectionExtensionKey | null;
    embeddedExtensionResolverPort: PreparedCollectionExtensionResolverPort;
}): ResolvedBootstrapImageCache {
    if (!input.requestExtensionKey) {
        return {
            selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
            config: defaultImageCachePolicyConfig(),
        };
    }

    const extensionConfig =
        input.embeddedExtensionResolverPort.resolveImageCachePolicyConfig({
            chainId: input.collection.chainId,
            collectionId: input.collection.collectionId,
            extensionKey: input.requestExtensionKey,
        });
    if (!extensionConfig) {
        return {
            selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
            config: defaultImageCachePolicyConfig(),
        };
    }

    return {
        selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension,
        config: normalizeImageCachePolicyConfig(extensionConfig),
    };
}
