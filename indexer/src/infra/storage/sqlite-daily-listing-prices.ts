import type { BetterSqlite3Database } from "@artgod/shared/database";
import { SqliteCurrentAsks } from "@artgod/shared/database/current-asks";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";

type Seller = {
    chain_id: number;
    collection_id: number;
    token_id: string | null;
    maker: string;
};

/** Updates only today's existing feed rows. No ask means keep the last known
 * price; a new day never rewrites previous days or creates an activity itself. */
export class SqliteDailyListingPrices {
    private readonly asks: SqliteCurrentAsks;
    private readonly row;
    private readonly update;
    private readonly selectOrder;
    private readonly selectDay;
    private day = -1;
    private cursor = 0;

    constructor(
        private readonly conn: BetterSqlite3Database,
        currencies: readonly string[],
    ) {
        this.asks = new SqliteCurrentAsks(conn, currencies);
        this.row = conn.prepare(
            "SELECT id,order_id,price,currency,amount FROM activities WHERE chain_id=? AND collection_id=? AND token_id=? AND maker=? AND listing_day=?",
        );
        this.update = conn.prepare(
            "UPDATE activities SET order_id=?,price=?,currency=?,amount=?,listing_price_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        );
        this.selectOrder = conn.prepare(
            "SELECT chain_id,collection_id,token_id,maker FROM orders WHERE chain_id=? AND id=? AND side='sell'",
        );
        this.selectDay = conn.prepare(
            "SELECT id,chain_id,collection_id,token_id,maker FROM activities WHERE listing_day=? AND id>? ORDER BY id LIMIT ?",
        );
    }

    bestAsk(seller: Seller, now: number) {
        return seller.token_id
            ? this.asks.forSeller(
                  seller.chain_id,
                  seller.collection_id,
                  seller.token_id,
                  seller.maker,
                  now,
              )
            : undefined;
    }

    refreshOrder(chainId: number, orderId: string, now: number): void {
        const seller = this.selectOrder.get(chainId, orderId) as
            | Seller
            | undefined;
        if (seller) this.refreshSeller(seller, now);
    }

    refreshSeller(seller: Seller, now: number): void {
        const update = this.priceUpdate(seller, now);
        if (update) this.update.run(...update);
    }

    private priceUpdate(seller: Seller, now: number): unknown[] | null {
        if (!seller.token_id) return null;
        const row = this.row.get(
            seller.chain_id,
            seller.collection_id,
            seller.token_id,
            seller.maker,
            Math.floor(now / POLICY.utcDaySeconds),
        ) as
            | {
                  id: number;
                  order_id: string | null;
                  price: string | null;
                  currency: string | null;
                  amount: string | null;
              }
            | undefined;
        if (!row) return null;
        const ask = this.bestAsk(seller, now);
        if (
            !ask ||
            (row.price === ask.price &&
                row.currency === ask.currency &&
                row.amount === ask.quantity)
        )
            return null;
        return [ask.id, ask.price, ask.currency, ask.quantity, now, row.id];
    }

    /** The cursor resumes next interval if the runtime's overall budget expires. */
    refreshBatch(now: number): number {
        const day = Math.floor(now / POLICY.utcDaySeconds);
        if (day !== this.day) {
            this.day = day;
            this.cursor = 0;
        }
        const rows = this.selectDay.all(
            day,
            this.cursor,
            POLICY.maintenanceBatchRows,
        ) as (Seller & { id: number })[];
        const updates = rows
            .map((row) => this.priceUpdate(row, now))
            .filter((value): value is unknown[] => value !== null);
        if (updates.length)
            this.conn
                .transaction(() => {
                    for (const values of updates) this.update.run(...values);
                })
                .immediate();
        this.cursor = rows.at(-1)?.id ?? 0;
        return rows.length;
    }
}
