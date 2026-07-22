import { describe, expect, it } from "vitest";
import { OPENSEA_COLLECTION_SLUG_PROBE_STATUS } from "@artgod/shared/opensea/collection-slug-probe";
import {
    OPENSEA_API_KEY_ENV,
    type OpenSeaIntegrationStatus,
} from "@artgod/shared/config/opensea-integration";
import {
    COLLECTION_STATUS,
    OPENSEA_COLLECTION_STATUS,
} from "@artgod/shared/types";
import {
    StartOpenSeaCollectionSyncUseCase,
    type OpenSeaCollectionSyncSlugProbePort,
    type OpenSeaCollectionSyncState,
} from "./start-opensea-collection-sync.js";

const CHAIN = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};
const COLLECTION_SLUG = "gumbo";
const OPENSEA_SLUG = "gumbo-by-mathias-isaksen";
const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";
const VERIFICATION_TOKEN_IDS = ["462000000", "462000399"];
const ENABLED_OPENSEA_INTEGRATION: OpenSeaIntegrationStatus = {
    enabled: true,
    mode: "auto",
    reason: null,
    missingKeys: [],
    requiredKeys: [OPENSEA_API_KEY_ENV],
};
const COLLECTION: OpenSeaCollectionSyncState = {
    chainId: 1,
    collectionId: 16,
    slug: COLLECTION_SLUG,
    address: CONTRACT_ADDRESS,
    status: COLLECTION_STATUS.Live,
    openseaSlug: null,
    openseaStatus: OPENSEA_COLLECTION_STATUS.Failed,
    openseaLastError: "previous failure",
    verificationTokenIds: VERIFICATION_TOKEN_IDS,
};

describe("StartOpenSeaCollectionSyncUseCase", () => {
    it("probes a live collection through its persisted scope boundaries", async () => {
        const verificationInputs: unknown[] = [];
        const fixture = makeUseCase({
            async resolveVerifiedSlug(input) {
                verificationInputs.push(input);
                return OPENSEA_SLUG;
            },
        });

        const output = await fixture.useCase.probeSlug({
            chainRef: CHAIN.slug,
            collectionRef: COLLECTION_SLUG,
        });

        expect(output).toEqual({
            chain: CHAIN,
            address: CONTRACT_ADDRESS,
            requestedSlug: null,
            status: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Found,
            slug: OPENSEA_SLUG,
            reason: null,
        });
        expect(verificationInputs).toEqual([
            {
                address: CONTRACT_ADDRESS,
                requestedSlug: null,
                verificationTokenIds: VERIFICATION_TOKEN_IDS,
            },
        ]);
        expect(fixture.markPendingInputs).toEqual([]);
        expect(fixture.queueInputs).toEqual([]);
    });

    it("re-verifies the entered slug before storing it and starting sync", async () => {
        const verificationInputs: unknown[] = [];
        const fixture = makeUseCase({
            async resolveVerifiedSlug(input) {
                verificationInputs.push(input);
                return OPENSEA_SLUG;
            },
        });

        const output = await fixture.useCase.startSync({
            chainRef: CHAIN.slug,
            collectionRef: COLLECTION_SLUG,
            openseaSlug: OPENSEA_SLUG,
        });

        expect(output.openseaStatus).toBe(OPENSEA_COLLECTION_STATUS.Pending);
        expect(verificationInputs).toEqual([
            {
                address: CONTRACT_ADDRESS,
                requestedSlug: OPENSEA_SLUG,
                verificationTokenIds: VERIFICATION_TOKEN_IDS,
            },
        ]);
        expect(fixture.markPendingInputs).toEqual([
            {
                chainId: COLLECTION.chainId,
                collectionId: COLLECTION.collectionId,
                openseaSlug: OPENSEA_SLUG,
            },
        ]);
        expect(fixture.queueInputs).toEqual([
            {
                chainId: COLLECTION.chainId,
                collectionId: COLLECTION.collectionId,
            },
        ]);
    });

    it("does not mutate collection state when identity verification fails", async () => {
        const fixture = makeUseCase({
            async resolveVerifiedSlug() {
                return null;
            },
        });

        await expect(
            fixture.useCase.startSync({
                chainRef: CHAIN.slug,
                collectionRef: COLLECTION_SLUG,
                openseaSlug: "sibling-collection",
            }),
        ).rejects.toThrow(
            "OpenSea could not verify this collection slug; resolve it again",
        );
        expect(fixture.markPendingInputs).toEqual([]);
        expect(fixture.queueInputs).toEqual([]);
    });
});

function makeUseCase(slugProbePort: OpenSeaCollectionSyncSlugProbePort) {
    const markPendingInputs: unknown[] = [];
    const queueInputs: unknown[] = [];
    const useCase = new StartOpenSeaCollectionSyncUseCase(
        CHAIN.publicChainId,
        ENABLED_OPENSEA_INTEGRATION,
        {
            resolveChainRef() {
                return CHAIN;
            },
        },
        {
            resolveCollectionRef() {
                return COLLECTION;
            },
            resolveOpenSeaSlugOwner() {
                return null;
            },
            markOpenSeaPending(input) {
                markPendingInputs.push(input);
                return {
                    ...COLLECTION,
                    openseaSlug: input.openseaSlug,
                    openseaStatus: OPENSEA_COLLECTION_STATUS.Pending,
                    openseaLastError: null,
                };
            },
            restoreOpenSeaState() {
                return COLLECTION;
            },
        },
        {
            publishOpenSeaBootstrap(input) {
                queueInputs.push(input);
            },
        },
        slugProbePort,
    );
    return { useCase, markPendingInputs, queueInputs };
}
