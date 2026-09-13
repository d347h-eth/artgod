import { describe, expect, it } from "vitest";
import {
    OPENSEA_COLLECTION_SLUG_PROBE_ERROR,
    OPENSEA_COLLECTION_SLUG_PROBE_STATUS,
} from "@artgod/shared/opensea/collection-slug-probe";
import {
    OPENSEA_API_KEY_ENV,
    type OpenSeaIntegrationStatus,
} from "@artgod/shared/config/opensea-integration";
import {
    ProbeOpenSeaCollectionSlugUseCase,
    type OpenSeaCollectionSlugProbePort,
} from "./probe-opensea-collection-slug.js";

const CHAIN = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};
const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";
const COLLECTION_SLUG = "gumbo-by-mathias-isaksen";
const SAMPLE_TOKEN_ID = "462000001";
const ENABLED_OPENSEA_INTEGRATION: OpenSeaIntegrationStatus = {
    enabled: true,
    mode: "auto",
    reason: null,
    missingKeys: [],
    requiredKeys: [OPENSEA_API_KEY_ENV],
};
const DISABLED_OPENSEA_INTEGRATION: OpenSeaIntegrationStatus = {
    enabled: false,
    mode: "auto",
    reason: `OpenSea integration disabled because ${OPENSEA_API_KEY_ENV} is not configured`,
    missingKeys: [OPENSEA_API_KEY_ENV],
    requiredKeys: [OPENSEA_API_KEY_ENV],
};

describe("ProbeOpenSeaCollectionSlugUseCase", () => {
    it("returns disabled without calling OpenSea when integration is unavailable", async () => {
        const calls: unknown[] = [];
        const useCase = makeUseCase(DISABLED_OPENSEA_INTEGRATION, {
            async resolveVerifiedSlug(input) {
                calls.push(input);
                return COLLECTION_SLUG;
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            address: CONTRACT_ADDRESS,
        });

        expect(result).toEqual({
            chain: CHAIN,
            address: CONTRACT_ADDRESS,
            requestedSlug: null,
            status: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Disabled,
            slug: null,
            reason: DISABLED_OPENSEA_INTEGRATION.reason,
        });
        expect(calls).toEqual([]);
    });

    it("forwards the contract and exact sample token to identity verification", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveVerifiedSlug(input) {
                expect(input).toEqual({
                    address: CONTRACT_ADDRESS,
                    requestedSlug: null,
                    sampleTokenId: SAMPLE_TOKEN_ID,
                });
                return COLLECTION_SLUG;
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            address: `0x${CONTRACT_ADDRESS.slice(2).toUpperCase()}`,
            sampleTokenId: SAMPLE_TOKEN_ID,
        });

        expect(result).toEqual({
            chain: CHAIN,
            address: CONTRACT_ADDRESS,
            requestedSlug: null,
            status: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Found,
            slug: COLLECTION_SLUG,
            reason: null,
        });
    });

    it("returns missing when identity verification rejects the requested slug", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveVerifiedSlug() {
                return null;
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            address: CONTRACT_ADDRESS,
            slug: COLLECTION_SLUG,
            sampleTokenId: SAMPLE_TOKEN_ID,
        });

        expect(result).toEqual({
            chain: CHAIN,
            address: CONTRACT_ADDRESS,
            requestedSlug: COLLECTION_SLUG,
            status: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Missing,
            slug: null,
            reason: "OpenSea did not confirm this collection slug",
        });
    });

    it.each([undefined, "", "not-decimal"])(
        "rejects missing or malformed samples (%s)",
        async (sampleTokenId) => {
            const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
                async resolveVerifiedSlug() {
                    throw new Error("must not call OpenSea");
                },
            });
            await expect(
                useCase.probe({
                    chainRef: CHAIN.slug,
                    address: CONTRACT_ADDRESS,
                    sampleTokenId,
                }),
            ).rejects.toThrow(
                sampleTokenId
                    ? OPENSEA_COLLECTION_SLUG_PROBE_ERROR.SampleInvalid
                    : OPENSEA_COLLECTION_SLUG_PROBE_ERROR.SampleRequired,
            );
        },
    );
});

function makeUseCase(
    openseaIntegration: OpenSeaIntegrationStatus,
    openSeaCollectionSlugProbePort: OpenSeaCollectionSlugProbePort | null,
): ProbeOpenSeaCollectionSlugUseCase {
    return new ProbeOpenSeaCollectionSlugUseCase(
        1,
        openseaIntegration,
        {
            resolveChainRef() {
                return CHAIN;
            },
        },
        openSeaCollectionSlugProbePort,
    );
}
