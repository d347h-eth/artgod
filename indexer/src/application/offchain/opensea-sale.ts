import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    OFFCHAIN_ORDER_SOURCE,
} from "../../domain/offchain-jobs.js";
import { getOpenSeaEventType, getOpenSeaPayload } from "./opensea-envelope.js";

export const OPENSEA_SALE_EVENT_TYPE = "item_sold";
export const OPENSEA_SALE_HASH_STATUS = {
    Present: "present",
    Missing: "missing",
    Invalid: "invalid",
} as const;
export const OPENSEA_SALE_LOG = {
    Component: "OpenSeaSale",
    RevalidationQueued:
        "OpenSea sale queued for token revalidation without a usable order hash",
    Action: "queueTokenRevalidation",
} as const;

/** Identifiers only: never retain arbitrary source strings or the raw payload. */
export function getOpenSeaSaleIdentifiers(raw: unknown) {
    const payload = getOpenSeaPayload(raw);
    const item = asRecord(payload.item);
    const nftId = typeof item.nft_id === "string" ? item.nft_id : "";
    // EVM NFT ids use a decimal uint256. Bound the input before splitting or BigInt.
    const parts = nftId.length <= 186 ? nftId.split("/") : [];
    const nftChain =
        parts.length === 3 && /^[a-z0-9_-]{1,64}$/.test(parts[0]!)
            ? parts[0]!
            : null;
    const contract = nftChain ? address(parts[1]) : null;
    const tokenId = contract ? uint256(parts[2]) : null;
    const orderId = hash(payload.order_hash);
    const orderHashStatus = orderId
        ? OPENSEA_SALE_HASH_STATUS.Present
        : payload.order_hash == null ||
            (typeof payload.order_hash === "string" &&
                payload.order_hash.trim() === "")
          ? OPENSEA_SALE_HASH_STATUS.Missing
          : OPENSEA_SALE_HASH_STATUS.Invalid;
    return {
        orderId,
        orderHashStatus,
        nftChain,
        contract,
        tokenId,
        // OpenSea's sale maker is the seller, including when accepting a bid.
        // The Seaport offerer can be the buyer and must not replace this field.
        maker: address(
            typeof payload.maker === "string"
                ? payload.maker
                : asRecord(payload.maker).address,
        ),
        transactionHash: hash(asRecord(payload.transaction).hash),
    };
}

export function requireOpenSeaSaleToken(raw: unknown) {
    const { maker, contract, tokenId } = getOpenSeaSaleIdentifiers(raw);
    if (!contract || tokenId === null) {
        throw new Error(
            "Invalid OpenSea sale nft_id: expected chain/contract/uint256",
        );
    }
    if (!maker) {
        throw new Error("Invalid OpenSea sale maker: expected seller address");
    }
    return { maker, contract, tokenId };
}

/** Safe even for malformed raw jobs being logged by the dead-letter consumer. */
export function getOpenSeaSaleDiagnosticContext(raw: unknown) {
    const observation = asRecord(raw);
    if (
        observation.source !== OFFCHAIN_ORDER_SOURCE.OpenSea ||
        observation.channel !== OFFCHAIN_OBSERVATION_CHANNEL.Stream ||
        getOpenSeaEventType(observation.payload) !== OPENSEA_SALE_EVENT_TYPE
    )
        return null;
    return {
        chainId: positiveInteger(observation.chainId),
        collectionId: positiveInteger(observation.collectionId),
        sourceEventAt: positiveInteger(observation.sourceEventAt),
        ...getOpenSeaSaleIdentifiers(observation.payload),
    };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function address(value: unknown): string | null {
    return typeof value === "string" &&
        /^0x[\da-f]{40}$/i.test(value) &&
        !/^0x0{40}$/i.test(value)
        ? value.toLowerCase()
        : null;
}

function hash(value: unknown): string | null {
    return typeof value === "string" && /^0x[\da-f]{64}$/i.test(value)
        ? value.toLowerCase()
        : null;
}

function uint256(value: unknown): string | null {
    return typeof value === "string" &&
        /^(0|[1-9]\d{0,77})$/.test(value) &&
        BigInt(value) < 2n ** 256n
        ? value
        : null;
}

function positiveInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : null;
}
