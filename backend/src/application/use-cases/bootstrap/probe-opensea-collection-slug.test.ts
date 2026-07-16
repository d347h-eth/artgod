import { describe, expect, it } from "vitest";
import {
    OPENSEA_API_KEY_ENV,
    type OpenSeaIntegrationStatus,
} from "@artgod/shared/config/opensea-integration";
import { BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS } from "@artgod/shared/bootstrap/opensea-slug-probe";
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
            async resolveCollectionSlugByContract(input) {
                calls.push(input);
                return "ignored";
            },
            async resolveCollectionBySlug(input) {
                calls.push(input);
                return { slug: "ignored", contractAddresses: [] };
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
            status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Disabled,
            slug: null,
            reason: DISABLED_OPENSEA_INTEGRATION.reason,
        });
        expect(calls).toEqual([]);
    });

    it("returns the OpenSea slug resolved from the contract address", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveCollectionSlugByContract(input) {
                expect(input).toEqual({
                    address: CONTRACT_ADDRESS,
                });
                return "milady-maker";
            },
            async resolveCollectionBySlug() {
                return null;
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            address: `0x${CONTRACT_ADDRESS.slice(2).toUpperCase()}`,
        });

        expect(result).toEqual({
            chain: CHAIN,
            address: CONTRACT_ADDRESS,
            requestedSlug: null,
            status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found,
            slug: "milady-maker",
            reason: null,
        });
    });

    it("returns the OpenSea slug when the entered slug resolves exactly", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveCollectionSlugByContract() {
                return null;
            },
            async resolveCollectionBySlug(input) {
                expect(input).toEqual({
                    slug: "milady-maker",
                });
                return { slug: "milady-maker", contractAddresses: [] };
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            slug: "Milady-Maker",
        });

        expect(result).toEqual({
            chain: CHAIN,
            address: null,
            requestedSlug: "milady-maker",
            status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found,
            slug: "milady-maker",
            reason: null,
        });
    });

    it("verifies that the entered OpenSea collection lists the contract", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveCollectionSlugByContract() {
                throw new Error("contract lookup should not run");
            },
            async resolveCollectionBySlug(input) {
                expect(input).toEqual({ slug: "milady-maker" });
                return {
                    slug: "milady-maker",
                    contractAddresses: [CONTRACT_ADDRESS],
                };
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            address: CONTRACT_ADDRESS,
            slug: "milady-maker",
        });

        expect(result).toEqual({
            chain: CHAIN,
            address: CONTRACT_ADDRESS,
            requestedSlug: "milady-maker",
            status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found,
            slug: "milady-maker",
            reason: null,
        });
    });

    it("returns missing when the entered collection does not list the contract", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveCollectionSlugByContract() {
                throw new Error("contract lookup should not run");
            },
            async resolveCollectionBySlug() {
                return {
                    slug: "milady-maker",
                    contractAddresses: [
                        "0x2222222222222222222222222222222222222222",
                    ],
                };
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            address: CONTRACT_ADDRESS,
            slug: "milady-maker",
        });

        expect(result).toEqual({
            chain: CHAIN,
            address: CONTRACT_ADDRESS,
            requestedSlug: "milady-maker",
            status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Missing,
            slug: null,
            reason: "OpenSea did not confirm this collection slug",
        });
    });

    it("returns missing when the entered slug does not resolve exactly", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveCollectionSlugByContract() {
                return null;
            },
            async resolveCollectionBySlug() {
                return { slug: "different-collection", contractAddresses: [] };
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            slug: "milady-maker",
        });

        expect(result).toEqual({
            chain: CHAIN,
            address: null,
            requestedSlug: "milady-maker",
            status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Missing,
            slug: null,
            reason: "OpenSea did not confirm this collection slug",
        });
    });

    it("returns missing when OpenSea has no collection slug for the contract", async () => {
        const useCase = makeUseCase(ENABLED_OPENSEA_INTEGRATION, {
            async resolveCollectionSlugByContract() {
                return null;
            },
            async resolveCollectionBySlug() {
                return null;
            },
        });

        const result = await useCase.probe({
            chainRef: "ethereum",
            address: CONTRACT_ADDRESS,
        });

        expect(result.status).toBe(BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Missing);
        expect(result.requestedSlug).toBeNull();
        expect(result.slug).toBeNull();
        expect(result.reason).toContain("OpenSea did not return");
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
