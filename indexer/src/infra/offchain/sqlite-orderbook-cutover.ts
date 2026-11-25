import { db } from "@artgod/shared/database";
import { OPENSEA_COLLECTION_STATUS } from "@artgod/shared/types";
import { LEGACY_BOOK_JOBS } from "../../domain/orderbook-cutover.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import { QUEUE_OUTBOX_STATUS } from "../../domain/queue-outbox.js";

export class SqliteOrderbookCutover {
    pending() {
        return !!db
            .prepare("SELECT 1 FROM orderbook_cutover WHERE pending=1")
            .get();
    }
    reset() {
        db.writeTransaction(() => {
            if (!this.pending()) return;
            if (
                db
                    .prepare(
                        "SELECT 1 FROM queue_outbox WHERE queue_name=? AND status<>? LIMIT 1",
                    )
                    .get(
                        QUEUE_NAMES.OffchainOrdersRaw,
                        QUEUE_OUTBOX_STATUS.Sent,
                    )
            )
                throw new Error(
                    "Drain raw offchain outbox jobs before the orderbook cutover",
                );
            for (const [queue, kinds] of LEGACY_BOOK_JOBS) {
                for (const kind of kinds)
                    db.prepare(
                        "DELETE FROM queue_outbox WHERE queue_name=? AND job_kind=?",
                    ).run(queue, kind);
            }
            db.exec(
                "DELETE FROM maker_order_revalidation_runs; DELETE FROM order_validation_demand; DELETE FROM market_order_retirements; DELETE FROM market_order_observations; DELETE FROM offchain_order_observations; DELETE FROM opensea_orderbook_runs; DELETE FROM orders WHERE order_hash IS NULL;",
            );
            db.prepare(
                "UPDATE collections SET opensea_status=?,opensea_ready_at=NULL,opensea_snapshot_started_at=NULL,opensea_snapshot_completed_at=NULL,opensea_reconcile_started_at=NULL,opensea_reconcile_completed_at=NULL,opensea_last_stream_event_at=NULL,opensea_last_stream_healthy_at=NULL,opensea_last_error=NULL WHERE opensea_status IS NOT NULL",
            ).run(OPENSEA_COLLECTION_STATUS.Pending);
            db.prepare(
                "UPDATE orderbook_cutover SET pending=0,completed_ms=CAST(unixepoch('subsec')*1000 AS INTEGER)",
            ).run();
        })();
    }
}
