import { Chain, OpenSeaAPI } from "@opensea/sdk";
import { normalizeOpenSeaOfferTraitCriteria } from "@artgod/shared/trading/open-sea-bidding-offers";
import type { OpenSeaHttpConfig } from "@artgod/shared/config/opensea-http";
import {
    OpenSeaApiRateLimiter,
    retryOpenSeaApiCall,
} from "@artgod/shared/network/opensea-api-resilience";

export type OpenSeaApiConfig = {
    apiKey: string;
    snapshotPageSize: number;
} & OpenSeaHttpConfig;

export type OpenSeaResolvedCollection = {
    slug: string;
};

export type OpenSeaRestRecord = {
    eventType: string;
    orderId: string;
    sourceEventAt: number | null;
    payload: Record<string, unknown>;
};

type ListingRecord = Record<string, unknown>;
type OfferRecord = Record<string, unknown>;

// Logger component label emitted by the indexer OpenSea REST adapter.
const OPENSEA_API_ADAPTER_LOG_COMPONENT = "OpenSeaApiAdapter";
const NFT_ITEM_TYPES = new Set([2, 3, 4, 5]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class OpenSeaApiAdapter {
    private readonly api: OpenSeaAPI;
    private readonly rateLimiter: OpenSeaApiRateLimiter;
    private readonly pageSize: number;
    private readonly retryPolicy: OpenSeaHttpConfig["retryPolicy"];

    constructor(config: OpenSeaApiConfig) {
        this.api = new OpenSeaAPI({
            apiKey: config.apiKey,
            chain: Chain.Mainnet,
        });
        this.rateLimiter = new OpenSeaApiRateLimiter(config.rateLimiter);
        this.pageSize = Math.max(1, config.snapshotPageSize);
        this.retryPolicy = config.retryPolicy;
    }

    async resolveCollectionByContract(
        contractAddress: string,
    ): Promise<OpenSeaResolvedCollection | null> {
        const response = await this.withGetCost("getContract", () =>
            this.api.getContract(contractAddress, Chain.Mainnet),
        );
        if (!response?.collection) {
            return null;
        }
        return { slug: String(response.collection) };
    }

    async forEachListing(
        collectionSlug: string,
        contractAddress: string,
        handler: (record: OpenSeaRestRecord) => Promise<void>,
    ): Promise<void> {
        let cursor: string | undefined;

        do {
            const response = await this.withGetCost("getAllListings", () =>
                this.api.getAllListings(
                    collectionSlug,
                    this.pageSize,
                    cursor,
                    false,
                ),
            );
            const listings = asArray(response?.listings);
            for (const entry of listings) {
                const listing = asRecord(entry);
                if (!isActiveStatus(listing.status)) continue;
                const record = toRestListingRecord(listing, contractAddress);
                if (!record) continue;
                await handler(record);
            }
            cursor =
                typeof response?.next === "string" ? response.next : undefined;
        } while (cursor);
    }

    async forEachOffer(
        collectionSlug: string,
        contractAddress: string,
        handler: (record: OpenSeaRestRecord) => Promise<void>,
    ): Promise<void> {
        let cursor: string | undefined;

        do {
            const response = await this.withGetCost("getAllOffers", () =>
                this.api.getAllOffers(collectionSlug, this.pageSize, cursor),
            );
            const offers = asArray(response?.offers);
            for (const entry of offers) {
                const offer = asRecord(entry);
                if (!isActiveStatus(offer.status)) continue;
                const record = toRestOfferRecord(offer, contractAddress);
                if (!record) continue;
                await handler(record);
            }
            cursor =
                typeof response?.next === "string" ? response.next : undefined;
        } while (cursor);
    }

    private async withGetCost<T>(
        action: string,
        fn: () => Promise<T>,
    ): Promise<T> {
        await this.rateLimiter.wait(1, 0);
        return retryOpenSeaApiCall({
            component: OPENSEA_API_ADAPTER_LOG_COMPONENT,
            action,
            retryPolicy: this.retryPolicy,
            call: fn,
        });
    }
}

function toRestListingRecord(
    listing: ListingRecord,
    contractAddress: string,
): OpenSeaRestRecord | null {
    const parameters = getProtocolParameters(listing.protocol_data);
    const nftItem = findNftItem(asArray(parameters.offer));
    if (!nftItem) return null;

    const contract = String(nftItem.token ?? "").toLowerCase();
    if (contract !== contractAddress.toLowerCase()) return null;

    const tokenId = identifierToString(nftItem.identifierOrCriteria);
    if (!tokenId) return null;

    const paymentItem = findPaymentItem(asArray(parameters.consideration));
    const orderHash = stringOrNull(listing.order_hash);
    if (!orderHash) return null;

    const eventTimestamp = unixToIso(parameters.startTime);

    return {
        eventType: "rest.listing",
        orderId: orderHash.toLowerCase(),
        sourceEventAt: isoToUnix(eventTimestamp),
        payload: listing,
    };
}

function toRestOfferRecord(
    offer: OfferRecord,
    contractAddress: string,
): OpenSeaRestRecord | null {
    const parameters = getProtocolParameters(offer.protocol_data);
    const orderHash = stringOrNull(offer.order_hash);
    if (!orderHash) return null;
    const eventTimestamp = unixToIso(parameters.startTime);

    const criteria = asRecord(offer.criteria);
    const criteriaContract = stringOrNull(asRecord(criteria.contract).address);
    if (
        criteriaContract &&
        criteriaContract.toLowerCase() !== contractAddress.toLowerCase()
    ) {
        return null;
    }

    if (criteriaContract) {
        const traits = normalizeCriteriaTraits(criteria);
        if (traits.length === 0) {
            return {
                eventType: "rest.offer.collection",
                orderId: orderHash.toLowerCase(),
                sourceEventAt: isoToUnix(eventTimestamp),
                payload: offer,
            };
        }

        return {
            eventType: "rest.offer.trait",
            orderId: orderHash.toLowerCase(),
            sourceEventAt: isoToUnix(eventTimestamp),
            payload: offer,
        };
    }

    const nftItem = findNftItem(asArray(parameters.consideration));
    if (!nftItem) return null;
    const contract = String(nftItem.token ?? "").toLowerCase();
    if (contract !== contractAddress.toLowerCase()) return null;

    const tokenId = identifierToString(nftItem.identifierOrCriteria);
    if (!tokenId) return null;

    return {
        eventType: "rest.offer.item",
        orderId: orderHash.toLowerCase(),
        sourceEventAt: isoToUnix(eventTimestamp),
        payload: offer,
    };
}

function getProtocolParameters(value: unknown): Record<string, unknown> {
    const protocol = asRecord(value);
    return asRecord(protocol.parameters);
}

function normalizeCriteriaTraits(
    criteria: Record<string, unknown>,
): Array<{ trait_type: string; trait_name: string }> {
    return normalizeOpenSeaOfferTraitCriteria(criteria).map((trait) => ({
        trait_type: trait.type,
        trait_name: trait.value,
    }));
}

function findNftItem(
    items: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
    for (const item of items) {
        const itemType = Number(item.itemType);
        if (!Number.isFinite(itemType) || !NFT_ITEM_TYPES.has(itemType)) {
            continue;
        }
        return item;
    }
    return null;
}

function findPaymentItem(
    items: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
    for (const item of items) {
        const itemType = Number(item.itemType);
        if (!Number.isFinite(itemType) || itemType > 1) continue;
        return item;
    }
    return null;
}

function identifierToString(value: unknown): string | null {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    if (typeof value === "bigint") return value.toString();
    return null;
}

function isoToUnix(value: string | null): number | null {
    if (!value) return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 1000);
}

function unixToIso(value: unknown): string | null {
    const text = stringOrNull(value);
    if (!text) return null;
    try {
        const seconds = BigInt(text);
        return new Date(Number(seconds) * 1000).toISOString();
    } catch {
        return null;
    }
}

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
}

function asArray(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) return [];
    return value
        .filter((entry) => !!entry && typeof entry === "object")
        .map((entry) => entry as Record<string, unknown>);
}

function isActiveStatus(value: unknown): boolean {
    return String(value ?? "").toUpperCase() === "ACTIVE";
}
