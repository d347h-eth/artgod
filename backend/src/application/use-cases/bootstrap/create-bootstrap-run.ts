import {
    BootstrapConflictError,
    BootstrapValidationError,
    type CreateBootstrapRunInput,
    type CreateBootstrapRunOutput,
} from "./types.js";
import {
    EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND,
    type CollectionExtensionKey,
    type EmbeddedCollectionExtensionScope,
} from "@artgod/shared/extensions";
import {
    COLLECTION_CUSTOMIZATION_SOURCE_KIND,
    type CollectionCustomization,
} from "@artgod/shared/types";
import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import type {
    BootstrapCommandQueuePort,
    BootstrapRunsWritePort,
    ChainRefResolverPort,
} from "./ports.js";
import {
    BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT,
    BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT,
} from "./bootstrap-limits.js";
import {
    IMAGE_CACHE_MODE,
    defaultImageCachePolicyConfig,
    normalizeImageCachePolicyConfig,
    type ImageCachePolicyConfig,
} from "@artgod/shared/media/token-image-cache";

export type EmbeddedCollectionExtensionResolveInput = {
    chainId: number;
    contractAddress: string;
    scope: EmbeddedCollectionExtensionScope;
};

export interface EmbeddedCollectionExtensionResolverPort {
    resolveExtensionKey(
        input: EmbeddedCollectionExtensionResolveInput,
    ): CollectionExtensionKey | null;
    resolveImageCachePolicyConfig(input: {
        chainId: number;
        collectionId: number;
        extensionKey: CollectionExtensionKey;
    }): ImageCachePolicyConfig | null;
}

export class CreateBootstrapRunUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly openseaIntegration: OpenSeaIntegrationStatus,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly bootstrapRunsPort: BootstrapRunsWritePort,
        private readonly embeddedExtensionResolverPort: EmbeddedCollectionExtensionResolverPort,
        private readonly collectionCustomizationPort: {
            updateImageCachePolicyState(params: {
                chainId: number;
                collectionId: number;
                selectedSource: CollectionCustomization["imageCachePolicy"]["selectedSource"];
                userConfig: ImageCachePolicyConfig;
            }): CollectionCustomization["imageCachePolicy"];
        },
        private readonly bootstrapQueuePort: BootstrapCommandQueuePort,
    ) {}

    async createRun(
        input: CreateBootstrapRunInput,
    ): Promise<CreateBootstrapRunOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );

        const slug = normalizeSlug(input.slug);
        const address = normalizeAddress(input.address);
        const openseaSlug = normalizeOptionalSlug(input.openseaSlug);
        assertOpenSeaSlugIsAllowed(openseaSlug, this.openseaIntegration);
        const metadataMode = input.metadataMode;
        if (metadataMode !== "best_effort" && metadataMode !== "strict") {
            throw new BootstrapValidationError("Invalid metadata mode");
        }
        if (input.standard !== "erc721") {
            throw new BootstrapValidationError("Only erc721 is supported");
        }

        const enumeration = resolveEnumerationInput(
            input.supportsEnumerable,
            input.manualInput,
        );
        const userImageCache = resolveImageCacheInput(input.imageCache);
        const requestExtensionKey = resolveRequestedExtensionKey(
            this.embeddedExtensionResolverPort,
            chain.publicChainId,
            address,
            enumeration,
        );

        const existing = this.bootstrapRunsPort.findCollectionBySlug(
            chain.publicChainId,
            slug,
        );
        if (existing && existing.status === "live") {
            throw new BootstrapConflictError(
                "Collection is live; bootstrap run creation is not allowed",
            );
        }
        if (existing && existing.address !== address) {
            throw new BootstrapValidationError(
                "Slug already belongs to a different contract address",
            );
        }

        const siblingCollections = this.bootstrapRunsPort
            .listCollectionsByAddress(chain.publicChainId, address)
            .filter(
                (collection) =>
                    collection.collectionId !== existing?.collectionId,
            );
        assertCollectionScopeDoesNotOverlap(
            chain.publicChainId,
            siblingCollections,
            enumeration,
            this.bootstrapRunsPort,
        );

        const collection = this.bootstrapRunsPort.upsertCollectionForBootstrap({
            chainId: chain.publicChainId,
            slug,
            address,
            openseaSlug,
            standard: "erc721",
            tokenScopeKind: enumeration.tokenScopeKind,
            scopeStartTokenId: enumeration.scopeStartTokenId,
            scopeTotalSupply: enumeration.scopeTotalSupply,
            explicitTokenIds: enumeration.explicitTokenIds,
            deploymentBlock: input.deploymentBlock ?? null,
        });

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

        const imageCache = resolveEffectiveImageCacheConfig({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            requestExtensionKey,
            userImageCache,
            embeddedExtensionResolverPort: this.embeddedExtensionResolverPort,
        });
        if (
            imageCache.selectedSource ===
            COLLECTION_CUSTOMIZATION_SOURCE_KIND.User
        ) {
            this.collectionCustomizationPort.updateImageCachePolicyState({
                chainId: chain.publicChainId,
                collectionId: collection.collectionId,
                selectedSource: imageCache.selectedSource,
                userConfig: userImageCache,
            });
        }

        const run = this.bootstrapRunsPort.createRun({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            requestSlug: slug,
            requestOpenseaSlug: openseaSlug,
            requestAddress: address,
            requestStandard: "erc721",
            requestExtensionKey,
            metadataMode,
            enumerationMode: enumeration.mode,
            manualTokenIdsJson: enumeration.manualTokenIdsJson,
            manualRangeStartTokenId: enumeration.manualRangeStartTokenId,
            manualRangeTotalSupply: enumeration.manualRangeTotalSupply,
            imageCacheMode: imageCache.effectiveConfig.imageCacheMode,
            imageCacheMaxDimension: imageCache.effectiveConfig.maxDimension,
            deploymentBlock: input.deploymentBlock ?? null,
        });

        this.bootstrapRunsPort.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: "run.requested",
            eventLevel: "info",
            message: "Bootstrap run requested",
            payloadJson: null,
        });

        await this.bootstrapQueuePort.publishBootstrapStart({
            chainId: run.chainId,
            runId: run.runId,
            collectionId: run.collectionId,
        });

        this.bootstrapRunsPort.updateRunStatus(run.runId, "queued");
        this.bootstrapRunsPort.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: "run.queued",
            eventLevel: "info",
            message: "Bootstrap run queued",
            payloadJson: null,
        });

        const queued = this.bootstrapRunsPort.getLatestRun(
            run.chainId,
            run.collectionId,
        );
        const createdAt = queued?.createdAt ?? run.createdAt;
        const status = queued?.status ?? "queued";
        return {
            runId: run.runId,
            collectionId: run.collectionId,
            status,
            createdAt,
        };
    }
}

