import type { ChainRecord } from "../types/browse.js";
import type { EvmProxyResolution } from "../evm/proxy-detection.js";
import type { CollectionExtensionKey } from "../extensions/index.js";
import type { CollectionCustomizationSourceKind } from "../types/index.js";
import type { ImageCachePolicyConfig } from "../media/token-image-cache.js";
import type { BootstrapScope } from "./scope.js";
import { BOOTSTRAP_ACTION_LABEL as Action } from "./operation-output.js";

export const BOOTSTRAP_PROBE_READ_STATUS = {
    Available: "available",
    Unavailable: "unavailable",
} as const;

export const BOOTSTRAP_SAMPLE_SOURCE = {
    Requested: "requested",
    DeclaredScope: "declared_scope",
    Discovery: "discovery",
} as const;
export const BOOTSTRAP_SHARED_CONTRACT_REASON = {
    Registry: "multi_project_registry",
    ProjectInterface: "multi_project_interface",
} as const;
/** Positive warning evidence only. Absence never establishes a standalone collection. */
export type BootstrapSharedContractFinding = {
    reason: (typeof BOOTSTRAP_SHARED_CONTRACT_REASON)[keyof typeof BOOTSTRAP_SHARED_CONTRACT_REASON];
    registryAddress: string | null;
};
export type BootstrapSampleSource =
    (typeof BOOTSTRAP_SAMPLE_SOURCE)[keyof typeof BOOTSTRAP_SAMPLE_SOURCE];

/** All chain reads in one operation refer to this block, never to a mutable head. */
export type BootstrapProbeObservation = {
    blockNumber: number;
    blockHash: string;
};
export type BootstrapProbeInterfaceCheck = {
    supported: boolean | null;
    error: string | null;
};
export type BootstrapProbeTotalSupply = {
    status: (typeof BOOTSTRAP_PROBE_READ_STATUS)[keyof typeof BOOTSTRAP_PROBE_READ_STATUS];
    value: string | null;
    safeIntegerValue: number | null;
    bootstrapRangeValue: number | null;
    error: string | null;
};
export type BootstrapProbeTokenCandidate = {
    tokenId: string;
    exists: boolean | null;
    error: string | null;
};
export type BootstrapTokenDiscovery = {
    enumeration: {
        checked: boolean;
        tokenId: string | null;
        error: string | null;
    };
    candidates: BootstrapProbeTokenCandidate[];
    sampleTokenId: string | null;
    /** A confirmed conventional ID (0/1), not proof of the historical minimum. */
    rangeStartCandidate: string | null;
};

export type BootstrapContractFindings = {
    observation: BootstrapProbeObservation;
    proxy: EvmProxyResolution | null;
    proxyError: string | null;
    contractName: string | null;
    contractNameError: string | null;
    erc721: BootstrapProbeInterfaceCheck;
    enumerable: BootstrapProbeInterfaceCheck;
    totalSupply: BootstrapProbeTotalSupply;
    sharedContract: BootstrapSharedContractFinding | null;
    discovery: BootstrapTokenDiscovery;
};

export type BootstrapContractProbeResponse = BootstrapContractFindings & {
    chain: ChainRecord;
    address: string;
    standard: "erc721";
};

/** Bounded metadata and separately classified chain/download/parse results. */
export type BootstrapSampleMetadata = {
    tokenUri: string | null;
    tokenUriError: string | null;
    tokenUriPayload: string | null;
    tokenUriPayloadBytes: number | null;
    tokenUriPayloadTruncated: boolean;
    tokenUriPayloadError: string | null;
    metadataError: string | null;
};
export type BootstrapProbeSample = BootstrapSampleMetadata & {
    tokenId: string | null;
    source: BootstrapSampleSource | null;
    ownership: BootstrapProbeTokenCandidate | null;
    candidates: BootstrapProbeTokenCandidate[];
};

export type BootstrapImageCacheSuggestion = {
    selectedSource: CollectionCustomizationSourceKind;
    extensionKey: CollectionExtensionKey | null;
    config: ImageCachePolicyConfig;
};
/** Sample-specific project facts from a recognized on-chain implementation.
 * Counts describe consecutive IDs from startTokenId, not contract-wide supply.
 * The configured maximum can include tokens that have not been minted yet.
 */
export type BootstrapProjectScope = {
    projectId: string;
    projectName: string | null;
    startTokenId: string;
    mintedTokenCount: number;
    maxTokenCount: number;
};
/** Start ownership is checked separately: project counters may outlive a burned token. */
export type BootstrapProjectScopeSuggestion = BootstrapProjectScope & {
    startTokenOwnership: BootstrapProbeTokenCandidate;
};
export type BootstrapSampleInspectionRequest = {
    address: string;
    requestedTokenId?: string | null;
    discoveredTokenId?: string | null;
    observation?: BootstrapProbeObservation | null;
    scope?: BootstrapScope | null;
};
export type BootstrapSampleInspectionResponse = {
    chain: ChainRecord;
    address: string;
    observation: BootstrapProbeObservation;
    requestedTokenId: string | null;
    scope: BootstrapScope | null;
    sample: BootstrapProbeSample;
    projectScope: BootstrapProjectScopeSuggestion | null;
    ipfsGatewayOrigin: string;
    imageCacheSuggestion: BootstrapImageCacheSuggestion;
};

export function emptyBootstrapSampleMetadata(): BootstrapSampleMetadata {
    return {
        tokenUri: null,
        tokenUriError: null,
        tokenUriPayload: null,
        tokenUriPayloadBytes: null,
        tokenUriPayloadTruncated: false,
        tokenUriPayloadError: null,
        metadataError: null,
    };
}

// Ownership and metadata availability remain independent.
export function bootstrapSampleOwnership(
    sample: BootstrapProbeSample,
): boolean | null {
    return sample.ownership?.exists ?? null;
}
export function bootstrapSampleFailure(
    sample: BootstrapProbeSample,
): string | null {
    if (!sample.tokenId)
        return `No sample was confirmed. Enter an existing sample token ID, then press ${Action.Inspect}.`;
    if (sample.ownership?.exists !== true)
        return (
            sample.ownership?.error ??
            `Ownership could not be checked. Press ${Action.Inspect} to retry.`
        );
    return (
        sample.tokenUriError ??
        sample.tokenUriPayloadError ??
        sample.metadataError
    );
}
