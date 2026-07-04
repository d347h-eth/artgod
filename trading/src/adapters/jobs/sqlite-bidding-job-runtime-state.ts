import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import { TRADING_BOT_KIND, TRADING_JOB_STATUS } from "@artgod/shared/types";
import type {
    BiddingJobOfferCancellationSnapshot,
    BiddingJobRuntimeStatePort,
    BiddingJobRuntimeStateSnapshot,
} from "../../application/use-cases/bidding/bidder.js";
import type {
    BiddingOfferCancellationFailure,
    BiddingOfferCancellationLifecyclePort,
} from "../../application/use-cases/bidding/bidding-job-command-reconciler.js";
import type {
    CompletedOfferCancellation,
    FailedOfferCancellationRecord,
    FailedOfferCancellationRepositoryPort,
} from "../../application/use-cases/bidding/failed-offer-cancellation-reconciler.js";

type PersistRuntimeStateParams = BiddingJobRuntimeStateSnapshot & {
    bidConstraintsJson: string;
    updatedAt: string;
};

type PersistOfferCancellationParams = BiddingJobOfferCancellationSnapshot & {
    updatedAt: string;
};

type MarkOfferCancellationFailedParams = BiddingOfferCancellationFailure & {
    updatedAt: string;
};

type ListFailedOfferCancellationsParams = {
    chainId: number;
    limit: number;
};

type FailedOfferCancellationRow = {
    job_id: string;
    order_id: string;
    protocol_address: string | null;
    collection_address: string;
    collection_slug: string;
    token_id: string | null;
};

type InvalidateActiveOrderVerificationParams = {
    chainId: number;
    botKind: typeof TRADING_BOT_KIND.Bidding;
    status: typeof TRADING_JOB_STATUS.Enabled;
};

