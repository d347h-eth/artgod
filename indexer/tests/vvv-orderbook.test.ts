import { describe, it, expect } from "vitest";
import { zeroAddress } from "viem";
import {
    consumeVvvBook,
    VVV_MARKET,
} from "../src/infra/offchain/vvv-orderbook.js";
import { openSeaObservation } from "../src/application/offchain/opensea-orderbook-sync.js";
import {
    BOOK_VIEW,
    cashBidAmounts,
    settlementIdentity,
    type BookObservation,
} from "../src/domain/orderbook.js";
import { computeSeaportOrderHash } from "../src/application/offchain/seaport-protocol.js";
import { ORDERBOOK_VENUE } from "@artgod/shared/market-data/orders";
import captured from "./fixtures/vvv-cash-book.json" with { type: "json" };

async function translate(book: unknown) {
    const rows: BookObservation[] = [];
    await consumeVvvBook(VVV_MARKET, book, (r) => rows.push(r));
    return rows;
}
describe("VVV public cash orders", () => {
    it("verifies both signed orders, retains the unsigned counterparty and shares a settlement identity with OpenSea", async () => {
        const [ask, bid] = await translate(captured);
        expect(ask!.order!.price).toBe("130585000000000000");
        expect(bid).toMatchObject({
            fillable: true,
            audience: captured.orders[1]!.counterparty?.toLowerCase(),
            fees: "819000000000000",
            proceeds: "90590500000000000",
            order: { price: "91409500000000000" },
        });
        const os = {
            ...VVV_MARKET,
            view: BOOK_VIEW.Public,
            venue: ORDERBOOK_VENUE.OpenSea,
        };
        const duplicate = await openSeaObservation(
            os,
            bid!.nativeId,
            bid!.order,
            bid!.sourceTime,
        );
        expect(duplicate.settlementId).toBe(bid!.settlementId);
        expect(duplicate.proceeds).toBe(bid!.proceeds);
        const data = bid!.order!.seaportData!;
        expect(
            computeSeaportOrderHash({
                ...data,
                salt: (BigInt(data.salt) + 1n).toString(),
            }),
        ).not.toBe(bid!.nativeId);
        expect(settlementIdentity(1, zeroAddress, bid!.nativeId)).not.toBe(
            bid!.settlementId,
        );
        expect(
            (
                await openSeaObservation(
                    os,
                    bid!.nativeId,
                    { ...bid!.order!, taker: captured.contract },
                    null,
                )
            ).order,
        ).toBeNull();
    });
    it("requires local proof when an OpenSea record labels a signed criterion as an exact token", async () => {
        const [, bid] = await translate(captured);
        const order = bid!.order!;
        const data = structuredClone(order.seaportData!);
        const nft = data.consideration.find(
            (item) => item.token === captured.contract,
        )!;
        nft.itemType = "4";
        data.signature = null;
        const market = { ...VVV_MARKET, venue: ORDERBOOK_VENUE.OpenSea };
        const claimed = await openSeaObservation(
            market,
            computeSeaportOrderHash(data),
            { ...order, seaportData: data },
            null,
        );
        expect(claimed.fillable).toBe(false);
        expect(claimed.order).toBeNull();
    });
    it("keeps barter out of orders and rejects unverifiable terms, wrong markets and incomplete books", async () => {
        const bid = captured.orders[1]!;
        const different = structuredClone(bid);
        different.order.parameters.salt = "15";
        expect(
            (await translate({ ...captured, orders: [different] }))[0]!.order,
        ).toBeNull();
        const barter = structuredClone(captured.orders[0]!);
        barter.order.parameters.consideration[0]!.itemType = 2;
        expect(await translate({ ...captured, orders: [barter] })).toEqual([]);
        for (const book of [
            { ...captured, contract: zeroAddress },
            { ...captured, chainId: 2 },
            { ...captured, orders: null },
            { ...captured, orders: [{}] },
        ])
            await expect(translate(book)).rejects.toThrow();
    });
    it("requires fixed homogeneous payments and exact divisibility for partial cash offers", async () => {
        const [, bid] = await translate(captured);
        const terms = structuredClone(bid!.order!.seaportData!);
        const currency = terms.offer[0]!.token;
        terms.offer[0]!.startAmount = terms.offer[0]!.endAmount = "100";
        const fee = terms.consideration.find((i) => i.token === currency)!;
        fee.startAmount = fee.endAmount = "10";
        const nft = terms.consideration.find(
            (i) => i.token === captured.contract,
        )!;
        nft.startAmount = nft.endAmount = "2";
        terms.consideration = [nft, fee];
        expect(cashBidAmounts(terms)?.proceeds).toBe(45n);
        fee.endAmount = "11";
        expect(cashBidAmounts(terms)).toBeNull();
        fee.startAmount = fee.endAmount = "9";
        expect(cashBidAmounts(terms)).toBeNull();
    });
});
