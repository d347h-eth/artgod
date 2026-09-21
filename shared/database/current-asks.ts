import type Database from "better-sqlite3";

/** Integer prices are compared as decimal strings, never floating point. */
export function normalizedAskPriceSql(alias: string): string {
    const price = alias ? `${alias}.price` : "price";
    return `CASE WHEN LTRIM(${price}, '0') = '' THEN '0' ELSE LTRIM(${price}, '0') END`;
}

function eligibleAskSql(alias: string): string {
    const p = alias ? `${alias}.` : "";
    return `${p}source_scope_kind='token' AND ${p}side='sell' AND ${p}source_status='active' AND ${p}fillability_status='fillable' AND ${p}token_id IS NOT NULL AND ${p}price IS NOT NULL AND ${p}price<>'' AND ${p}price NOT GLOB '*[^0-9]*'`;
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
    private readonly select: Database.Statement;
    constructor(
        conn: Database.Database,
        private readonly currencies: readonly string[],
    ) {
        this.select = conn.prepare(
            "SELECT id,price,currency,quantity FROM orders WHERE id=(" +
                currentAskIdSql({
                    chain: "?",
                    collection: "?",
                    token: "?",
                    maker: "?",
                    currencyCount: currencies.length,
                }) +
                ")",
        );
    }

    forSeller(
        chainId: number,
        collectionId: number,
        tokenId: string,
        maker: string,
        now: number,
    ): CurrentAsk | undefined {
        return this.select.get(
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
