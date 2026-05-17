import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import type {
    BiddingJobRuntimeStatePort,
    BiddingJobRuntimeStateSnapshot,
} from "../../application/use-cases/bidding/bidder.js";

type PersistRuntimeStateParams = BiddingJobRuntimeStateSnapshot & {
    updatedAt: string;
};

export class SqliteBiddingJobRuntimeState
    implements BiddingJobRuntimeStatePort
{
    private readonly upsertRuntimeState: BetterSqlite3NamedStatement<PersistRuntimeStateParams>;

    constructor() {
        this.upsertRuntimeState = db.prepare<PersistRuntimeStateParams>(
            "INSERT INTO trading_bidding_job_runtime_state " +
                "(job_id, current_price_wei, active_order_id, active_protocol_address, active_expiration_time_ms, last_run_at, last_error, updated_at) " +
                "VALUES (@jobId, @currentPriceWei, @activeOrderId, @activeProtocolAddress, @activeExpirationTimeMs, @lastRunAt, @lastError, @updatedAt) " +
                "ON CONFLICT(job_id) DO UPDATE SET " +
                "current_price_wei = excluded.current_price_wei, " +
                "active_order_id = excluded.active_order_id, " +
                "active_protocol_address = excluded.active_protocol_address, " +
                "active_expiration_time_ms = excluded.active_expiration_time_ms, " +
                "last_run_at = excluded.last_run_at, " +
                "last_error = excluded.last_error, " +
                "updated_at = excluded.updated_at",
        ) as BetterSqlite3NamedStatement<PersistRuntimeStateParams>;
    }

    persistJobRuntimeState(snapshot: BiddingJobRuntimeStateSnapshot): void {
        const updatedAt = new Date().toISOString();
        // Upsert the latest bot-owned order state so backend bid-book reads can render in-flight own intent.
        this.upsertRuntimeState.run({
            ...snapshot,
            updatedAt,
        });
    }
}
