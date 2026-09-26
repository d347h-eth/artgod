import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@artgod/shared/utils";
import { dispatchOffchainPayload } from "../src/application/offchain/dispatch.js";
import {
    normalizeOpenSeaMakerUpdate,
    normalizeOpenSeaOrderUpdate,
} from "../src/application/offchain/opensea-normalize.js";
import {
    getOpenSeaSaleDiagnosticContext,
    OPENSEA_SALE_EVENT_TYPE,
    OPENSEA_SALE_HASH_STATUS,
    OPENSEA_SALE_LOG,
} from "../src/application/offchain/opensea-sale.js";
import { getOpenSeaStreamDedupeKey } from "../src/application/offchain/opensea-stream-identity.js";
import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    OFFCHAIN_ORDER_SOURCE,
    type OffchainOrderRawPayload,
} from "../src/domain/offchain-jobs.js";
import {
    MAKER_TRIGGER_SCOPE,
    ORDER_JOB_KIND,
    ORDER_UPDATE_REASON,
} from "../src/domain/order-jobs.js";
import { TOKEN_SCOPED_MAKER_TRIGGER_REASON } from "../src/domain/maker-triggers.js";
import { ORDER_SOURCE_STATUS } from "../src/domain/orders.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { QueuePort } from "../src/ports/queue.js";
import type { TokenSetRegistryPort } from "../src/ports/token-sets.js";
import { resolveFixturePath } from "./helpers/fixture-paths.js";

const SELLER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const CONTRACT = "0x3333333333333333333333333333333333333333";
const TX_HASH = `0x${"44".repeat(32)}`;
const ORDER_HASH = `0x${"55".repeat(32)}`;
const RECEIVED_AT = 1_790_393_567_000;
const tokenSets: TokenSetRegistryPort = {
    ensureTokenSet: () => {
        throw new Error("A sale must not create token sets");
    },
};

// Synthetic incomplete event; none of the six historical raw payloads survived.
function sale(payload: Record<string, unknown> = {}) {
    return {
        event_type: OPENSEA_SALE_EVENT_TYPE,
        payload: {
            item: { nft_id: `ethereum/${CONTRACT}/832` },
            maker: { address: SELLER },
            transaction: { hash: TX_HASH },
            event_timestamp: new Date(RECEIVED_AT).toISOString(),
            ...payload,
        },
    };
}

function observation(event = sale()): OffchainOrderRawPayload {
    return {
        source: OFFCHAIN_ORDER_SOURCE.OpenSea,
        channel: OFFCHAIN_OBSERVATION_CHANNEL.Stream,
        chainId: 1,
        collectionId: 9,
        receivedAt: RECEIVED_AT,
        sourceEventAt: RECEIVED_AT / 1_000,
        eventType: event.event_type,
        dedupeKey: getOpenSeaStreamDedupeKey(event, RECEIVED_AT),
        payload: event,
    };
}

function queueCapture() {
    const publish = vi.fn<QueuePort["publish"]>().mockResolvedValue(undefined);
    const queue: QueuePort = {
        publish,
        subscribe: async () => {
            throw new Error("Unexpected subscription");
        },
        close: async () => {},
    };
    return { queue, publish };
}

