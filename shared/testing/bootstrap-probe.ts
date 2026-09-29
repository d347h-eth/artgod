import { BOOTSTRAP_ENUMERATION_MODE } from "../bootstrap/pipeline.js";
import {
    BOOTSTRAP_PROBE_READ_STATUS,
    BOOTSTRAP_SAMPLE_SOURCE,
    emptyBootstrapSampleMetadata,
    type BootstrapContractProbeResponse,
    type BootstrapSampleInspectionResponse,
} from "../bootstrap/probe.js";
import { defaultImageCachePolicyConfig } from "../media/token-image-cache.js";
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from "../types/index.js";

export const BOOTSTRAP_TEST_CHAIN = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
} as const;
export const BOOTSTRAP_TEST_OBSERVATION = {
    blockNumber: 12345,
    blockHash: "0x" + "ab".repeat(32),
};
export const BOOTSTRAP_TEST_ADDRESS =
    "0x1111111111111111111111111111111111111111";
export const BOOTSTRAP_TEST_OWNER =
    "0x2222222222222222222222222222222222222222";

// User-provided boundaries with deterministic chain responses, not live observations.
export const BOOTSTRAP_CONTRACT_CASES = [
    {
        name: "milady",
        address: "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
        start: "0",
        count: 10000,
        enumerable: true,
        supply: 10000n,
        sample: "0",
        openseaSlug: "milady",
    },
    {
        name: "remilio",
        address: "0xd3d9ddd0cf0a5f0bfb8f7fceae075df687eaebab",
        start: "1",
        count: 10000,
        enumerable: false,
        supply: 10000n,
        sample: "1",
        openseaSlug: "remilio-babies",
    },
    {
        name: "meridian",
        address: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
        start: "163000000",
        count: 1000,
        // Synthetic contract-wide inventory, deliberately larger than this project's range.
        enumerable: true,
        supply: 200000n,
        sample: "163000000",
        openseaSlug: "meridian-by-matt-deslauriers",
    },
    {
        name: "grailers",
        address: "0xd89239186180617cfe17e8b73b2b8bd9c96d0a15",
        start: "0",
        count: 1000,
        // Synthetic counter and sparse inventory; the live counter need not equal minted IDs.
        enumerable: false,
        supply: 704n,
        sample: "10",
        openseaSlug: "grailers-dao",
    },
    {
        name: "aeon",
        address: "0xc374a204334d4edd4c6a62f0867c752d65e9579c",
        start: "1",
        count: 3333,
        enumerable: false,
        supply: 3333n,
        sample: "1",
        openseaSlug: null,
    },
] as const;

export function bootstrapTestContract(
    overrides: Partial<BootstrapContractProbeResponse> = {},
): BootstrapContractProbeResponse {
    return {
        chain: BOOTSTRAP_TEST_CHAIN,
        address: BOOTSTRAP_TEST_ADDRESS,
        standard: "erc721",
        observation: BOOTSTRAP_TEST_OBSERVATION,
        proxy: null,
        proxyError: null,
        contractName: "Example collection",
        contractNameError: null,
        sharedContract: null,
        erc721: { supported: true, error: null },
        enumerable: { supported: true, error: null },
        totalSupply: {
            status: BOOTSTRAP_PROBE_READ_STATUS.Available,
            value: "100",
            safeIntegerValue: 100,
            bootstrapRangeValue: 100,
            error: null,
        },
        discovery: {
            enumeration: { checked: true, tokenId: "0", error: null },
            candidates: [
                { tokenId: "0", exists: true, error: null },
                { tokenId: "1", exists: true, error: null },
            ],
            sampleTokenId: "0",
            rangeStartCandidate: "0",
        },
        ...overrides,
    };
}

export function bootstrapTestSample(
    overrides: Partial<BootstrapSampleInspectionResponse> = {},
): BootstrapSampleInspectionResponse {
    const text = JSON.stringify({
        name: "Example #0",
        image: "https://example.com/0.png",
        animation_url: "https://example.com/0.html",
    });
    return {
        chain: BOOTSTRAP_TEST_CHAIN,
        address: BOOTSTRAP_TEST_ADDRESS,
        observation: BOOTSTRAP_TEST_OBSERVATION,
        requestedTokenId: null,
        scope: { mode: BOOTSTRAP_ENUMERATION_MODE.Enumerable },
        sample: {
            ...emptyBootstrapSampleMetadata(),
            tokenId: "0",
            source: BOOTSTRAP_SAMPLE_SOURCE.Discovery,
            ownership: { tokenId: "0", exists: true, error: null },
            candidates: [{ tokenId: "0", exists: true, error: null }],
            tokenUri: "https://example.com/0",
            tokenUriPayload: text,
            tokenUriPayloadBytes: new TextEncoder().encode(text).byteLength,
        },
        ipfsGatewayOrigin: "https://ipfs.io",
        imageCacheSuggestion: {
            selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
            extensionKey: null,
            config: defaultImageCachePolicyConfig(),
        },
        ...overrides,
    };
}
