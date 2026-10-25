import { db } from "@artgod/shared/database";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import { isCurrentOpenSeaSyncIdentity } from "./sqlite-opensea-sync-identity.js";
import { ORDER_SOURCE_STATUS } from "../../domain/orders.js";
import type { OrderSourceReconciliationPort } from "../../ports/domain-handlers.js";
import type {
    OrderSourceStatePort,
    OrderSourceObservation,
    OpenSeaSyncIdentity,
} from "../../application/offchain/opensea-orderbook-sync.js";

let nextObservation = 0;

/** Streaming membership is connection-local, not a JS payload array or durable receipt archive. */
export class SqliteOrderSourceStateStore implements OrderSourceStatePort {
    constructor(private readonly orders: OrderSourceReconciliationPort) {}

    beginObservation(input: {
        identity: OpenSeaSyncIdentity;
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
        const admitted = () => isCurrentOpenSeaSyncIdentity(input.identity);
        let closed = false;
        let completed = false;
        // Unchanged stream observations coalesce their timestamp writes. Leave
        // that whole freshness bucket alone rather than mark a recently seen
        // order inactive because it was absent from an older REST page.
        const observedThrough =
            (input.startedAt - POLICY.orderRevalidationSeconds) * 1_000;
        const orders = this.orders;
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
                        input.identity.chainId,
                        input.identity.collectionId,
                        input.source,
                        ORDER_SOURCE_STATUS.Active,
                        observedThrough,
                    );
                let changed = 0;
                let after = "";
                const select = db.raw.prepare(
                    `SELECT id FROM ${missing} WHERE id>? ORDER BY id LIMIT ?`,
                );
                while (!closed && admitted()) {
                    const rows = select.all(
                        after,
                        POLICY.maintenanceBatchRows,
                    ) as { id: string }[];
                    if (!rows.length) break;
                    // The lifecycle recheck and withdrawals share the writer;
                    // a reset in another process cannot land between them.
                    changed += db.writeTransaction(() =>
                        admitted()
                            ? orders.withdrawMissingSources({
                                  chainId: input.identity.chainId,
                                  collectionId: input.identity.collectionId,
                                  source: input.source,
                                  orderIds: rows.map((row) => row.id),
                                  observedThrough,
                                  startedAt: input.startedAt,
                              })
                            : 0,
                    )();
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
                            input.identity.chainId,
                            input.identity.collectionId,
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
