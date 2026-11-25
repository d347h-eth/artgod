import type Database from "better-sqlite3";
import {
    CollectionTokenScope,
    COLLECTION_TOKEN_SCOPE_KIND,
} from "../collections/token-scope.js";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SIDE,
} from "../market-data/orders.js";

/** Integer prices are compared as decimal strings, never floating point. */
export function normalizedAskPriceSql(alias: string): string {
    const price = alias ? `${alias}.price` : "price";
    return `CASE WHEN LTRIM(${price}, '0') = '' THEN '0' ELSE LTRIM(${price}, '0') END`;
}

function eligibleAskSql(alias: string): string {
    const p = alias ? `${alias}.` : "";
    return `${p}source_scope_kind='${ORDER_SOURCE_SCOPE_KIND.Token}' AND ${p}side='${ORDER_SIDE.Sell}' AND ${p}source_status='${ORDER_SOURCE_STATUS.Active}' AND ${p}fillability_status='${ORDER_STATUS.Fillable}' AND ${p}token_id IS NOT NULL AND ${p}price IS NOT NULL AND ${p}price<>'' AND ${p}price NOT GLOB '*[^0-9]*'`;
}

// These indexes bound a best-price lookup to one token (optionally one seller).
// Validity is checked at read time too, so expiry does not wait for housekeeping.
export const CURRENT_ASK_INDEX_SQL = [
    ["orders_current_token_ask_idx", "chain_id,collection_id,token_id"],
    ["orders_current_seller_ask_idx", "chain_id,collection_id,token_id,maker"],
]
    .map(
        ([name, scope]) =>
            `CREATE INDEX IF NOT EXISTS ${name} ON orders(${scope},LENGTH(${normalizedAskPriceSql("")}),${normalizedAskPriceSql("")},currency,id,valid_from,valid_until) WHERE ${eligibleAskSql("")};`,
    )
    .join("\n");

/** A page expires when publication, settlement, or a validity boundary changes. */
export function collectionMarketVersion(
    conn: Database.Database,
    chainId: number,
    collectionId: number,
    now: number,
): string {
    // A broad bid can establish the collection floor in several local ranges.
    const nextBoundary = (
        column: "valid_from" | "valid_until",
    ) => `(SELECT MIN(boundary) FROM (
        SELECT MIN(${column}) AS boundary FROM orders WHERE chain_id=@chain AND collection_id=@collection AND ${column}>@now
        UNION ALL SELECT MIN(o.${column}) FROM orderbook_offer_scopes s JOIN orderbook_members m USING(feed_id,native_id)
        JOIN orders o ON o.id=m.settlement_id AND o.winning_feed_id=m.feed_id
        WHERE s.collection_id=@collection AND m.present=1 AND o.collection_id<>@collection AND o.${column}>@now))`;
    const row = conn
        .prepare(
            `SELECT market_revision AS revision, ${nextBoundary("valid_from")} AS start,
        ${nextBoundary("valid_until")} AS expiry FROM collections WHERE chain_id=@chain AND collection_id=@collection`,
        )
        .get({ chain: chainId, collection: collectionId, now });
    return JSON.stringify(row ?? null);
}

const TOKEN_IN_RANGE = "artgod_token_in_range";
const registeredConnections = new WeakSet<Database.Database>();

/** SQLite integer arithmetic cannot represent every ERC-721 token ID. */
export function registerOrderbookScopeFunction(conn: Database.Database): void {
    if (registeredConnections.has(conn)) return;
    conn.function(
        TOKEN_IN_RANGE,
        { deterministic: true },
        (start: string, count: number, token: string) =>
            Number(
                CollectionTokenScope.tokenRange(start, count).containsToken(
                    token,
                ),
            ),
    );
    registeredConnections.add(conn);
}

/** Check the binding and the current declared scope even between successful reads. */
export function hasCurrentOrderBindingSql(alias: string): string {
    const kind = COLLECTION_TOKEN_SCOPE_KIND;
    return `(${alias}.order_hash IS NULL OR EXISTS (
        SELECT 1 FROM orderbook_bindings b JOIN collections c USING(collection_id)
        WHERE b.feed_id=${alias}.winning_feed_id AND b.collection_id=${alias}.collection_id
        AND (CASE WHEN ${alias}.token_id IS NULL OR c.token_scope_kind='${kind.AllContractTokens}' THEN 1
                  WHEN c.token_scope_kind='${kind.TokenRange}' THEN ${TOKEN_IN_RANGE}(c.scope_start_token_id,c.scope_total_supply,${alias}.token_id)
                  ELSE EXISTS (SELECT 1 FROM collection_scope_tokens s WHERE s.chain_id=c.chain_id AND s.collection_id=c.collection_id AND s.token_id=${alias}.token_id) END)))`;
}

/** Scope expressions are adapter-owned SQL, not request input. Bindings after
 * scope are currencies, current time for valid_from, then current time for expiry. */
export function currentAskIdSql(scope: {
    chain: string;
    collection: string;
    token: string;
    maker?: string;
    currencyCount: number;
}): string {
    if (!Number.isSafeInteger(scope.currencyCount) || scope.currencyCount < 1)
        throw new Error("Current asks require supported listing currencies");
    return (
        `SELECT ask.id FROM orders ask WHERE ask.chain_id=${scope.chain} AND ask.collection_id=${scope.collection} AND ask.token_id=${scope.token} ` +
        (scope.maker ? `AND ask.maker=${scope.maker} ` : "") +
        `AND ${eligibleAskSql("ask")} AND ask.currency IN (${Array(scope.currencyCount).fill("?").join(",")}) ` +
        "AND " +
        hasCurrentOrderBindingSql("ask") +
        " " +
        "AND (ask.valid_from IS NULL OR ask.valid_from<=?) AND (ask.valid_until IS NULL OR ask.valid_until>?) " +
        `ORDER BY LENGTH(${normalizedAskPriceSql("ask")}),${normalizedAskPriceSql("ask")},ask.currency,ask.id LIMIT 1`
    );
}

export type CurrentAsk = {
    id: string;
    price: string;
    currency: string;
    quantity: string | null;
};

/** Shared best-ask selection for stored daily prices and collection cards. */
export class SqliteCurrentAsks {
    private select?: Database.Statement;
    constructor(
        private readonly conn: Database.Database,
        private readonly currencies: readonly string[],
    ) {
        registerOrderbookScopeFunction(conn);
    }
    private sellerStatement() {
        return (this.select ??= this.conn.prepare(
            "SELECT id,price,currency,COALESCE(remaining_quantity,quantity) AS quantity FROM orders WHERE id=(" +
                currentAskIdSql({
                    chain: "?",
                    collection: "?",
                    token: "?",
                    maker: "?",
                    currencyCount: this.currencies.length,
                }) +
                ")",
        ));
    }

    forSeller(
        chainId: number,
        collectionId: number,
        tokenId: string,
        maker: string,
        now: number,
    ): CurrentAsk | undefined {
        return this.sellerStatement().get(
            chainId,
            collectionId,
            tokenId,
            maker,
            ...this.currencies,
            now,
            now,
        ) as CurrentAsk | undefined;
    }
}