beforeEach(() => vi.spyOn(logger, "warn").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("incomplete OpenSea sales", () => {
    it.each([undefined, null, "", "   ", 123, "not-a-hash", "0x1234"])(
        "queues only token revalidation for unusable hash %j",
        async (order_hash) => {
            const { queue, publish } = queueCapture();
            expect(
                await dispatchOffchainPayload(
                    queue,
                    tokenSets,
                    observation(sale({ order_hash })),
                ),
            ).toEqual({
                handled: true,
                upsertedOrderId: null,
            });
            expect(publish).toHaveBeenCalledExactlyOnceWith(
                QUEUE_NAMES.OrdersUpdateByToken,
                expect.objectContaining({
                    kind: ORDER_JOB_KIND.UpdateByMaker,
                    payload: {
                        chainId: 1,
                        collectionId: 9,
                        scope: MAKER_TRIGGER_SCOPE.Token,
                        contract: CONTRACT,
                        maker: SELLER,
                        tokenId: "832",
                        reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.ItemSold,
                    },
                }),
            );
            expect(logger.warn).toHaveBeenCalledWith(
                OPENSEA_SALE_LOG.RevalidationQueued,
                expect.objectContaining({
                    transactionHash: TX_HASH,
                    contract: CONTRACT,
                    tokenId: "832",
                    maker: SELLER,
                }),
            );
        },
    );

    it("preserves exact fill and token fanout when the hash is valid", async () => {
        const { queue, publish } = queueCapture();
        await dispatchOffchainPayload(
            queue,
            tokenSets,
            observation(sale({ order_hash: ORDER_HASH })),
        );
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish).toHaveBeenNthCalledWith(
            1,
            QUEUE_NAMES.OrderLifecycle,
            expect.objectContaining({
                payload: expect.objectContaining({
                    orderId: ORDER_HASH,
                    reason: ORDER_UPDATE_REASON.Fill,
                    sourceStatus: ORDER_SOURCE_STATUS.Filled,
                }),
            }),
        );
        expect(publish.mock.calls[1]![0]).toBe(QUEUE_NAMES.OrdersUpdateByToken);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it.each([
        { maker: null },
        { maker: { address: "bad" } },
        { maker: `0x${"00".repeat(20)}` },
        { item: {} },
        { item: { nft_id: `ethereum/${CONTRACT}/832/extra` } },
        { item: { nft_id: `ethereum/${CONTRACT}/-1` } },
        { item: { nft_id: `ethereum/${CONTRACT}/01` } },
        { item: { nft_id: `ethereum/${CONTRACT}/${2n ** 256n}` } },
    ])("rejects unsafe recovery identifiers %j", async (payload) => {
        const { queue, publish } = queueCapture();
        await expect(
            dispatchOffchainPayload(
                queue,
                tokenSets,
                observation(sale(payload)),
            ),
        ).rejects.toThrow("Invalid OpenSea sale");
        expect(publish).not.toHaveBeenCalled();
    });

    it("propagates publication failure so the raw job is retried", async () => {
        const { queue, publish } = queueCapture();
        publish.mockRejectedValueOnce(new Error("queue unavailable"));
        const raw = observation();
        await expect(
            dispatchOffchainPayload(queue, tokenSets, raw),
        ).rejects.toThrow("queue unavailable");
        expect(logger.warn).not.toHaveBeenCalled();
        await dispatchOffchainPayload(queue, tokenSets, raw);
        expect(publish.mock.calls[0]![1].jobId).toBe(
            publish.mock.calls[1]![1].jobId,
        );
        expect(logger.warn).toHaveBeenCalledOnce();
    });

    it("uses the captured sale seller even when the Seaport offerer is the buyer", async () => {
        const fixture = JSON.parse(
            await fs.readFile(
                resolveFixturePath(
                    import.meta.url,
                    "opensea-event-payloads",
                    "item_sold.json",
                ),
                "utf8",
            ),
        );
        delete fixture.payload.order_hash;
        expect(fixture.payload.maker.address).not.toBe(
            fixture.payload.protocol_data.parameters.offerer,
        );
        expect(normalizeOpenSeaOrderUpdate(fixture)).toBeNull();
        expect(normalizeOpenSeaMakerUpdate(fixture)?.maker).toBe(
            fixture.payload.maker.address,
        );
    });

    it("does not make missing hashes optional for cancellations", () => {
        expect(() =>
            normalizeOpenSeaOrderUpdate({
                event_type: "item_cancelled",
                payload: {},
            }),
        ).toThrow("Invalid order_hash");
    });
});

describe("sale identity and diagnostics", () => {
    it("deduplicates repeated hints but separates tokens, sellers and transactions in the same second", () => {
        const first = getOpenSeaStreamDedupeKey(sale(), RECEIVED_AT);
        expect(
            getOpenSeaStreamDedupeKey(
                sale({ order_hash: null }),
                RECEIVED_AT + 10,
            ),
        ).toBe(first);
        for (const payload of [
            { item: { nft_id: `ethereum/${CONTRACT}/833` } },
            { transaction: { hash: `0x${"66".repeat(32)}` } },
            { maker: { address: BUYER } },
        ])
            expect(
                getOpenSeaStreamDedupeKey(sale(payload), RECEIVED_AT),
            ).not.toBe(first);
    });

    it("keeps the existing key for hashed sales and other event types", () => {
        expect(
            getOpenSeaStreamDedupeKey(
                sale({ order_hash: ORDER_HASH }),
                RECEIVED_AT,
            ),
        ).toBe(
            `${OFFCHAIN_OBSERVATION_CHANNEL.Stream}:${OPENSEA_SALE_EVENT_TYPE}:${ORDER_HASH}:${RECEIVED_AT / 1_000}`,
        );
        expect(
            getOpenSeaStreamDedupeKey(
                {
                    event_type: "item_cancelled",
                    payload: { order_hash: ORDER_HASH },
                },
                RECEIVED_AT,
            ),
        ).toBe(
            `${OFFCHAIN_OBSERVATION_CHANNEL.Stream}:item_cancelled:${ORDER_HASH}:${RECEIVED_AT}`,
        );
    });

    it("does not collapse unidentifiable malformed sales before diagnosis", () => {
        const raw = sale({ maker: null });
        expect(getOpenSeaStreamDedupeKey(raw, RECEIVED_AT)).not.toBe(
            getOpenSeaStreamDedupeKey(raw, RECEIVED_AT),
        );
    });

    it("retains bounded usable identities even if a different field is malformed", () => {
        const unsafe = "sensitive-unbounded-source-string".repeat(1_000);
        const diagnostic = getOpenSeaSaleDiagnosticContext(
            observation(
                sale({
                    maker: { address: unsafe },
                    order_hash: unsafe,
                    transaction: { hash: TX_HASH, explorer_url: unsafe },
                    metadata: unsafe,
                    protocol_data: { signature: unsafe },
                }),
            ),
        );
        expect(diagnostic).toEqual({
            chainId: 1,
            collectionId: 9,
            sourceEventAt: RECEIVED_AT / 1_000,
            orderId: null,
            orderHashStatus: OPENSEA_SALE_HASH_STATUS.Invalid,
            nftChain: "ethereum",
            contract: CONTRACT,
            tokenId: "832",
            maker: null,
            transactionHash: TX_HASH,
        });
        expect(JSON.stringify(diagnostic).length).toBeLessThan(600);
        expect(getOpenSeaSaleDiagnosticContext(null)).toBeNull();
        expect(
            getOpenSeaSaleDiagnosticContext({
                ...observation(),
                channel: OFFCHAIN_OBSERVATION_CHANNEL.Snapshot,
            }),
        ).toBeNull();
        expect(getOpenSeaSaleDiagnosticContext(observation())).toMatchObject({
            orderHashStatus: OPENSEA_SALE_HASH_STATUS.Missing,
        });
    });
});