export class SqliteBiddingJobRuntimeState
    implements
        BiddingJobRuntimeStatePort,
        BiddingOfferCancellationLifecyclePort,
        FailedOfferCancellationRepositoryPort
{
    private readonly upsertRuntimeState: BetterSqlite3NamedStatement<PersistRuntimeStateParams>;
    private readonly upsertOfferCancellation: BetterSqlite3NamedStatement<PersistOfferCancellationParams>;
    private readonly selectFailedOfferCancellations: BetterSqlite3NamedStatement<ListFailedOfferCancellationsParams>;
    private readonly markOfferCancellationFailedStatement: BetterSqlite3NamedStatement<MarkOfferCancellationFailedParams>;
    private readonly markOfferCancellationCompletedStatement: BetterSqlite3NamedStatement<CompletedOfferCancellation>;
    private readonly invalidateEnabledActiveOrderVerificationStatement: BetterSqlite3NamedStatement<InvalidateActiveOrderVerificationParams>;

    constructor() {
        this.upsertRuntimeState = db.prepare<PersistRuntimeStateParams>(
            "INSERT INTO trading_bidding_job_runtime_state " +
                "(job_id, job_revision, current_price_wei, active_order_id, active_protocol_address, active_order_placed_at, active_order_verified_at, active_expiration_time_ms, bid_position, bid_constraints_json, competitor_price_wei, last_run_at, last_error, updated_at) " +
                "VALUES (@jobId, @jobRevision, @currentPriceWei, @activeOrderId, @activeProtocolAddress, @activeOrderPlacedAt, @activeOrderVerifiedAt, @activeExpirationTimeMs, @bidPosition, @bidConstraintsJson, @competitorPriceWei, @lastRunAt, @lastError, @updatedAt) " +
                "ON CONFLICT(job_id) DO UPDATE SET " +
                "job_revision = excluded.job_revision, " +
                "current_price_wei = excluded.current_price_wei, " +
                "active_order_id = excluded.active_order_id, " +
                "active_protocol_address = excluded.active_protocol_address, " +
                "active_order_placed_at = excluded.active_order_placed_at, " +
                "active_order_verified_at = excluded.active_order_verified_at, " +
                "active_expiration_time_ms = excluded.active_expiration_time_ms, " +
                "bid_position = excluded.bid_position, " +
                "bid_constraints_json = excluded.bid_constraints_json, " +
                "competitor_price_wei = excluded.competitor_price_wei, " +
                "last_run_at = excluded.last_run_at, " +
                "last_error = excluded.last_error, " +
                "updated_at = excluded.updated_at",
        ) as BetterSqlite3NamedStatement<PersistRuntimeStateParams>;

        this.upsertOfferCancellation =
            db.prepare<PersistOfferCancellationParams>(
                "INSERT INTO trading_bidding_order_cancellations " +
                    "(order_id, job_id, job_revision, chain_id, collection_id, maker, price_wei, protocol_address, placed_at, expiration_time_ms, requested_at, completed_at, cancellation_error, updated_at) " +
                    "SELECT @orderId, @jobId, @jobRevision, j.chain_id, j.collection_id, @makerAddress, @priceWei, @protocolAddress, @placedAt, @expirationTimeMs, @requestedAt, @completedAt, @cancellationError, @updatedAt " +
                    "FROM trading_jobs j WHERE j.job_id = @jobId " +
                    "ON CONFLICT(order_id) DO UPDATE SET " +
                    "job_id = excluded.job_id, " +
                    "job_revision = excluded.job_revision, " +
                    "chain_id = excluded.chain_id, " +
                    "collection_id = excluded.collection_id, " +
                    "maker = excluded.maker, " +
                    "price_wei = COALESCE(excluded.price_wei, trading_bidding_order_cancellations.price_wei), " +
                    "protocol_address = COALESCE(excluded.protocol_address, trading_bidding_order_cancellations.protocol_address), " +
                    "placed_at = COALESCE(excluded.placed_at, trading_bidding_order_cancellations.placed_at), " +
                    "expiration_time_ms = COALESCE(excluded.expiration_time_ms, trading_bidding_order_cancellations.expiration_time_ms), " +
                    "requested_at = CASE " +
                    "WHEN excluded.completed_at IS NULL AND excluded.cancellation_error IS NULL THEN excluded.requested_at " +
                    "ELSE trading_bidding_order_cancellations.requested_at END, " +
                    "completed_at = COALESCE(excluded.completed_at, trading_bidding_order_cancellations.completed_at), " +
                    "cancellation_error = excluded.cancellation_error, " +
                    "updated_at = excluded.updated_at",
            ) as BetterSqlite3NamedStatement<PersistOfferCancellationParams>;

        this.markOfferCancellationFailedStatement =
            db.prepare<MarkOfferCancellationFailedParams>(
                "UPDATE trading_bidding_order_cancellations " +
                    "SET cancellation_error = @cancellationError, " +
                    "completed_at = NULL, " +
                    "updated_at = @updatedAt " +
                    "WHERE job_id = @jobId AND order_id = @orderId",
            ) as BetterSqlite3NamedStatement<MarkOfferCancellationFailedParams>;

        this.markOfferCancellationCompletedStatement =
            db.prepare<CompletedOfferCancellation>(
                "UPDATE trading_bidding_order_cancellations " +
                    "SET completed_at = @completedAt, " +
                    "cancellation_error = NULL, " +
                    "updated_at = @completedAt " +
                    "WHERE job_id = @jobId AND order_id = @orderId",
            ) as BetterSqlite3NamedStatement<CompletedOfferCancellation>;

        this.selectFailedOfferCancellations =
            db.prepare<ListFailedOfferCancellationsParams>(
                "SELECT c.job_id, c.order_id, c.protocol_address, " +
                    "collections.address AS collection_address, collections.slug AS collection_slug, " +
                    "j.token_id " +
                    "FROM trading_bidding_order_cancellations c " +
                    "JOIN collections ON collections.collection_id = c.collection_id " +
                    "JOIN trading_jobs j ON j.job_id = c.job_id " +
                    "WHERE c.chain_id = @chainId " +
                    "AND c.completed_at IS NULL " +
                    "AND c.cancellation_error IS NOT NULL " +
                    "ORDER BY c.updated_at ASC, c.requested_at ASC " +
                    "LIMIT @limit",
            ) as BetterSqlite3NamedStatement<ListFailedOfferCancellationsParams>;

        this.invalidateEnabledActiveOrderVerificationStatement =
            db.prepare<InvalidateActiveOrderVerificationParams>(
                "UPDATE trading_bidding_job_runtime_state " +
                    "SET active_order_verified_at = NULL " +
                    "WHERE active_order_id IS NOT NULL " +
                    "AND job_id IN (" +
                    "SELECT job_id FROM trading_jobs " +
                    "WHERE chain_id = @chainId AND bot_kind = @botKind AND status = @status" +
                    ")",
            ) as BetterSqlite3NamedStatement<InvalidateActiveOrderVerificationParams>;
    }

    persistJobRuntimeState(snapshot: BiddingJobRuntimeStateSnapshot): void {
        const updatedAt = new Date().toISOString();
        // Upsert the latest bot-owned order state so backend bid-book reads can render in-flight own intent.
        this.upsertRuntimeState.run({
            ...snapshot,
            bidConstraintsJson: JSON.stringify(snapshot.bidConstraints),
            updatedAt,
        });
    }

    recordJobOfferCancellation(
        snapshot: BiddingJobOfferCancellationSnapshot,
    ): void {
        const updatedAt = new Date().toISOString();
        // Upsert by order id because a canceled marketplace order is unique even when jobs are recreated.
        this.upsertOfferCancellation.run({
            ...snapshot,
            makerAddress: snapshot.makerAddress.toLowerCase(),
            updatedAt,
        });
    }

    markOfferCancellationFailed(
        failure: BiddingOfferCancellationFailure,
    ): void {
        const updatedAt = new Date().toISOString();
        // Mark terminal cancellation failure so read models do not leave the order in a pending state.
        this.markOfferCancellationFailedStatement.run({
            ...failure,
            updatedAt,
        });
    }

    markOfferCancellationCompleted(
        cancellation: CompletedOfferCancellation,
    ): void {
        // Mark proven-absent cancellations complete so bid-book reads can suppress stale indexed echoes.
        this.markOfferCancellationCompletedStatement.run(cancellation);
    }

    listFailedOfferCancellations(params: {
        chainId: number;
        limit: number;
    }): FailedOfferCancellationRecord[] {
        // Load only failed rows; active/inconclusive marketplace recovery keeps them visible as cancel failed.
        const rows = this.selectFailedOfferCancellations.all(
            params,
        ) as FailedOfferCancellationRow[];
        return rows.map((row) => ({
            jobId: row.job_id,
            orderId: row.order_id,
            protocolAddress: row.protocol_address,
            collectionAddress: row.collection_address,
            collectionSlug: row.collection_slug,
            tokenId: row.token_id,
        }));
    }

    invalidateEnabledActiveOrderVerification(params: {
        chainId: number;
    }): void {
        // Mark prior-process active-order evidence as unverified until this bot start proves it again.
        this.invalidateEnabledActiveOrderVerificationStatement.run({
            chainId: params.chainId,
            botKind: TRADING_BOT_KIND.Bidding,
            status: TRADING_JOB_STATUS.Enabled,
        });
    }
}
