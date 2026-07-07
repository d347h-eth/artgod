import type { ChainRecord } from "@artgod/shared/types/browse";
import type { EvmProxyResolution } from "@artgod/shared/evm/proxy-detection";
import { BOOTSTRAP_ENUMERATION_MODE } from "@artgod/shared/bootstrap/pipeline";
import {
    EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND,
    type CollectionExtensionKey,
    type EmbeddedCollectionExtensionScope,
} from "@artgod/shared/extensions";
import {
    COLLECTION_CUSTOMIZATION_SOURCE_KIND,
    type CollectionCustomizationSourceKind,
} from "@artgod/shared/types";
import {
    defaultImageCachePolicyConfig,
    type ImageCachePolicyConfig,
} from "@artgod/shared/media/token-image-cache";
import { normalizeTokenMetadataAnimationSourceField } from "@artgod/shared/media/token-metadata-animation-source";
import { normalizeTokenMetadataImageSourceField } from "@artgod/shared/media/token-metadata-image-source";
import type { ChainRefResolverPort } from "./ports.js";
import { BootstrapValidationError } from "./types.js";
import { BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT } from "./bootstrap-limits.js";

// Serialized availability states returned by bootstrap contract probes.
export const BOOTSTRAP_PROBE_READ_STATUS = {
    Available: "available",
    Unavailable: "unavailable",
} as const;

export type BootstrapProbeReadStatus =
    (typeof BOOTSTRAP_PROBE_READ_STATUS)[keyof typeof BOOTSTRAP_PROBE_READ_STATUS];

// Candidate token lookup mechanisms exposed in bootstrap probe diagnostics.
export const BOOTSTRAP_PROBE_TOKEN_CANDIDATE_SOURCE = {
    TokenUri: "token_uri",
    OwnerOf: "owner_of",
} as const;

export type BootstrapProbeTokenCandidateSource =
    (typeof BOOTSTRAP_PROBE_TOKEN_CANDIDATE_SOURCE)[keyof typeof BOOTSTRAP_PROBE_TOKEN_CANDIDATE_SOURCE];

// Sample token source states exposed in bootstrap probe responses.
export const BOOTSTRAP_PROBE_FIRST_TOKEN_SOURCE = {
    TokenByIndex: "token_by_index",
    CandidateTokenUri: "candidate_token_uri",
    CandidateOwnerOf: "candidate_owner_of",
} as const;

export type BootstrapProbeFirstTokenSource =
    (typeof BOOTSTRAP_PROBE_FIRST_TOKEN_SOURCE)[keyof typeof BOOTSTRAP_PROBE_FIRST_TOKEN_SOURCE];

// Image byte-size measurement sources exposed in bootstrap probe responses.
export const BOOTSTRAP_PROBE_IMAGE_BYTES_SOURCE = {
    ContentLength: "content_length",
    Download: "download",
    DataUri: "data_uri",
} as const;

export type BootstrapProbeImageBytesSource =
    (typeof BOOTSTRAP_PROBE_IMAGE_BYTES_SOURCE)[keyof typeof BOOTSTRAP_PROBE_IMAGE_BYTES_SOURCE];

export type BootstrapProbeInterfaceCheck = {
    supported: boolean | null;
    error: string | null;
};

export type BootstrapProbeTotalSupply = {
    status: BootstrapProbeReadStatus;
    value: string | null;
    safeIntegerValue: number | null;
    bootstrapRangeValue: number | null;
    error: string | null;
};

export type BootstrapProbeTokenCandidate = {
    tokenId: string;
    exists: boolean | null;
    source: BootstrapProbeTokenCandidateSource | null;
    error: string | null;
};

export type BootstrapProbeFirstToken = {
    tokenId: string | null;
    source: BootstrapProbeFirstTokenSource | null;
    tokenUri: string | null;
    tokenUriPayloadBytes: number | null;
    tokenUriPayloadTruncated: boolean;
    tokenUriPayloadError: string | null;
    name: string | null;
    imageSourceField: string | null;
    image: string | null;
    imageBytes: number | null;
    imageBytesSource: BootstrapProbeImageBytesSource | null;
    imageContentType: string | null;
    imageBytesError: string | null;
    imageWidth: number | null;
    imageHeight: number | null;
    animationSourceField: string | null;
    animationUrl: string | null;
    metadataError: string | null;
    candidates: BootstrapProbeTokenCandidate[];
};

export type BootstrapProbeStorageEstimate = {
    sampleTokenId: string;
    samplePayloadBytes: number;
    projectedBytes: string;
    totalSupply: string;
} | null;

export type BootstrapProbeImageStorageEstimate = {
    sampleTokenId: string;
    sampleImageBytes: number;
    projectedBytes: string;
    totalSupply: string;
    contentType: string | null;
} | null;

