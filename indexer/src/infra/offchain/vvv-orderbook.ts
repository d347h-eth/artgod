import { zeroAddress } from "viem";
import { JSONParser, TokenType } from "@streamparser/json";
import {
    asObject,
    assertAddress,
} from "@artgod/shared/offchain/normalizer-utils";
import {
    SEAPORT_MAINNET_V1_6,
    ORDER_SIDE,
    ORDER_SOURCE_SCOPE_KIND,
} from "@artgod/shared/market-data/orders";
import {
    cashBidAmounts,
    settlementIdentity,
    type BookMarket,
    type BookObservation,
} from "../../domain/orderbook.js";
import {
    decodeSeaportComponents,
    extractSeaportSellTerms,
} from "../../application/offchain/seaport-order-data.js";
import {
    computeSeaportOrderHash,
    recoverSeaportSigner,
} from "../../application/offchain/seaport-protocol.js";

export {
    VVV_MARKET,
    VVV_MARKETS,
    type VvvMarketLocation,
} from "./vvv-markets.js";

export const VVV_BOOK_LIMIT_BYTES = 32 * 1024 * 1024;
const ACTIVE = "active";

function verifyVvvMarket(
    market: BookMarket,
    chainId: unknown,
    contract: unknown,
) {
    if (
        chainId !== market.chainId ||
        assertAddress(contract, "contract") !== market.contract.toLowerCase()
    )
        throw new Error("Invalid VVV book identity");
}

/** A read must finish with the correct public identity before it can replace membership. */
export async function consumeVvvBook(
    market: BookMarket,
    book: unknown,
    consume: (observation: BookObservation) => void,
) {
    const response = asObject(book, "VVV book");
    verifyVvvMarket(market, response.chainId, response.contract);
    if (!Array.isArray(response.orders))
        throw new Error("Invalid VVV orders array");
    for (const record of response.orders) {
        const observation = await translateOrder(
            market,
            asObject(record, "VVV order"),
        );
        if (observation) consume(observation);
    }
}

/** Only completed public order objects enter private staging. Identity fields
 * may follow the orders in JSON, so the caller publishes only after EOF. */
export async function consumeVvvBookStream(
    market: BookMarket,
    chunks: AsyncIterable<string>,
    consume: (observation: BookObservation) => void,
) {
    const parser = new JSONParser({
        paths: ["$.chainId", "$.contract", "$.orders", "$.orders.*"],
        keepStack: false,
    });
    const fields = new Map<string, unknown>();
    const rows: Record<string, unknown>[] = [];
    let previousToken: TokenType | undefined;
    parser.onToken = ({ token }) => {
        // Discarded object properties cannot distinguish an empty object from
        // a trailing comma in the streaming parser's retained stack.
        if (
            previousToken === TokenType.COMMA &&
            (token === TokenType.RIGHT_BRACE ||
                token === TokenType.RIGHT_BRACKET)
        )
            throw new Error("Invalid trailing comma in VVV book");
        previousToken = token;
    };
    parser.onValue = ({ key, value, parent, stack }) => {
        if (stack.length === 2) {
            if (!Array.isArray(parent) || typeof key !== "number")
                throw new Error("Invalid VVV orders array");
            rows.push(asObject(value, "VVV order"));
            delete parent[key];
        } else if (typeof key === "string") {
            if (fields.has(key))
                throw new Error("Duplicate VVV book field " + key);
            if (key === "orders" && !Array.isArray(value))
                throw new Error("Invalid VVV orders array");
            fields.set(key, key === "orders" ? true : value);
        }
    };
    for await (const chunk of chunks) {
        parser.write(chunk);
        for (const row of rows) {
            const observation = await translateOrder(market, row);
            if (observation) consume(observation);
        }
        rows.length = 0;
    }
    if (!parser.isEnded) parser.end();
    if (!fields.has("orders")) throw new Error("Missing VVV orders array");
    verifyVvvMarket(market, fields.get("chainId"), fields.get("contract"));
}

async function translateOrder(
    market: BookMarket,
    record: Record<string, unknown>,
): Promise<BookObservation | null> {
    if (
        typeof record.hash !== "string" ||
        !/^0x[0-9a-f]{64}$/i.test(record.hash)
    )
        throw new Error("Missing VVV order identity");
    if (
        typeof record.fillable !== "boolean" ||
        typeof record.status !== "string"
    )
        throw new Error("Invalid VVV availability");
    const nativeId = record.hash.toLowerCase();
    const observation: BookObservation = {
        nativeId,
        placement: market,
        settlementId: null,
        status: record.status,
        fillable: record.fillable && record.status === ACTIVE,
        audience:
            record.counterparty == null
                ? null
                : assertAddress(record.counterparty, "counterparty"),
        sourceTime:
            typeof record.updatedAt === "number" &&
            Number.isSafeInteger(record.updatedAt)
                ? record.updatedAt
                : null,
        order: null,
        fees: null,
        proceeds: null,
    };
    try {
        const data = decodeSeaportComponents(
            SEAPORT_MAINNET_V1_6,
            record.order,
        );
        const givesNft = data.offer.some((item) => Number(item.itemType) >= 2);
        if (
            givesNft &&
            data.consideration.some((item) => Number(item.itemType) >= 2)
        )
            return null;
        const bid = givesNft ? null : cashBidAmounts(data);
        const ask = givesNft ? extractSeaportSellTerms(data) : null;
        const nft = givesNft ? data.offer[0] : bid?.target;
        if (
            !nft ||
            nft.itemType !== "2" ||
            nft.startAmount !== "1" ||
            nft.endAmount !== "1" ||
            nft.token !== market.contract ||
            (!bid && !ask) ||
            (givesNft && data.offer.length !== 1) ||
            (bid && bid.target.recipient !== data.offerer) ||
            !["0", "1"].includes(data.orderType) ||
            data.zone !== zeroAddress ||
            BigInt(data.totalOriginalConsiderationItems) !==
                BigInt(data.consideration.length)
        )
            return observation;
        if (
            computeSeaportOrderHash(data).toLowerCase() !== nativeId ||
            assertAddress(record.offerer, "offerer") !== data.offerer ||
            (await recoverSeaportSigner(market.chainId, data)).toLowerCase() !==
                data.offerer
        )
            return observation;
        observation.settlementId = settlementIdentity(
            market.chainId,
            data.protocolAddress,
            nativeId,
        );
        observation.order = {
            orderId: nativeId,
            kind: "seaport",
            side: givesNft ? ORDER_SIDE.Sell : ORDER_SIDE.Buy,
            maker: data.offerer,
            contract: nft.token,
            tokenId: nft.identifierOrCriteria,
            sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
            quantity: "1",
            currency: ask?.currency ?? bid!.currency,
            price: ask?.price ?? bid!.gross.toString(),
            validFrom: Number(data.startTime),
            validUntil: Number(data.endTime),
            seaportData: data,
        };
        observation.fees = bid?.fees.toString() ?? null;
        observation.proceeds = bid?.proceeds.toString() ?? null;
    } catch {
        // A malformed signature/terms disqualifies this identifiable placement.
        // Its presence still participates in the next authoritative difference.
    }
    return observation;
}
