import { describe, expect, it } from "vitest";
import type { OpenSeaContractLookupPort } from "@artgod/shared/network/opensea-contract-lookup";
import {
    OpenSeaApiAdapter,
    type OpenSeaRestRecord,
} from "../src/infra/offchain/opensea-api.js";

const CONTRACT = "0x5af0d9827e0c53e4799bb226655a1de152a425a5";
const SEAPORT = "0x0000000000000068f116a894984e2db1123eb395";
const MAKER = "0xcdbef8775bba8578b8c7e89071b9d2ee3c336296";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("OpenSeaApiAdapter", () => {
    it("resolves collections through the shared contract lookup client", async () => {
        const requests: string[] = [];
        const adapter = createAdapter({
            contractLookup: {
                async resolveCollectionByContract(input) {
                    requests.push(input.address);
                    return { slug: "milady-maker" };
                },
            },
        });

        await expect(
            adapter.instance.resolveCollectionByContract(CONTRACT),
        ).resolves.toEqual({ slug: "milady-maker" });
        expect(requests).toEqual([CONTRACT]);
    });

    it("emits raw listing records with rest.listing type", async () => {
        const listing = buildListingRecord();
        const adapter = createAdapter();
        adapter.api = {
            getAllListings: async () => ({
                listings: [listing],
                next: undefined,
            }),
        };

        const events: OpenSeaRestRecord[] = [];
        await adapter.instance.forEachListing(
            "test-collection",
            CONTRACT,
            async (event) => {
                events.push(event);
            },
        );

        expect(events).toHaveLength(1);
        expect(events[0]?.eventType).toBe("rest.listing");
        expect(events[0]?.payload).toEqual(listing);
    });

    it("emits raw offer records with rest offer types", async () => {
        const itemOffer = buildItemOfferRecord();
        const collectionOffer = buildCollectionOfferRecord();
        const numericTraitOffer = buildNumericTraitOfferRecord();
        const adapter = createAdapter();
        adapter.api = {
            getAllOffers: async () => ({
                offers: [itemOffer, collectionOffer, numericTraitOffer],
                next: undefined,
            }),
        };

        const events: OpenSeaRestRecord[] = [];
        await adapter.instance.forEachOffer(
            "test-collection",
            CONTRACT,
            async (event) => {
                events.push(event);
            },
        );

        expect(events).toHaveLength(3);
        expect(events[0]?.eventType).toBe("rest.offer.item");
        expect(events[1]?.eventType).toBe("rest.offer.collection");
        expect(events[2]?.eventType).toBe("rest.offer.trait");
        for (const [index, source] of [
            itemOffer,
            collectionOffer,
            numericTraitOffer,
        ].entries()) {
            expect(events[index]?.payload).toEqual(source);
        }
    });
});

type CreateAdapterOptions = {
    contractLookup?: OpenSeaContractLookupPort;
};

function createAdapter(options: CreateAdapterOptions = {}): {
    instance: OpenSeaApiAdapter;
    api: Record<string, unknown>;
} {
    const instance = new OpenSeaApiAdapter(
        {
            apiKey: "test-api-key",
            snapshotPageSize: 50,
            retryPolicy: {
                maxAttempts: 1,
                baseDelayMs: 1,
                maxDelayMs: 1,
                jitterRatio: 0,
            },
            rateLimiter: {
                getMax: 100,
                getRefillPerSecond: 100,
                postMax: 1,
                postRefillPerSecond: 1,
            },
        },
        options.contractLookup,
    ) as OpenSeaApiAdapter & { api: Record<string, unknown> };

    return {
        instance,
        get api() {
            return instance.api;
        },
        set api(value: Record<string, unknown>) {
            instance.api = value;
        },
    };
}

function buildListingRecord(): Record<string, unknown> {
    return {
        status: "ACTIVE",
        order_hash:
            "0x27c086e5028d11931d7fa0bc47762dbf22d3cee845d2cc9191d7686f0a2bcc9b",
        protocol_address: SEAPORT,
        protocol_data: buildListingProtocolData(),
        price: {
            current: {
                value: "989199990000000000",
            },
        },
        remaining_quantity: 1,
        type: "basic",
    };
}