export type BootstrapProbeSuggestedInput = {
    supportsEnumerable: boolean;
    manualInput: {
        mode: typeof BOOTSTRAP_ENUMERATION_MODE.ManualRange;
        startTokenId: string;
        totalSupply: number;
    } | null;
    ready: boolean;
    warnings: string[];
};

// Image-cache policy the bootstrap form should preselect after contract probing.
export type BootstrapProbeImageCacheSuggestion = {
    selectedSource: CollectionCustomizationSourceKind;
    extensionKey: CollectionExtensionKey | null;
    config: ImageCachePolicyConfig;
};

// Proxy bytecode identity included in bootstrap probe responses when detected.
export type BootstrapProbeContractProxy = EvmProxyResolution;

export type ProbeCollectionContractInput = {
    chainRef: string;
    address: string;
    standard: "erc721";
    imageSourceField?: string;
    animationSourceField?: string;
    sampleTokenId?: string;
};

export type ProbeCollectionContractOutput = {
    chain: ChainRecord;
    address: string;
    standard: "erc721";
    proxy: BootstrapProbeContractProxy | null;
    contractName: string | null;
    erc721: BootstrapProbeInterfaceCheck;
    enumerable: BootstrapProbeInterfaceCheck;
    totalSupply: BootstrapProbeTotalSupply;
    firstToken: BootstrapProbeFirstToken;
    storageEstimate: BootstrapProbeStorageEstimate;
    imageStorageEstimate: BootstrapProbeImageStorageEstimate;
    suggestedInput: BootstrapProbeSuggestedInput;
    imageCacheSuggestion: BootstrapProbeImageCacheSuggestion;
};

export type CollectionContractProbeResult = Omit<
    ProbeCollectionContractOutput,
    | "chain"
    | "address"
    | "standard"
    | "suggestedInput"
    | "storageEstimate"
    | "imageStorageEstimate"
    | "imageCacheSuggestion"
>;

export interface CollectionContractProbePort {
    probeErc721Contract(input: {
        address: string;
        imageSourceField: string | null;
        animationSourceField: string | null;
        sampleTokenId: string | null;
    }): Promise<CollectionContractProbeResult>;
}

// Resolves built-in extension matches while probing a collection before creation.
export interface ProbeCollectionExtensionResolverPort {
    resolveExtensionKey(input: {
        chainId: number;
        contractAddress: string;
        scope: EmbeddedCollectionExtensionScope;
    }): CollectionExtensionKey | null;
    resolveImageCachePolicyConfig(input: {
        chainId: number;
        extensionKey: CollectionExtensionKey;
    }): ImageCachePolicyConfig | null;
}

export class ProbeCollectionContractUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly collectionContractProbePort: CollectionContractProbePort,
        private readonly collectionExtensionResolverPort: ProbeCollectionExtensionResolverPort,
    ) {}

    async probe(
        input: ProbeCollectionContractInput,
    ): Promise<ProbeCollectionContractOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        if (input.standard !== "erc721") {
            throw new BootstrapValidationError("Only erc721 is supported");
        }
        const address = normalizeAddress(input.address);
        const imageSourceField = normalizeTokenMetadataImageSourceField(
            input.imageSourceField,
        );
        const animationSourceField = normalizeTokenMetadataAnimationSourceField(
            input.animationSourceField,
        );
        const sampleTokenId = normalizeOptionalTokenId(input.sampleTokenId);

        // Probe the unregistered contract before the user starts bootstrap.
        const probe =
            await this.collectionContractProbePort.probeErc721Contract({
                address,
                imageSourceField,
                animationSourceField,
                sampleTokenId,
            });
        const storageEstimate = estimateStorage(probe);
        const imageStorageEstimate = estimateImageStorage(probe);
        const suggestedInput = buildSuggestedInput(
            probe,
            sampleTokenId !== null,
        );
        return {
            chain,
            address,
            standard: "erc721",
            ...probe,
            storageEstimate,
            imageStorageEstimate,
            suggestedInput,
            imageCacheSuggestion: resolveImageCacheSuggestion({
                chainId: chain.publicChainId,
                address,
                suggestedInput,
                collectionExtensionResolverPort:
                    this.collectionExtensionResolverPort,
            }),
        };
    }
}

function normalizeAddress(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(value)) {
        throw new BootstrapValidationError("Invalid address");
    }
    return value;
}

function normalizeOptionalTokenId(raw: string | undefined): string | null {
    if (raw === undefined) return null;
    const value = raw.trim();
    return value ? value : null;
}

