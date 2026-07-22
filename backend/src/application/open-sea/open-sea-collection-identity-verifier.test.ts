import { describe, expect, it } from "vitest";
import { OpenSeaCollectionIdentityVerifier } from "./open-sea-collection-identity-verifier.js";

const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_CONTRACT_ADDRESS = "0x2222222222222222222222222222222222222222";
const COLLECTION_SLUG = "gumbo-by-mathias-isaksen";

describe("OpenSeaCollectionIdentityVerifier", () => {
    it("discovers a shared-contract collection through its first token and verifies both boundaries", async () => {
        const tokenRequests: string[] = [];
        const verifier = new OpenSeaCollectionIdentityVerifier({
            async resolveCollectionSlugByContract() {
                throw new Error("contract lookup should not run");
            },
            async resolveCollectionBySlug(input) {
                expect(input).toEqual({ slug: COLLECTION_SLUG });
                return {
                    slug: COLLECTION_SLUG,
                    contractAddresses: [CONTRACT_ADDRESS],
                };
            },
            async resolveCollectionSlugByToken(input) {
                expect(input.address).toBe(CONTRACT_ADDRESS);
                tokenRequests.push(input.tokenId);
                return COLLECTION_SLUG;
            },
        });

        await expect(
            verifier.resolveVerifiedSlug({
                address: CONTRACT_ADDRESS,
                requestedSlug: null,
                verificationTokenIds: ["462000000", "462000399"],
            }),
        ).resolves.toBe(COLLECTION_SLUG);
        expect(tokenRequests).toEqual(["462000000", "462000399"]);
    });

    it("verifies an entered slug against its contract and token boundaries", async () => {
        const verifier = new OpenSeaCollectionIdentityVerifier({
            async resolveCollectionSlugByContract() {
                return "unrelated-contract-default";
            },
            async resolveCollectionBySlug() {
                return {
                    slug: COLLECTION_SLUG,
                    contractAddresses: [CONTRACT_ADDRESS],
                };
            },
            async resolveCollectionSlugByToken() {
                return COLLECTION_SLUG;
            },
        });

        await expect(
            verifier.resolveVerifiedSlug({
                address: CONTRACT_ADDRESS,
                requestedSlug: COLLECTION_SLUG,
                verificationTokenIds: ["462000000", "462000399"],
            }),
        ).resolves.toBe(COLLECTION_SLUG);
    });

    it("rejects a collection that does not list the submitted contract", async () => {
        const verifier = new OpenSeaCollectionIdentityVerifier({
            async resolveCollectionSlugByContract() {
                return null;
            },
            async resolveCollectionBySlug() {
                return {
                    slug: COLLECTION_SLUG,
                    contractAddresses: [OTHER_CONTRACT_ADDRESS],
                };
            },
            async resolveCollectionSlugByToken() {
                throw new Error("token lookup should not run");
            },
        });

        await expect(
            verifier.resolveVerifiedSlug({
                address: CONTRACT_ADDRESS,
                requestedSlug: COLLECTION_SLUG,
                verificationTokenIds: ["462000000"],
            }),
        ).resolves.toBeNull();
    });

    it("rejects a sibling collection when a scope boundary resolves elsewhere", async () => {
        const verifier = new OpenSeaCollectionIdentityVerifier({
            async resolveCollectionSlugByContract() {
                return null;
            },
            async resolveCollectionBySlug() {
                return {
                    slug: COLLECTION_SLUG,
                    contractAddresses: [CONTRACT_ADDRESS],
                };
            },
            async resolveCollectionSlugByToken(input) {
                return input.tokenId === "462000000"
                    ? COLLECTION_SLUG
                    : "sibling-collection";
            },
        });

        await expect(
            verifier.resolveVerifiedSlug({
                address: CONTRACT_ADDRESS,
                requestedSlug: COLLECTION_SLUG,
                verificationTokenIds: ["462000000", "462000399"],
            }),
        ).resolves.toBeNull();
    });

    it("uses contract discovery when no representative token is available", async () => {
        const verifier = new OpenSeaCollectionIdentityVerifier({
            async resolveCollectionSlugByContract(input) {
                expect(input).toEqual({ address: CONTRACT_ADDRESS });
                return COLLECTION_SLUG;
            },
            async resolveCollectionBySlug() {
                return {
                    slug: COLLECTION_SLUG,
                    contractAddresses: [CONTRACT_ADDRESS],
                };
            },
            async resolveCollectionSlugByToken() {
                throw new Error("token lookup should not run");
            },
        });

        await expect(
            verifier.resolveVerifiedSlug({
                address: CONTRACT_ADDRESS,
                requestedSlug: null,
                verificationTokenIds: [],
            }),
        ).resolves.toBe(COLLECTION_SLUG);
    });
});