function resolveImageCacheInput(
    input: CreateBootstrapRunInput["imageCache"],
): ImageCachePolicyConfig {
    if (!input) {
        return defaultImageCachePolicyConfig();
    }
    if (
        input.imageCacheMode === IMAGE_CACHE_MODE.Off &&
        input.maxDimension !== null
    ) {
        return {
            imageCacheMode: IMAGE_CACHE_MODE.Off,
            maxDimension: null,
        };
    }
    const normalized = normalizeImageCachePolicyConfig(input);
    if (normalized.imageCacheMode !== input.imageCacheMode) {
        throw new BootstrapValidationError("Invalid image cache mode");
    }
    if (normalized.maxDimension !== input.maxDimension) {
        throw new BootstrapValidationError("Invalid image cache dimension");
    }
    return normalized;
}

function resolveEffectiveImageCacheConfig(input: {
    chainId: number;
    collectionId: number;
    requestExtensionKey: CollectionExtensionKey | null;
    userImageCache: ImageCachePolicyConfig;
    embeddedExtensionResolverPort: EmbeddedCollectionExtensionResolverPort;
}): {
    selectedSource: CollectionCustomization["imageCachePolicy"]["selectedSource"];
    effectiveConfig: ImageCachePolicyConfig;
} {
    if (input.requestExtensionKey) {
        const extensionConfig =
            input.embeddedExtensionResolverPort.resolveImageCachePolicyConfig({
                chainId: input.chainId,
                collectionId: input.collectionId,
                extensionKey: input.requestExtensionKey,
            });
        if (extensionConfig) {
            return {
                selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension,
                effectiveConfig: extensionConfig,
            };
        }
    }

    return {
        selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
        effectiveConfig: input.userImageCache,
    };
}

function assertOpenSeaSlugIsAllowed(
    openseaSlug: string | null,
    openseaIntegration: OpenSeaIntegrationStatus,
): void {
    if (!openseaSlug || openseaIntegration.enabled) {
        return;
    }

    throw new BootstrapValidationError(
        openseaIntegration.reason ?? "OpenSea integration is disabled",
    );
}