function buildSuggestedInput(
    probe: CollectionContractProbeResult,
    customSampleTokenRequested: boolean,
): BootstrapProbeSuggestedInput {
    const warnings: string[] = [];
    if (probe.erc721.supported === false) {
        warnings.push("erc721 interface was not reported by ERC165");
    }
    if (probe.enumerable.supported === true) {
        if (probe.totalSupply.status !== "available") {
            warnings.push("totalSupply is unavailable for the size estimate");
        }
        if (!probe.firstToken.tokenId) {
            warnings.push(
                "first token could not be resolved through tokenByIndex",
            );
        }
        return {
            supportsEnumerable: true,
            manualInput: null,
            ready: true,
            warnings,
        };
    }

    if (probe.totalSupply.status !== "available") {
        warnings.push("totalSupply could not be read");
    }
    if (!probe.firstToken.tokenId) {
        warnings.push("token id 0 and 1 could not be confirmed");
    }
    if (
        probe.totalSupply.value !== null &&
        probe.totalSupply.bootstrapRangeValue === null
    ) {
        warnings.push(
            "totalSupply is too large for the current bootstrap range limit",
        );
    }

    const manualInput =
        !customSampleTokenRequested &&
        probe.firstToken.tokenId &&
        probe.totalSupply.bootstrapRangeValue
            ? {
                  mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
                  startTokenId: probe.firstToken.tokenId,
                  totalSupply: probe.totalSupply.bootstrapRangeValue,
              }
            : null;

    return {
        supportsEnumerable: false,
        manualInput,
        ready: manualInput !== null,
        warnings,
    };
}

function resolveImageCacheSuggestion(input: {
    chainId: number;
    address: string;
    suggestedInput: BootstrapProbeSuggestedInput;
    collectionExtensionResolverPort: ProbeCollectionExtensionResolverPort;
}): BootstrapProbeImageCacheSuggestion {
    const scope = toEmbeddedCollectionExtensionScope(input.suggestedInput);
    if (!scope) {
        return defaultImageCacheSuggestion();
    }

    const extensionKey =
        input.collectionExtensionResolverPort.resolveExtensionKey({
            chainId: input.chainId,
            contractAddress: input.address,
            scope,
        });
    if (!extensionKey) {
        return defaultImageCacheSuggestion();
    }

    const extensionConfig =
        input.collectionExtensionResolverPort.resolveImageCachePolicyConfig({
            chainId: input.chainId,
            extensionKey,
        });
    if (!extensionConfig) {
        return {
            ...defaultImageCacheSuggestion(),
            extensionKey,
        };
    }

    return {
        selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension,
        extensionKey,
        config: extensionConfig,
    };
}

function defaultImageCacheSuggestion(): BootstrapProbeImageCacheSuggestion {
    return {
        selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
        extensionKey: null,
        config: defaultImageCachePolicyConfig(),
    };
}

function toEmbeddedCollectionExtensionScope(
    suggestedInput: BootstrapProbeSuggestedInput,
): EmbeddedCollectionExtensionScope | null {
    if (suggestedInput.supportsEnumerable) {
        return {
            kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
        };
    }

    if (
        suggestedInput.manualInput?.mode ===
        BOOTSTRAP_ENUMERATION_MODE.ManualRange
    ) {
        return {
            kind: EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.TokenRange,
            startTokenId: suggestedInput.manualInput.startTokenId,
            totalSupply: suggestedInput.manualInput.totalSupply,
        };
    }

    return null;
}

function estimateStorage(
    probe: CollectionContractProbeResult,
): BootstrapProbeStorageEstimate {
    if (
        !probe.firstToken.tokenId ||
        probe.firstToken.tokenUriPayloadBytes === null ||
        probe.totalSupply.value === null
    ) {
        return null;
    }
    const samplePayloadBytes = BigInt(probe.firstToken.tokenUriPayloadBytes);
    const totalSupply = BigInt(probe.totalSupply.value);
    return {
        sampleTokenId: probe.firstToken.tokenId,
        samplePayloadBytes: probe.firstToken.tokenUriPayloadBytes,
        projectedBytes: (samplePayloadBytes * totalSupply).toString(),
        totalSupply: probe.totalSupply.value,
    };
}

function estimateImageStorage(
    probe: CollectionContractProbeResult,
): BootstrapProbeImageStorageEstimate {
    if (
        !probe.firstToken.tokenId ||
        probe.firstToken.imageBytes === null ||
        probe.totalSupply.value === null
    ) {
        return null;
    }
    const sampleImageBytes = BigInt(probe.firstToken.imageBytes);
    const totalSupply = BigInt(probe.totalSupply.value);
    return {
        sampleTokenId: probe.firstToken.tokenId,
        sampleImageBytes: probe.firstToken.imageBytes,
        projectedBytes: (sampleImageBytes * totalSupply).toString(),
        totalSupply: probe.totalSupply.value,
        contentType: probe.firstToken.imageContentType,
    };
}

export function toBootstrapRangeTotalSupply(value: bigint): number | null {
    if (value <= 0n) return null;
    if (value > BigInt(BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT)) return null;
    return Number(value);
}

export function toSafeIntegerValue(value: bigint): number | null {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
}
