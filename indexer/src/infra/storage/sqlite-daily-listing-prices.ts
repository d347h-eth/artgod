import type { db } from "@artgod/shared/database";
import { ORDER_SIDE } from "@artgod/shared/market-data/orders";
import { SqliteCurrentAsks } from "@artgod/shared/database/current-asks";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";

type Seller = {
    chain_id: number;
    collection_id: number;
    token_id: string | null;
    maker: string;
};

type PriceObservation = {
    id: number;
    orderId: string | null;
    price: string;
    currency: string | null;
    amount: string | null;
    observedAt: number;
};

/** Shared daily-price writes. Orderbook refreshes affect only today's existing
 * rows; historical observations carry their own price and observation time.
 * No current ask means keep the last known price, never create or delete a row. */
export class SqliteDailyListingPrices {
    private readonly asks: SqliteCurrentAsks;
    private readonly row;
    private readonly update;
    private readonly selectOrder;
    private readonly selectDay;
    private day = -1;
    private cursor = 0;

    constructor(
        private readonly database: Pick<typeof db, "raw" | "writeTransaction">,
        currencies: readonly string[],
    ) {
        const conn = database.raw;
        this.asks = new SqliteCurrentAsks(conn, currencies);
        this.row = conn.prepare(
            "SELECT id,order_id,price,currency,amount,listing_price_at FROM activities WHERE chain_id=? AND collection_id=? AND token_id=? AND maker=? AND listing_day=?",
        );
        this.update = conn.prepare(
            "UPDATE activities SET order_id=@orderId,price=@price,currency=@currency,amount=@amount,listing_price_at=@observedAt," +
                "updated_at=CASE WHEN (price,currency,amount) IS NOT (@price,@currency,@amount) THEN CURRENT_TIMESTAMP ELSE updated_at END " +
                "WHERE id=@id AND COALESCE(listing_price_at,0)<=@observedAt " +
                "AND ((price,currency,amount) IS NOT (@price,@currency,@amount) OR COALESCE(listing_price_at,0)<@observedAt)",
        );
        this.selectOrder = conn.prepare(
            `SELECT chain_id,collection_id,token_id,maker FROM orders WHERE chain_id=? AND id=? AND side='${ORDER_SIDE.Sell}'`,
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
        if (update) this.recordPrice(update);
    }

    /** Newer observations advance ordering even at the same price. Otherwise a
     * delayed historical event could replace a more recently observed price. */
    recordPrice(observation: PriceObservation): void {
        this.update.run(observation);
    }

    private priceUpdate(seller: Seller, now: number): PriceObservation | null {
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
                  listing_price_at: number | null;
              }
            | undefined;
        if (!row) return null;
        const ask = this.bestAsk(seller, now);
        if (
            !ask ||
            (row.price === ask.price &&
                row.currency === ask.currency &&
                row.amount === ask.quantity &&
                (row.listing_price_at ?? 0) >= now)
        )
            return null;
        return {
            id: row.id,
            orderId: ask.id,
            price: ask.price,
            currency: ask.currency,
            amount: ask.quantity,
            observedAt: now,
        };
    }

    /** The cursor resumes on the next bounded pass if the current one runs out of time. */
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
        if (rows.length)
            this.database.writeTransaction(() => {
                // Read the orderbook only after acquiring the writer. A REST
                // reconciliation committed meanwhile must win, including within
                // the same second. Retries recompute from the latest state.
                for (const seller of rows) this.refreshSeller(seller, now);
            })();
        this.cursor = rows.at(-1)?.id ?? 0;
        return rows.length;
    }
}