function resolveRequestedExtensionKey(
    embeddedExtensionResolverPort: EmbeddedCollectionExtensionResolverPort,
    chainId: number,
    address: string,
    enumeration: {
        tokenScopeKind:
            | "contract_all_tokens"
            | "token_range"
            | "explicit_token_ids";
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
        explicitTokenIds: string[];
    },
): CollectionExtensionKey | null {
    return embeddedExtensionResolverPort.resolveExtensionKey({
        chainId,
        contractAddress: address,
        scope: toEmbeddedCollectionExtensionScope(enumeration),
    });
}

function toEmbeddedCollectionExtensionScope(input: {
    tokenScopeKind:
        | "contract_all_tokens"
        | "token_range"
        | "explicit_token_ids";
    scopeStartTokenId: string | null;
    scopeTotalSupply: number | null;
    explicitTokenIds: string[];
}): EmbeddedCollectionExtensionScope {
    switch (input.tokenScopeKind) {
        case EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens:
            return {
                kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
            };
        case EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.TokenRange:
            if (
                input.scopeStartTokenId === null ||
                input.scopeTotalSupply === null
            ) {
                throw new BootstrapValidationError(
                    "Token-range scope requires start token and supply",
                );
            }
            return {
                kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.TokenRange,
                startTokenId: input.scopeStartTokenId,
                totalSupply: input.scopeTotalSupply,
            };
        case EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.ExplicitTokenIds:
            return {
                kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.ExplicitTokenIds,
                tokenIds: input.explicitTokenIds,
            };
    }

    throw new BootstrapValidationError(
        `Unsupported token scope kind: ${String(input.tokenScopeKind)}`,
    );
}

function normalizeSlug(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!value) {
        throw new BootstrapValidationError("Slug is required");
    }
    if (!/^[a-z0-9-]+$/.test(value)) {
        throw new BootstrapValidationError("Invalid slug");
    }
    if (value.length > 80) {
        throw new BootstrapValidationError("Slug is too long");
    }
    return value;
}

function normalizeOptionalSlug(raw: string | undefined): string | null {
    if (raw === undefined) return null;
    const value = raw.trim();
    if (!value) return null;
    return normalizeSlug(value);
}

function normalizeAddress(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(value)) {
        throw new BootstrapValidationError("Invalid address");
    }
    return value;
}

function resolveEnumerationInput(
    supportsEnumerable: boolean,
    manualInput: CreateBootstrapRunInput["manualInput"],
): {
    mode: "enumerable" | "manual_token_ids" | "manual_range";
    tokenScopeKind:
        | "contract_all_tokens"
        | "token_range"
        | "explicit_token_ids";
    scopeStartTokenId: string | null;
    scopeTotalSupply: number | null;
    explicitTokenIds: string[];
    manualTokenIdsJson: string | null;
    manualRangeStartTokenId: string | null;
    manualRangeTotalSupply: number | null;
} {
    if (supportsEnumerable) {
        return {
            mode: "enumerable",
            tokenScopeKind: "contract_all_tokens",
            scopeStartTokenId: null,
            scopeTotalSupply: null,
            explicitTokenIds: [],
            manualTokenIdsJson: null,
            manualRangeStartTokenId: null,
            manualRangeTotalSupply: null,
        };
    }

    if (!manualInput) {
        throw new BootstrapValidationError(
            "Manual input is required when enumerable support is disabled",
        );
    }

    if (manualInput.mode === "manual_token_ids") {
        if (manualInput.tokenIds.length === 0) {
            throw new BootstrapValidationError(
                "Token IDs list cannot be empty",
            );
        }
        if (manualInput.tokenIds.length > BOOTSTRAP_MANUAL_TOKEN_IDS_LIMIT) {
            throw new BootstrapValidationError("Token IDs list is too large");
        }
        const normalized = manualInput.tokenIds.map((tokenId) =>
            normalizeTokenId(tokenId),
        );
        return {
            mode: "manual_token_ids",
            tokenScopeKind: "explicit_token_ids",
            scopeStartTokenId: null,
            scopeTotalSupply: null,
            explicitTokenIds: normalized,
            manualTokenIdsJson: JSON.stringify(normalized),
            manualRangeStartTokenId: null,
            manualRangeTotalSupply: null,
        };
    }

    const startTokenId = normalizeTokenId(manualInput.startTokenId);
    const totalSupply = manualInput.totalSupply;
    if (!Number.isInteger(totalSupply) || totalSupply <= 0) {
        throw new BootstrapValidationError(
            "totalSupply must be a positive integer",
        );
    }
    if (totalSupply > BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT) {
        throw new BootstrapValidationError("totalSupply is too large");
    }
    return {
        mode: "manual_range",
        tokenScopeKind: "token_range",
        scopeStartTokenId: startTokenId,
        scopeTotalSupply: totalSupply,
        explicitTokenIds: [],
        manualTokenIdsJson: null,
        manualRangeStartTokenId: startTokenId,
        manualRangeTotalSupply: totalSupply,
    };
}