function buildItemOfferRecord(): Record<string, unknown> {
    return {
        status: "ACTIVE",
        order_hash:
            "0xca2f030878888d975a62f94f5abcceda4b7b075e836eb112d1b9008ac0d22eaa",
        protocol_address: SEAPORT,
        protocol_data: buildItemOfferProtocolData(),
        price: {
            value: "3310000000000000000",
        },
        criteria: {},
    };
}

function buildCollectionOfferRecord(): Record<string, unknown> {
    return {
        status: "ACTIVE",
        order_hash:
            "0xde046c3273a8811e32a52de3b2c705366e67e27115793382c84ef865fc36d941",
        protocol_address: SEAPORT,
        protocol_data: buildCollectionOfferProtocolData(),
        price: {
            value: "1200000000000000000",
        },
        criteria: {
            contract: {
                address: CONTRACT,
            },
        },
    };
}

function buildNumericTraitOfferRecord(): Record<string, unknown> {
    return {
        ...buildCollectionOfferRecord(),
        order_hash:
            "0xe42d30d10b52ac6e813d3ecb2e14bf79ccc61db4c65fc89d70cacb2ae9cfae52",
        criteria: {
            contract: {
                address: CONTRACT,
            },
            numeric_traits: [{ type: "Biome", min: 42, max: 42 }],
            encoded_token_ids: "1,2,3",
        },
    };
}

function buildListingProtocolData(): Record<string, unknown> {
    return {
        parameters: {
            offerer: MAKER,
            zone: ZERO_ADDRESS,
            offer: [
                {
                    itemType: 2,
                    token: CONTRACT,
                    identifierOrCriteria: "2522",
                    startAmount: "1",
                    endAmount: "1",
                },
            ],
            consideration: [
                {
                    itemType: 0,
                    token: ZERO_ADDRESS,
                    identifierOrCriteria: "0",
                    startAmount: "989199990000000000",
                    endAmount: "989199990000000000",
                    recipient: MAKER,
                },
            ],
            orderType: "0",
            startTime: "1700000000",
            endTime: "1800000000",
            zoneHash: ZERO_BYTES32,
            salt: "1",
            conduitKey: ZERO_BYTES32,
            totalOriginalConsiderationItems: "1",
            counter: "0",
        },
    };
}

function buildItemOfferProtocolData(): Record<string, unknown> {
    return {
        parameters: {
            offerer: MAKER,
            zone: ZERO_ADDRESS,
            offer: [
                {
                    itemType: 1,
                    token: WETH,
                    identifierOrCriteria: "0",
                    startAmount: "3310000000000000000",
                    endAmount: "3310000000000000000",
                },
            ],
            consideration: [
                {
                    itemType: 2,
                    token: CONTRACT,
                    identifierOrCriteria: "5788",
                    startAmount: "1",
                    endAmount: "1",
                    recipient: MAKER,
                },
            ],
            orderType: "0",
            startTime: "1700000000",
            endTime: "1800000000",
            zoneHash: ZERO_BYTES32,
            salt: "2",
            conduitKey: ZERO_BYTES32,
            totalOriginalConsiderationItems: "1",
            counter: "0",
        },
    };
}

function buildCollectionOfferProtocolData(): Record<string, unknown> {
    return {
        parameters: {
            offerer: MAKER,
            zone: ZERO_ADDRESS,
            offer: [
                {
                    itemType: 1,
                    token: WETH,
                    identifierOrCriteria: "0",
                    startAmount: "1200000000000000000",
                    endAmount: "1200000000000000000",
                },
            ],
            consideration: [
                {
                    itemType: 4,
                    token: CONTRACT,
                    identifierOrCriteria: "0",
                    startAmount: "1",
                    endAmount: "1",
                    recipient: MAKER,
                },
            ],
            orderType: "0",
            startTime: "1700000000",
            endTime: "1800000000",
            zoneHash: ZERO_BYTES32,
            salt: "3",
            conduitKey: ZERO_BYTES32,
            totalOriginalConsiderationItems: "1",
            counter: "0",
        },
    };
}
