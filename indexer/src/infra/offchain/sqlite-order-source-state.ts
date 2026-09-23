import { db } from "@artgod/shared/database";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import { ORDER_SIDE, ORDER_SOURCE_STATUS } from "../../domain/orders.js";
import type { SqliteDailyListingPrices } from "../storage/sqlite-daily-listing-prices.js";
import type {
    OrderSourceStatePort,
    OrderSourceObservation,
} from "../../application/offchain/opensea-orderbook-sync.js";

let nextObservation = 0;

/** Streaming membership is connection-local, not a JS payload array or durable receipt archive. */
export class SqliteOrderSourceStateStore implements OrderSourceStatePort {
    constructor(
        private readonly listingPrices: Pick<
            SqliteDailyListingPrices,
            "refreshSeller"
        >,
        private readonly nowSeconds = () => Math.floor(Date.now() / 1000),
    ) {}

    beginObservation(input: {
        chainId: number;
        collectionId: number;
        source: string;
        startedAt: number;
    }): OrderSourceObservation {
        // Names are generated locally, never interpolated from source/user input.
        const name = `market_observation_${++nextObservation}`;
        const missing = `${name}_missing`;
        db.raw.transaction(() =>
            db.raw.exec(
                `CREATE TEMP TABLE ${name}(id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TEMP TABLE ${missing}(id TEXT PRIMARY KEY) WITHOUT ROWID;`,
            ),
        )();
        const insert = db.raw.prepare(
            `INSERT OR IGNORE INTO ${name}(id) VALUES (?)`,
        );
        const admitted = () =>
            !!db
                .prepare<
                    [number, number]
                >("SELECT 1 FROM collections WHERE chain_id=? AND collection_id=?")
                .get(input.chainId, input.collectionId);
        let closed = false;
        let completed = false;
        // Unchanged stream observations coalesce their timestamp writes. Leave
        // that whole freshness bucket alone rather than mark a recently seen
        // order inactive because it was absent from an older REST page.
        const observedThrough =
            input.startedAt - POLICY.orderRevalidationSeconds;
        const listingPrices = this.listingPrices;
        const nowSeconds = this.nowSeconds;
        return {
            recordActiveOrder(orderId) {
                if (closed || completed || !admitted()) return false;
                insert.run(orderId.toLowerCase());
                return true;
            },
            async complete() {
                if (closed || completed || !admitted()) return 0;
                completed = true;
                // Freeze only identities. Each short write transaction rechecks
                // eligibility so a stream observation during the crawl wins.
                db.raw
                    .prepare(
                        `INSERT INTO ${missing}(id) SELECT o.id FROM orders o WHERE chain_id=? AND collection_id=? AND source=? AND source_status=? AND observed_at<=? AND NOT EXISTS(SELECT 1 FROM ${name} a WHERE a.id=o.id)`,
                    )
                    .run(
                        input.chainId,
                        input.collectionId,
                        input.source,
                        ORDER_SOURCE_STATUS.Active,
                        observedThrough,
                    );
                let changed = 0;
                let after = "";
                const select = db.raw.prepare(
                    `SELECT id FROM ${missing} WHERE id>? ORDER BY id LIMIT ?`,
                );
                const update = db.raw.prepare(
                    "UPDATE orders SET source_status=?,observed_at=MAX(observed_at,?),state_revision=state_revision+1,updated_at=CURRENT_TIMESTAMP " +
                        "WHERE id=? AND chain_id=? AND collection_id=? AND source=? AND source_status=? AND observed_at<=? RETURNING side,token_id,maker",
                );
                while (!closed) {
                    const rows = select.all(
                        after,
                        POLICY.maintenanceBatchRows,
                    ) as { id: string }[];
                    if (!rows.length) break;
                    changed += db.writeTransaction(() => {
                        if (!admitted()) return 0;
                        let count = 0;
                        const sellers = new Map<
                            string,
                            { token_id: string; maker: string }
                        >();
                        for (const row of rows) {
                            const changedOrder = update.get(
                                ORDER_SOURCE_STATUS.Inactive,
                                input.startedAt,
                                row.id,
                                input.chainId,
                                input.collectionId,
                                input.source,
                                ORDER_SOURCE_STATUS.Active,
                                observedThrough,
                            ) as
                                | {
                                      side: string | null;
                                      token_id: string | null;
                                      maker: string;
                                  }
                                | undefined;
                            if (!changedOrder) continue;
                            count++;
                            if (
                                changedOrder.side === ORDER_SIDE.Sell &&
                                changedOrder.token_id !== null
                            ) {
                                sellers.set(
                                    JSON.stringify([
                                        changedOrder.token_id,
                                        changedOrder.maker,
                                    ]),
                                    {
                                        token_id: changedOrder.token_id,
                                        maker: changedOrder.maker,
                                    },
                                );
                            }
                        }
                        // Commit the orderbook change and today's feed price together.
                        // Refresh each affected seller once, not once per missing order.
                        const now = nowSeconds();
                        for (const seller of sellers.values())
                            listingPrices.refreshSeller(
                                {
                                    chain_id: input.chainId,
                                    collection_id: input.collectionId,
                                    ...seller,
                                },
                                now,
                            );
                        return count;
                    })();
                    after = rows[rows.length - 1]!.id;
                    await new Promise<void>((resolve) => setImmediate(resolve));
                }
                if (!closed)
                    db.writeTransaction(() => {
                        if (!admitted()) return;
                        // Observe the collection once, using the conservative crawl
                        // start rather than making old pages appear newly observed.
                        db.prepare<[number, number, number]>(
                            "INSERT INTO market_order_observations(chain_id,collection_id,observed_at) VALUES (?,?,?) " +
                                "ON CONFLICT(chain_id,collection_id) DO UPDATE SET observed_at=excluded.observed_at WHERE excluded.observed_at>observed_at",
                        ).run(
                            input.chainId,
                            input.collectionId,
                            input.startedAt,
                        );
                    })();
                return changed;
            },
            close() {
                if (closed) return;
                closed = true;
                db.raw.exec(`DROP TABLE ${name}; DROP TABLE ${missing};`);
            },
        };
    }
}
