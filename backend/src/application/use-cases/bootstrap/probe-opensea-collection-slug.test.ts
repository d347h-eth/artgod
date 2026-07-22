import { describe, expect, it } from "vitest";
import {
    OPENSEA_COLLECTION_SLUG_PROBE_MAX_VERIFICATION_TOKEN_IDS,
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
const VERIFICATION_TOKEN_IDS = ["462000000", "462000399"];
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

    it("forwards the contract and representative scope tokens to identity verification", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveVerifiedSlug(input) {
                expect(input).toEqual({
                    address: CONTRACT_ADDRESS,
                    requestedSlug: null,
                    verificationTokenIds: VERIFICATION_TOKEN_IDS,
                });
                return COLLECTION_SLUG;
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            address: `0x${CONTRACT_ADDRESS.slice(2).toUpperCase()}`,
            verificationTokenIds: VERIFICATION_TOKEN_IDS,
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

    it("verifies an entered slug without a contract for the slug-only flow", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveVerifiedSlug(input) {
                expect(input).toEqual({
                    address: null,
                    requestedSlug: COLLECTION_SLUG,
                    verificationTokenIds: [],
                });
                return COLLECTION_SLUG;
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            slug: "Gumbo-By-Mathias-Isaksen",
        });

        expect(result.status).toBe(OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Found);
        expect(result.requestedSlug).toBe(COLLECTION_SLUG);
        expect(result.slug).toBe(COLLECTION_SLUG);
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
            verificationTokenIds: VERIFICATION_TOKEN_IDS,
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

    it("rejects verification token IDs without a contract address", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveVerifiedSlug() {
                throw new Error("identity verification should not run");
            },
        });

        await expect(
            useCase.probe({
                chainRef: "ethereum",
                slug: COLLECTION_SLUG,
                verificationTokenIds: VERIFICATION_TOKEN_IDS,
            }),
        ).rejects.toThrow(
            "OpenSea verification token IDs require a contract address",
        );
    });

    it("rejects malformed or excessive verification token IDs", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveVerifiedSlug() {
                throw new Error("identity verification should not run");
            },
        });

        await expect(
            useCase.probe({
                chainRef: "ethereum",
                address: CONTRACT_ADDRESS,
                verificationTokenIds: ["not-decimal"],
            }),
        ).rejects.toThrow("OpenSea verification token IDs must be decimal");
        await expect(
            useCase.probe({
                chainRef: "ethereum",
                address: CONTRACT_ADDRESS,
                verificationTokenIds: Array.from(
                    {
                        length:
                            OPENSEA_COLLECTION_SLUG_PROBE_MAX_VERIFICATION_TOKEN_IDS +
                            1,
                    },
                    (_, index) => String(index),
                ),
            }),
        ).rejects.toThrow(
            "OpenSea slug verification accepts at most the first and last token IDs",
        );
    });
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
