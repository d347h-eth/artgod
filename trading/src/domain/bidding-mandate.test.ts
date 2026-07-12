import { describe, expect, it } from "vitest";
import { BIDDER_TARGET_TYPE, type BidderJob } from "./market/strategy/job.js";
import { BiddingMandate } from "./bidding-mandate.js";

const COLLECTION_ID = 7;
const COLLECTION_ADDRESS = "0x1111111111111111111111111111111111111111";
const OPENSEA_SLUG = "shared-contract-collection";

describe("BiddingMandate", () => {
    it("authorizes only the exact collection identity within quantity and unit caps", () => {
        const mandate = createMandate();
        const job = createCollectionJob();

        expect(() => mandate.assertOfferAuthorized(job, 20n)).not.toThrow();
        expect(() =>
            mandate.assertOfferAuthorized(
                { ...job, collectionId: COLLECTION_ID + 1 },
                20n,
            ),
        ).toThrow("is not authorized");
        expect(() =>
            mandate.assertOfferAuthorized(
                { ...job, collectionSlug: "other-opensea-collection" },
                20n,
            ),
        ).toThrow("OpenSea slug does not match");
    });

    it("rejects quantity and per-unit price above the native collection caps", () => {
        const mandate = createMandate();
        const job = createCollectionJob();

        expect(() =>
            mandate.assertOfferAuthorized(
                {
                    ...job,
                    target: {
                        type: BIDDER_TARGET_TYPE.Collection,
                        quantity: 3,
                    },
                },
                30n,
            ),
        ).toThrow("quantity 3 exceeds cap 2");
        expect(() => mandate.assertOfferAuthorized(job, 21n)).toThrow(
            "exceeds unit cap 10 for quantity 2",
        );
    });

    it("rejects an envelope mandate for a different chain", () => {
        expect(() => BiddingMandate.parse(serializedMandate(), 10)).toThrow(
            "does not match envelope chain",
        );
    });

    it("exposes a non-secret copy of the exact enforced collection authority", () => {
        expect(createMandate().snapshot()).toEqual({
            chainId: 1,
            collections: [
                {
                    collectionId: COLLECTION_ID,
                    contractAddress: COLLECTION_ADDRESS,
                    openseaSlug: OPENSEA_SLUG,
                    maxUnitBidWei: "10",
                    maxQuantity: 2,
                },
            ],
        });
    });
});

function createMandate(): BiddingMandate {
    return BiddingMandate.parse(serializedMandate(), 1);
}

function serializedMandate() {
    return {
        chainId: 1,
        collections: [
            {
                collectionId: COLLECTION_ID,
                artgodSlug: "shared-contract-art",
                contractAddress: COLLECTION_ADDRESS,
                openseaSlug: OPENSEA_SLUG,
                maxUnitBidWei: "10",
                maxQuantity: 2,
            },
        ],
    };
}

function createCollectionJob(): BidderJob {
    return {
        id: "mandate-test-job",
        revision: 1,
        network: "eth",
        collectionId: COLLECTION_ID,
        collectionAddress: COLLECTION_ADDRESS,
        collectionSlug: OPENSEA_SLUG,
        target: {
            type: BIDDER_TARGET_TYPE.Collection,
            quantity: 2,
        },
        config: {
            floor: 1n,
            ceiling: 10n,
            delta: 1n,
        },
        state: {},
    };
}
