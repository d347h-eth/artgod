import type { ChainRecord } from "@artgod/shared/types/browse";
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
import type { ChainRefResolverPort } from "./ports.js";
import { BootstrapValidationError } from "./types.js";
import { BOOTSTRAP_MANUAL_RANGE_TOTAL_SUPPLY_LIMIT } from "./bootstrap-limits.js";

export type BootstrapProbeReadStatus = "available" | "unavailable";

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
    source: "token_uri" | "owner_of" | null;
    error: string | null;
};

export type BootstrapProbeFirstToken = {
    tokenId: string | null;
    source: "token_by_index" | "candidate_token_uri" | "candidate_owner_of" | null;
    tokenUri: string | null;
    tokenUriPayloadBytes: number | null;
    tokenUriPayloadTruncated: boolean;
    tokenUriPayloadError: string | null;
    name: string | null;
    image: string | null;
    imageBytes: number | null;
    imageBytesSource: "content_length" | "download" | "data_uri" | null;
    imageContentType: string | null;
    imageBytesError: string | null;
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
    manualInput:
        | {
              mode: "manual_range";
              startTokenId: string;
              totalSupply: number;
          }
        | null;
    ready: boolean;
    warnings: string[];
};

// Image-cache policy the bootstrap form should preselect after contract probing.
export type BootstrapProbeImageCacheSuggestion = {
    selectedSource: CollectionCustomizationSourceKind;
    extensionKey: CollectionExtensionKey | null;
    config: ImageCachePolicyConfig;
};

export type ProbeCollectionContractInput = {
    chainRef: string;
    address: string;
    standard: "erc721";
};

export type ProbeCollectionContractOutput = {
    chain: ChainRecord;
    address: string;
    standard: "erc721";
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
>;

export interface CollectionContractProbePort {
    probeErc721Contract(input: {
        address: string;
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

        // Probe the unregistered contract before the user starts bootstrap.
        const probe = await this.collectionContractProbePort.probeErc721Contract(
            {
                address,
            },
        );
        const storageEstimate = estimateStorage(probe);
        const imageStorageEstimate = estimateImageStorage(probe);
        const suggestedInput = buildSuggestedInput(probe);
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

function buildSuggestedInput(
    probe: CollectionContractProbeResult,
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
            warnings.push("first token could not be resolved through tokenByIndex");
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
        warnings.push("totalSupply is too large for the current bootstrap range limit");
    }

    const manualInput =
        probe.firstToken.tokenId && probe.totalSupply.bootstrapRangeValue
            ? {
                  mode: "manual_range" as const,
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

    if (suggestedInput.manualInput?.mode === "manual_range") {
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
