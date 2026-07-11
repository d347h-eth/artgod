import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { Scope, Type, MarketEvent } from "../domain/market/event.js";
import {
    BIDDER_TARGET_TYPE,
    type BidderJob,
} from "../domain/market/strategy/job.js";
import {
    collectSnapshotBackedCollectionSlugs,
    collectTokenWarmCandidateCount,
    collectWatchedCollectionSlugs,
    createCriteriaOfferRefreshReasonResolver,
    formatOpenSeaStreamSocketError,
} from "./bidding-runtime.js";

function makeJob(
    id: string,
    collectionSlug: string,
    target: BidderJob["target"],
): BidderJob {
    return {
        id,
        revision: 1,
        network: "eth",
        collectionId: 1,
        collectionAddress: "0x0000000000000000000000000000000000000001",
        collectionSlug,
        target,
        config: {
            floor: 1n,
            ceiling: 2n,
            delta: 1n,
        },
        state: {},
    };
}

function makeTraitOfferEvent(
    collectionSlug: string,
    traitCriteria: Array<{ type: string; value: string }>,
): MarketEvent {
    const event = new MarketEvent(
        new Date().toISOString(),
        Type.TraitOffer,
        "0xhash",
        collectionSlug,
        "",
        "0xother",
        1,
        "WETH",
        18,
        Scope.Trait,
        traitCriteria,
    );
    event.setTotalPrice(1n);
    return event;
}

describe("bidding runtime helpers", () => {
    it("collects watched collections from all job targets without duplicates", () => {
        const jobs = [
            makeJob("token-a", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "1",
            }),
            makeJob("collection-a", "terraforms", {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
            }),
            makeJob("trait-a", "otherdeed", {
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
                quantity: 1,
                targetTrait: {
                    type: "Environment",
                    value: "Volcanic",
                },
                competitorTraits: [{ type: "Environment" }],
            }),
        ];

        assert.deepEqual(collectWatchedCollectionSlugs(jobs), [
            "terraforms",
            "otherdeed",
        ]);
    });

    it("collects snapshot-backed collections only for token and collection jobs", () => {
        const jobs = [
            makeJob("token-a", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "1",
            }),
            makeJob("collection-a", "otherdeed", {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
            }),
            makeJob("trait-a", "grails", {
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
                quantity: 1,
                targetTrait: {
                    type: "Background",
                    value: "Gold",
                },
                competitorTraits: [{ type: "Background" }],
            }),
        ];

        assert.deepEqual(collectSnapshotBackedCollectionSlugs(jobs), [
            "terraforms",
            "otherdeed",
        ]);
    });

    it("counts token warm candidates from token jobs only", () => {
        const jobs = [
            makeJob("token-a", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "1",
            }),
            makeJob("token-b", "terraforms", {
                type: BIDDER_TARGET_TYPE.Token,
                tokenId: "2",
            }),
            makeJob("collection-a", "otherdeed", {
                type: BIDDER_TARGET_TYPE.Collection,
                quantity: 1,
            }),
        ];

        assert.equal(collectTokenWarmCandidateCount(jobs), 2);
    });

    it("creates snapshot refresh reasons only for watched trait offers", () => {
        const resolver = createCriteriaOfferRefreshReasonResolver({
            terraforms: ["Biome", "Zone"],
        });

        assert.equal(
            resolver(
                makeTraitOfferEvent("terraforms", [
                    { type: "Biome", value: "Shard" },
                    { type: "Level", value: "5" },
                ]),
            ),
            "eventType=trait_offer, matchedTraits=Biome",
        );
        assert.equal(
            resolver(
                makeTraitOfferEvent("terraforms", [
                    { type: "Level", value: "5" },
                ]),
            ),
            null,
        );
        assert.equal(
            resolver(
                makeTraitOfferEvent("otherdeed", [
                    { type: "Biome", value: "Shard" },
                ]),
            ),
            null,
        );
    });

    it("formats OpenSea stream ErrorEvent-like socket errors for structured logs", () => {
        const formatted = formatOpenSeaStreamSocketError({
            type: "error",
            defaultPrevented: false,
            cancelable: false,
            timeStamp: 123.45,
        });

        assert.equal(formatted.detail, "type=error");
        assert.deepEqual(formatted.meta, {
            errorType: "error",
            defaultPrevented: false,
            cancelable: false,
            timeStamp: 123.45,
        });
    });

    it("formats real OpenSea stream errors without relying on object inspection", () => {
        const formatted = formatOpenSeaStreamSocketError(
            new Error("stream disconnected"),
        );

        assert.equal(formatted.detail, "Error: stream disconnected");
        assert.deepEqual(formatted.meta, {
            errorName: "Error",
            errorMessage: "stream disconnected",
        });
    });
});
