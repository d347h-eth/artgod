import { db } from "@artgod/shared/database";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import { ORDER_SIDE, ORDER_SOURCE_STATUS } from "../../domain/orders.js";
import type { SqliteDailyListingPrices } from "../storage/sqlite-daily-listing-prices.js";
import { SqliteOrderObservations } from "../orders/sqlite-order-observations.js";
import type {
    OrderSourceStatePort,
    OrderSourceObservation,
} from "../../application/offchain/opensea-orderbook-sync.js";

let nextObservation = 0;

/** Streaming membership is connection-local, not a JS payload array or durable receipt archive. */
export class SqliteOrderSourceStateStore implements OrderSourceStatePort {
    private readonly observations = new SqliteOrderObservations();
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
            (input.startedAt - POLICY.orderRevalidationSeconds) * 1_000;
        const listingPrices = this.listingPrices;
        const observations = this.observations;
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
                        `INSERT INTO ${missing}(id) SELECT o.order_id FROM order_source_observations o WHERE chain_id=? AND collection_id=? AND source_id=? AND source_status=? AND admitted_at<=? AND NOT EXISTS(SELECT 1 FROM ${name} a WHERE a.id=o.order_id)`,
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
                            const withdrawal =
                                observations.withdrawIfUnobserved({
                                    chainId: input.chainId,
                                    collectionId: input.collectionId,
                                    orderId: row.id,
                                    sourceId: input.source,
                                    observedThrough,
                                    startedAt: input.startedAt * 1_000,
                                });
                            if (!withdrawal) continue;
                            count++;
                            const changedOrder = withdrawal.availabilityChange;
                            if (
                                changedOrder?.side === ORDER_SIDE.Sell &&
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