function normalizeTokenId(raw: string): string {
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
        throw new BootstrapValidationError("Invalid token id");
    }
    if (value.length > 78) {
        throw new BootstrapValidationError("Token id is too large");
    }
    return value;
}

function assertCollectionScopeDoesNotOverlap(
    chainId: number,
    siblingCollections: Array<{
        collectionId: number;
        tokenScopeKind:
            | "contract_all_tokens"
            | "token_range"
            | "explicit_token_ids";
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
        slug: string;
    }>,
    nextScope: {
        tokenScopeKind:
            | "contract_all_tokens"
            | "token_range"
            | "explicit_token_ids";
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
        explicitTokenIds: string[];
    },
    bootstrapRunsPort: Pick<
        BootstrapRunsWritePort,
        "listCollectionScopeTokenIds"
    >,
): void {
    for (const sibling of siblingCollections) {
        if (
            scopesOverlap(nextScope, {
                tokenScopeKind: sibling.tokenScopeKind,
                scopeStartTokenId: sibling.scopeStartTokenId,
                scopeTotalSupply: sibling.scopeTotalSupply,
                explicitTokenIds:
                    sibling.tokenScopeKind === "explicit_token_ids"
                        ? bootstrapRunsPort.listCollectionScopeTokenIds(
                              chainId,
                              sibling.collectionId,
                          )
                        : [],
            })
        ) {
            throw new BootstrapConflictError(
                `Collection scope overlaps with existing collection ${sibling.slug}`,
            );
        }
    }
}

function scopesOverlap(
    left: {
        tokenScopeKind:
            | "contract_all_tokens"
            | "token_range"
            | "explicit_token_ids";
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
        explicitTokenIds: string[];
    },
    right: {
        tokenScopeKind:
            | "contract_all_tokens"
            | "token_range"
            | "explicit_token_ids";
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
        explicitTokenIds: string[];
    },
): boolean {
    if (
        left.tokenScopeKind === "contract_all_tokens" ||
        right.tokenScopeKind === "contract_all_tokens"
    ) {
        return true;
    }

    if (
        left.tokenScopeKind === "token_range" &&
        right.tokenScopeKind === "token_range"
    ) {
        return rangeOverlapsRange(
            left.scopeStartTokenId,
            left.scopeTotalSupply,
            right.scopeStartTokenId,
            right.scopeTotalSupply,
        );
    }

    if (
        left.tokenScopeKind === "token_range" &&
        right.tokenScopeKind === "explicit_token_ids"
    ) {
        return tokenIdsOverlapRange(
            right.explicitTokenIds,
            left.scopeStartTokenId,
            left.scopeTotalSupply,
        );
    }

    if (
        left.tokenScopeKind === "explicit_token_ids" &&
        right.tokenScopeKind === "token_range"
    ) {
        return tokenIdsOverlapRange(
            left.explicitTokenIds,
            right.scopeStartTokenId,
            right.scopeTotalSupply,
        );
    }

    const rightIds = new Set(right.explicitTokenIds);
    return left.explicitTokenIds.some((tokenId) => rightIds.has(tokenId));
}

function rangeOverlapsRange(
    leftStartTokenId: string | null,
    leftTotalSupply: number | null,
    rightStartTokenId: string | null,
    rightTotalSupply: number | null,
): boolean {
    if (
        leftStartTokenId === null ||
        leftTotalSupply === null ||
        rightStartTokenId === null ||
        rightTotalSupply === null
    ) {
        return false;
    }
    const leftStart = BigInt(leftStartTokenId);
    const leftEnd = leftStart + BigInt(leftTotalSupply - 1);
    const rightStart = BigInt(rightStartTokenId);
    const rightEnd = rightStart + BigInt(rightTotalSupply - 1);
    return leftStart <= rightEnd && rightStart <= leftEnd;
}

function tokenIdsOverlapRange(
    tokenIds: string[],
    rangeStartTokenId: string | null,
    totalSupply: number | null,
): boolean {
    if (rangeStartTokenId === null || totalSupply === null) {
        return false;
    }
    const start = BigInt(rangeStartTokenId);
    const end = start + BigInt(totalSupply - 1);
    return tokenIds.some((tokenId) => {
        const value = BigInt(tokenId);
        return value >= start && value <= end;
    });
}
