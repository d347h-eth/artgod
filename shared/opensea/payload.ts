import { maxUint256, zeroAddress } from "viem";
import {
    asRecord,
    asObject,
    assertAddress,
    assertString,
    parseTimestamp,
    tryParseAddress,
    tryParseHash,
} from "../offchain/normalizer-utils.js";

export const OPENSEA_STREAM_EVENT_TYPE = {
    ItemListed: "item_listed",
    ItemSold: "item_sold",
    ItemTransferred: "item_transferred",
    ItemReceivedBid: "item_received_bid",
    ItemReceivedOffer: "item_received_offer",
    ItemCancelled: "item_cancelled",
    ItemMetadataUpdated: "item_metadata_updated",
    CollectionOffer: "collection_offer",
    TraitOffer: "trait_offer",
    OrderInvalidate: "order_invalidate",
    OrderInvalidation: "order_invalidation",
    OrderRevalidate: "order_revalidate",
    OrderRevalidation: "order_revalidation",
} as const;

export const OPENSEA_ORDER_HASH_STATUS = {
    Present: "present",
    Missing: "missing",
    Invalid: "invalid",
} as const;

export type OpenSeaNftId = { chain: string; contract: string; tokenId: string };

/** One NFT-id decoder for routing, order normalization and market-event hints. */
export function parseNftId(value: unknown): OpenSeaNftId {
    const item = asObject(value, "item");
    const nftId = assertString(item.nft_id, "item.nft_id");
    // Bound the chain, address and decimal uint256 before splitting or BigInt.
    if (nftId.length > 186) throw new Error("Invalid nft_id length");
    const parts = nftId.split("/");
    if (parts.length !== 3 || !/^[a-z0-9_-]{1,64}$/.test(parts[0]!))
        throw new Error("Invalid nft_id: expected chain/contract/tokenId");
    const contract = assertAddress(parts[1], "item.nft_id.contract");
    const tokenId = parts[2]!;
    if (
        contract === zeroAddress ||
        !/^(0|[1-9]\d{0,77})$/.test(tokenId) ||
        BigInt(tokenId) > maxUint256
    )
        throw new Error(
            "Invalid nft_id: expected NFT contract and uint256 tokenId",
        );
    return { chain: parts[0]!, contract, tokenId };
}

export function getOpenSeaEventNft(raw: unknown): OpenSeaNftId | null {
    try {
        return parseNftId(getOpenSeaPayload(raw).item);
    } catch {
        return null;
    }
}

export function parseOpenSeaEnvelope(raw: unknown): {
    eventType: string;
    payload: Record<string, unknown>;
} {
    const eventType = getOpenSeaEventType(raw);
    if (!eventType) throw new Error("Invalid OpenSea payload");
    return { eventType, payload: getOpenSeaPayload(raw) };
}

export function getOpenSeaEventType(raw: unknown): string | null {
    const envelope = asRecord(raw);
    return typeof envelope.event_type === "string" ? envelope.event_type : null;
}

export function getOpenSeaOrderId(raw: unknown): string | null {
    return tryParseHash(getOpenSeaOrderHash(getOpenSeaPayload(raw)));
}

// SDK camelCase and raw API snake_case share extraction; callers own validation.
export function getOpenSeaOrderHash(raw: unknown): string | null {
    const value = readOrderHash(raw);
    return typeof value === "string" && value.length > 0 ? value : null;
}

/** Required order identity for existing listing/lifecycle normalization. */
export function parseOpenSeaOrderHash(raw: unknown): string {
    return assertString(getOpenSeaOrderHash(raw), "order_hash").toLowerCase();
}

function readOrderHash(raw: unknown): unknown {
    const record = asRecord(raw);
    return typeof record.orderHash === "string" && record.orderHash.length > 0
        ? record.orderHash
        : record.order_hash;
}

/** Bounded identifiers for deduplication and diagnostics, never arbitrary source data. */
export function getOpenSeaEventIdentifiers(raw: unknown) {
    const payload = getOpenSeaPayload(raw);
    const nft = getOpenSeaEventNft(raw);
    const orderId = getOpenSeaOrderId(raw);
    const orderHash = readOrderHash(payload);
    const maker = tryParseAddress(payload.maker);
    return {
        orderId,
        orderHashStatus: orderId
            ? OPENSEA_ORDER_HASH_STATUS.Present
            : orderHash == null ||
                (typeof orderHash === "string" && orderHash.trim() === "")
              ? OPENSEA_ORDER_HASH_STATUS.Missing
              : OPENSEA_ORDER_HASH_STATUS.Invalid,
        nftChain: nft?.chain ?? null,
        contract: nft?.contract ?? null,
        tokenId: nft?.tokenId ?? null,
        maker: maker === zeroAddress ? null : maker,
        transactionHash: tryParseHash(asRecord(payload.transaction).hash),
    };
}

export function getOpenSeaPayload(raw: unknown): Record<string, unknown> {
    const envelope = asRecord(raw);
    const payload = envelope.payload;
    return payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : envelope;
}

export function getOpenSeaEventContract(raw: unknown): string | null {
    const eventType = getOpenSeaEventType(raw);
    const payload = getOpenSeaPayload(raw);

    if (!eventType) return null;

    if (
        eventType === OPENSEA_STREAM_EVENT_TYPE.CollectionOffer ||
        eventType === OPENSEA_STREAM_EVENT_TYPE.TraitOffer
    ) {
        const criteria = asRecord(payload.asset_contract_criteria);
        return tryParseAddress(criteria.address);
    }

    return getOpenSeaEventNft(raw)?.contract ?? null;
}

export function getOpenSeaSourceEventAt(raw: unknown): number | null {
    const envelope = asRecord(raw);
    const payload = getOpenSeaPayload(raw);
    const candidates = [
        payload.event_timestamp,
        envelope.sent_at,
        payload.created_date,
        payload.listing_date,
        payload.expiration_date,
    ];
    for (const value of candidates) {
        if (typeof value !== "string") continue;
        try {
            return parseTimestamp(value, "OpenSea event");
        } catch {
            // Optional malformed timestamps allow the next source fallback.
        }
    }
    return null;
}
