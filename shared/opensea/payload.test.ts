import { describe, expect, it } from "vitest";
import { maxUint256, zeroAddress } from "viem";
import {
    getOpenSeaEventContract,
    getOpenSeaEventIdentifiers,
    getOpenSeaEventNft,
    getOpenSeaEventType,
    getOpenSeaOrderHash,
    getOpenSeaOrderId,
    getOpenSeaPayload,
    getOpenSeaSourceEventAt,
    OPENSEA_ORDER_HASH_STATUS,
    OPENSEA_STREAM_EVENT_TYPE,
    parseNftId,
    parseOpenSeaEnvelope,
    parseOpenSeaOrderHash,
} from "./payload.js";

const CONTRACT = "0xaabbccddaabbccddaabbccddaabbccddaabbccdd";
const SELLER = "0x1111111111111111111111111111111111111111";
const ORDER_HASH = `0x${"ab".repeat(32)}`;
const TX_HASH = `0x${"cd".repeat(32)}`;
const TIMESTAMP = "2026-09-26T03:32:47Z";

function sale() {
    return {
        event_type: OPENSEA_STREAM_EVENT_TYPE.ItemSold,
        item: { nft_id: `ethereum/${CONTRACT}/832` },
        maker: { address: SELLER },
        order_hash: ORDER_HASH,
        transaction: { hash: TX_HASH },
        event_timestamp: TIMESTAMP,
    };
}

describe("shared OpenSea payload decoding", () => {
    it.each([false, true])("decodes a sale with wrapped=%s", (wrapped) => {
        const payload = sale();
        const raw = wrapped
            ? { event_type: payload.event_type, payload }
            : payload;
        expect(parseOpenSeaEnvelope(raw)).toEqual({
            eventType: payload.event_type,
            payload,
        });
        expect(getOpenSeaPayload(raw)).toBe(payload);
        expect(getOpenSeaEventIdentifiers(raw)).toEqual({
            orderId: ORDER_HASH,
            orderHashStatus: OPENSEA_ORDER_HASH_STATUS.Present,
            nftChain: "ethereum",
            contract: CONTRACT,
            tokenId: "832",
            maker: SELLER,
            transactionHash: TX_HASH,
        });
        expect(getOpenSeaEventContract(raw)).toBe(CONTRACT);
        expect(getOpenSeaSourceEventAt(raw)).toBe(
            Date.parse(TIMESTAMP) / 1_000,
        );
    });

    it.each(["0", maxUint256.toString()])(
        "preserves uint256 NFT id %s without numeric rounding",
        (tokenId) => {
            const item = { nft_id: `ethereum/${CONTRACT}/${tokenId}` };
            expect(parseNftId(item)).toEqual({
                chain: "ethereum",
                contract: CONTRACT,
                tokenId,
            });
            expect(getOpenSeaEventNft({ ...sale(), item })?.tokenId).toBe(
                tokenId,
            );
        },
    );

    it.each([
        `ethereum/${CONTRACT}/832/trailing`,
        `ethereum/${CONTRACT}/832suffix`,
        `ethereum/${CONTRACT}/01`,
        `ethereum/${CONTRACT}/-1`,
        `ethereum/${CONTRACT}/${maxUint256 + 1n}`,
        `ethereum/${CONTRACT}/${"1".repeat(300)}`,
        `ethereum/${zeroAddress}/832`,
        "ethereum/invalid-contract/832",
        `/${CONTRACT}/832`,
    ])("rejects ambiguous or invalid NFT identity %s", (nft_id) => {
        const item = { nft_id };
        expect(() => parseNftId(item)).toThrow();
        expect(getOpenSeaEventNft({ ...sale(), item })).toBeNull();
    });

    it("uses the shared SDK/raw order-hash extraction with separate bytes32 validation", () => {
        const sdkHash = `0x${"AB".repeat(32)}`;
        expect(
            getOpenSeaOrderHash({ orderHash: sdkHash, order_hash: TX_HASH }),
        ).toBe(sdkHash);
        expect(
            getOpenSeaOrderHash({ orderHash: "", order_hash: ORDER_HASH }),
        ).toBe(ORDER_HASH);
        expect(parseOpenSeaOrderHash({ orderHash: sdkHash })).toBe(ORDER_HASH);
        expect(() => parseOpenSeaOrderHash({})).toThrow("Invalid order_hash");
        expect(
            getOpenSeaOrderId({
                event_type: OPENSEA_STREAM_EVENT_TYPE.ItemSold,
                payload: { orderHash: sdkHash },
            }),
        ).toBe(ORDER_HASH);
        expect(getOpenSeaOrderHash({ orderHash: "incomplete" })).toBe(
            "incomplete",
        );
        expect(getOpenSeaOrderId({ orderHash: "incomplete" })).toBeNull();
    });

    it("decodes string and object accounts through the same address validator", () => {
        const raw = {
            ...sale(),
            maker: `0x${CONTRACT.slice(2).toUpperCase()}`,
        };
        expect(getOpenSeaEventIdentifiers(raw).maker).toBe(CONTRACT);
        expect(
            getOpenSeaEventIdentifiers({
                ...raw,
                maker: { address: raw.maker },
            }).maker,
        ).toBe(CONTRACT);
        expect(
            getOpenSeaEventIdentifiers({ ...raw, maker: zeroAddress }).maker,
        ).toBeNull();
    });

    it("keeps usable identifiers when another field is malformed without retaining its contents", () => {
        const raw = {
            ...sale(),
            maker: "unsafe".repeat(1_000),
            order_hash: 12,
            metadata: "secret",
        };
        expect(getOpenSeaEventIdentifiers(raw)).toEqual({
            orderId: null,
            orderHashStatus: OPENSEA_ORDER_HASH_STATUS.Invalid,
            nftChain: "ethereum",
            contract: CONTRACT,
            tokenId: "832",
            maker: null,
            transactionHash: TX_HASH,
        });
    });

    it.each([
        OPENSEA_STREAM_EVENT_TYPE.CollectionOffer,
        OPENSEA_STREAM_EVENT_TYPE.TraitOffer,
    ])("routes %s by its contract criteria", (event_type) => {
        expect(
            getOpenSeaEventContract({
                event_type,
                payload: { asset_contract_criteria: { address: CONTRACT } },
            }),
        ).toBe(CONTRACT);
    });

    it("retains envelope timestamp fallback for events without a usable source timestamp", () => {
        expect(
            getOpenSeaSourceEventAt({
                event_type: OPENSEA_STREAM_EVENT_TYPE.ItemSold,
                sent_at: TIMESTAMP,
                payload: { event_timestamp: "invalid" },
            }),
        ).toBe(Date.parse(TIMESTAMP) / 1_000);
    });

    it.each([null, [], {}, { payload: sale() }])(
        "rejects missing event types in %j",
        (raw) => {
            expect(getOpenSeaEventType(raw)).toBeNull();
            expect(() => parseOpenSeaEnvelope(raw)).toThrow(
                "Invalid OpenSea payload",
            );
        },
    );
});
