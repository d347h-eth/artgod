import { randomUUID } from "node:crypto";
import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import {
    TRADING_BOT_KIND,
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_COMMAND_STATUS,
    TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type PersistedBiddingJobRecord,
    type PersistedCollectionBiddingJobRecord,
    type PersistedBiddingJobRuntimeState,
    type PersistedTokenBiddingJobRecord,
    type TradingBiddingJobTargetDescriptor,
    type TradingBiddingJobPricingSource,
    type TradingBiddingJobRuntimeBidPosition,
    type TradingBiddingJobRuntimeConstraint,
    type TradingJobCommandKind,
    type TradingJobCommandRecord,
    type TradingTraitCriterion,
    isTradingBiddingJobRuntimeBidPosition,
    isTradingBiddingJobRuntimeConstraint,
    normalizeTradingTraitCriteria,
    tradingBiddingJobTargetKey,
    tradingTraitCriteriaKey,
} from "@artgod/shared/types";
import type {
    BiddingJobsRepositoryPort,
    UpdateBiddingJobPricingByIdInput,
    UpsertCollectionBiddingJobInput,
    UpsertTokenBiddingJobInput,
} from "../../application/use-cases/trading/ports.js";

type BiddingJobRow = {
    job_id: string;
    bot_kind: typeof TRADING_BOT_KIND.Bidding;
    chain_id: number;
    collection_id: number;
    collection_slug: string;
    collection_opensea_slug: string | null;
    collection_address: string;
    status: keyof typeof TRADING_JOB_STATUS | (typeof TRADING_JOB_STATUS)[keyof typeof TRADING_JOB_STATUS];
    target_kind: keyof typeof TRADING_JOB_TARGET_KIND | (typeof TRADING_JOB_TARGET_KIND)[keyof typeof TRADING_JOB_TARGET_KIND];
    token_id: string | null;
    floor_wei: string;
    ceiling_wei: string;
    delta_wei: string;
    price_tier_id: string | null;
    pricing_source_json: string | null;
    quantity: number | null;
    target_traits_json: string | null;
    competitor_traits_json: string | null;
    revision: number;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
    current_price_wei: string | null;
    active_order_id: string | null;
    active_protocol_address: string | null;
    active_expiration_time_ms: number | null;
    bid_position: string | null;
    bid_constraints_json: string | null;
    competitor_price_wei: string | null;
    last_run_at: string | null;
    last_error: string | null;
    cancellation_requested_at: string | null;
    cancellation_completed_at: string | null;
    cancellation_error: string | null;
    runtime_updated_at: string | null;
};

type TradingJobCommandRow = {
    command_id: number;
    job_id: string;
    bot_kind: typeof TRADING_BOT_KIND.Bidding;
    command_kind: TradingJobCommandKind;
    status: (typeof TRADING_JOB_COMMAND_STATUS)[keyof typeof TRADING_JOB_COMMAND_STATUS];
    requested_revision: number;
    payload_json: string;
    attempts: number;
    last_error: string | null;
    created_at: string;
    claimed_at: string | null;
    completed_at: string | null;
};

type PersistedNonTokenBiddingJobRecord = Exclude<
    PersistedBiddingJobRecord,
    PersistedTokenBiddingJobRecord
>;

const BIDDING_JOB_SELECT =
    "SELECT j.job_id, j.bot_kind, j.chain_id, j.collection_id, " +
    "c.slug AS collection_slug, c.opensea_slug AS collection_opensea_slug, c.address AS collection_address, " +
    "j.status, j.target_kind, j.token_id, j.revision, j.created_at, j.updated_at, j.archived_at, " +
    "s.floor_wei, s.ceiling_wei, s.delta_wei, s.price_tier_id, s.pricing_source_json, " +
    "s.quantity, s.target_traits_json, s.competitor_traits_json, " +
    "r.current_price_wei, r.active_order_id, r.active_protocol_address, r.active_expiration_time_ms, " +
    "r.bid_position, r.bid_constraints_json, r.competitor_price_wei, " +
    "r.last_run_at, r.last_error, r.cancellation_requested_at, r.cancellation_completed_at, r.cancellation_error, r.updated_at AS runtime_updated_at " +
    "FROM trading_jobs j " +
    "JOIN trading_bidding_job_specs s ON s.job_id = j.job_id " +
    "JOIN collections c ON c.collection_id = j.collection_id " +
    "LEFT JOIN trading_bidding_job_runtime_state r ON r.job_id = j.job_id " +
    "WHERE j.bot_kind = @botKind ";

export class SqliteBiddingJobsRepository implements BiddingJobsRepositoryPort {
    private readonly selectCollectionJobs: BetterSqlite3NamedStatement<{
        botKind: typeof TRADING_BOT_KIND.Bidding;
        chainId: number;
        collectionId: number;
        includeArchived: number;
    }>;

    private readonly selectTokenJob: BetterSqlite3NamedStatement<{
        botKind: typeof TRADING_BOT_KIND.Bidding;
        chainId: number;
        collectionId: number;
        tokenId: string;
        includeArchived: number;
    }>;

    private readonly selectJobById: BetterSqlite3NamedStatement<{
        botKind: typeof TRADING_BOT_KIND.Bidding;
        jobId: string;
    }>;

    private readonly insertTradingJob: BetterSqlite3NamedStatement<{
        jobId: string;
        botKind: typeof TRADING_BOT_KIND.Bidding;
        chainId: number;
        collectionId: number;
        status: Exclude<(typeof TRADING_JOB_STATUS)[keyof typeof TRADING_JOB_STATUS], "archived">;
        targetKind:
            | typeof TRADING_JOB_TARGET_KIND.Token
            | typeof TRADING_JOB_TARGET_KIND.Collection;
        tokenId: string | null;
    }>;

    private readonly updateTradingJobById: BetterSqlite3NamedStatement<{
        jobId: string;
        status: Exclude<(typeof TRADING_JOB_STATUS)[keyof typeof TRADING_JOB_STATUS], "archived">;
    }>;

    private readonly archiveTradingJobById: BetterSqlite3NamedStatement<{
        jobId: string;
    }>;

    private readonly insertBiddingSpec: BetterSqlite3NamedStatement<{
        jobId: string;
        floorWei: string;
        ceilingWei: string;
        deltaWei: string;
        quantity: number | null;
        targetTraitsJson: string | null;
        competitorTraitsJson: string | null;
        priceTierId: string | null;
        pricingSourceJson: string | null;
    }>;

    private readonly updateBiddingSpecById: BetterSqlite3NamedStatement<{
        jobId: string;
        floorWei: string;
        ceilingWei: string;
        deltaWei: string;
        quantity: number | null;
        targetTraitsJson: string | null;
        competitorTraitsJson: string | null;
        priceTierId: string | null;
        pricingSourceJson: string | null;
    }>;

    private readonly insertCommand: BetterSqlite3NamedStatement<{
        jobId: string;
        botKind: typeof TRADING_BOT_KIND.Bidding;
        commandKind: TradingJobCommandKind;
        status: typeof TRADING_JOB_COMMAND_STATUS.Pending;
        requestedRevision: number;
        payloadJson: string;
    }>;

    private readonly selectPendingCommands: BetterSqlite3NamedStatement<{
        botKind: typeof TRADING_BOT_KIND.Bidding;
        limit: number;
    }>;

    constructor() {
        this.selectCollectionJobs = db.prepare<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            collectionId: number;
            includeArchived: number;
        }>(
            BIDDING_JOB_SELECT +
                "AND j.chain_id = @chainId AND j.collection_id = @collectionId " +
                "AND (@includeArchived = 1 OR j.status != 'archived') " +
                "ORDER BY j.updated_at DESC, j.job_id ASC",
        ) as BetterSqlite3NamedStatement<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            collectionId: number;
            includeArchived: number;
        }>;

        this.selectTokenJob = db.prepare<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            collectionId: number;
            tokenId: string;
            includeArchived: number;
        }>(
            BIDDING_JOB_SELECT +
                "AND j.chain_id = @chainId AND j.collection_id = @collectionId " +
                "AND j.target_kind = 'token' AND j.token_id = @tokenId " +
                "AND (@includeArchived = 1 OR j.status != 'archived') " +
                "ORDER BY j.updated_at DESC, j.job_id ASC LIMIT 1",
        ) as BetterSqlite3NamedStatement<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            collectionId: number;
            tokenId: string;
            includeArchived: number;
        }>;

        this.selectJobById = db.prepare<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            jobId: string;
        }>(
            BIDDING_JOB_SELECT +
                "AND j.job_id = @jobId LIMIT 1",
        ) as BetterSqlite3NamedStatement<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            jobId: string;
        }>;

        this.insertTradingJob = db.prepare<{
            jobId: string;
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            collectionId: number;
            status: Exclude<(typeof TRADING_JOB_STATUS)[keyof typeof TRADING_JOB_STATUS], "archived">;
            targetKind:
                | typeof TRADING_JOB_TARGET_KIND.Token
                | typeof TRADING_JOB_TARGET_KIND.Collection;
            tokenId: string | null;
        }>(
            "INSERT INTO trading_jobs " +
                "(job_id, bot_kind, chain_id, collection_id, status, target_kind, token_id) " +
                "VALUES (@jobId, @botKind, @chainId, @collectionId, @status, @targetKind, @tokenId)",
        ) as BetterSqlite3NamedStatement<{
            jobId: string;
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            collectionId: number;
            status: Exclude<(typeof TRADING_JOB_STATUS)[keyof typeof TRADING_JOB_STATUS], "archived">;
            targetKind:
                | typeof TRADING_JOB_TARGET_KIND.Token
                | typeof TRADING_JOB_TARGET_KIND.Collection;
            tokenId: string | null;
        }>;

        this.updateTradingJobById = db.prepare<{
            jobId: string;
            status: Exclude<(typeof TRADING_JOB_STATUS)[keyof typeof TRADING_JOB_STATUS], "archived">;
        }>(
            "UPDATE trading_jobs SET " +
                "status = @status, archived_at = NULL, revision = revision + 1, updated_at = CURRENT_TIMESTAMP " +
                "WHERE job_id = @jobId",
        ) as BetterSqlite3NamedStatement<{
            jobId: string;
            status: Exclude<(typeof TRADING_JOB_STATUS)[keyof typeof TRADING_JOB_STATUS], "archived">;
        }>;

        this.archiveTradingJobById = db.prepare<{ jobId: string }>(
            "UPDATE trading_jobs SET " +
                "status = 'archived', archived_at = CURRENT_TIMESTAMP, revision = revision + 1, updated_at = CURRENT_TIMESTAMP " +
                "WHERE job_id = @jobId",
        ) as BetterSqlite3NamedStatement<{ jobId: string }>;

        this.insertBiddingSpec = db.prepare<{
            jobId: string;
            floorWei: string;
            ceilingWei: string;
            deltaWei: string;
            quantity: number | null;
            targetTraitsJson: string | null;
            competitorTraitsJson: string | null;
            priceTierId: string | null;
            pricingSourceJson: string | null;
        }>(
            "INSERT INTO trading_bidding_job_specs " +
                "(job_id, floor_wei, ceiling_wei, delta_wei, quantity, target_traits_json, competitor_traits_json, price_tier_id, pricing_source_json) " +
                "VALUES (@jobId, @floorWei, @ceilingWei, @deltaWei, @quantity, @targetTraitsJson, @competitorTraitsJson, @priceTierId, @pricingSourceJson)",
        ) as BetterSqlite3NamedStatement<{
            jobId: string;
            floorWei: string;
            ceilingWei: string;
            deltaWei: string;
            quantity: number | null;
            targetTraitsJson: string | null;
            competitorTraitsJson: string | null;
            priceTierId: string | null;
            pricingSourceJson: string | null;
        }>;

        this.updateBiddingSpecById = db.prepare<{
            jobId: string;
            floorWei: string;
            ceilingWei: string;
            deltaWei: string;
            quantity: number | null;
            targetTraitsJson: string | null;
            competitorTraitsJson: string | null;
            priceTierId: string | null;
            pricingSourceJson: string | null;
        }>(
            "UPDATE trading_bidding_job_specs SET " +
                "floor_wei = @floorWei, ceiling_wei = @ceilingWei, delta_wei = @deltaWei, " +
                "quantity = @quantity, target_traits_json = @targetTraitsJson, competitor_traits_json = @competitorTraitsJson, " +
                "price_tier_id = @priceTierId, pricing_source_json = @pricingSourceJson, " +
                "updated_at = CURRENT_TIMESTAMP " +
                "WHERE job_id = @jobId",
        ) as BetterSqlite3NamedStatement<{
            jobId: string;
            floorWei: string;
            ceilingWei: string;
            deltaWei: string;
            quantity: number | null;
            targetTraitsJson: string | null;
            competitorTraitsJson: string | null;
            priceTierId: string | null;
            pricingSourceJson: string | null;
        }>;

        this.insertCommand = db.prepare<{
            jobId: string;
            botKind: typeof TRADING_BOT_KIND.Bidding;
            commandKind: TradingJobCommandKind;
            status: typeof TRADING_JOB_COMMAND_STATUS.Pending;
            requestedRevision: number;
            payloadJson: string;
        }>(
            "INSERT INTO trading_job_commands " +
                "(job_id, bot_kind, command_kind, status, requested_revision, payload_json) " +
                "VALUES (@jobId, @botKind, @commandKind, @status, @requestedRevision, @payloadJson)",
        ) as BetterSqlite3NamedStatement<{
            jobId: string;
            botKind: typeof TRADING_BOT_KIND.Bidding;
            commandKind: TradingJobCommandKind;
            status: typeof TRADING_JOB_COMMAND_STATUS.Pending;
            requestedRevision: number;
            payloadJson: string;
        }>;

        this.selectPendingCommands = db.prepare<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            limit: number;
        }>(
            "SELECT command_id, job_id, bot_kind, command_kind, status, requested_revision, payload_json, attempts, last_error, created_at, claimed_at, completed_at " +
                "FROM trading_job_commands " +
                "WHERE bot_kind = @botKind AND status IN ('pending', 'failed_retry') " +
                "ORDER BY command_id ASC LIMIT @limit",
        ) as BetterSqlite3NamedStatement<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            limit: number;
        }>;
    }

    listCollectionJobs(params: {
        chainId: number;
        collectionId: number;
        includeArchived?: boolean;
    }): PersistedBiddingJobRecord[] {
        const rows = this.selectCollectionJobs.all({
            botKind: TRADING_BOT_KIND.Bidding,
            chainId: params.chainId,
            collectionId: params.collectionId,
            includeArchived: params.includeArchived ? 1 : 0,
        }) as BiddingJobRow[];
        return rows.map((row) => this.mapBiddingJobRow(row));
    }

    getTokenJob(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        includeArchived?: boolean;
    }): PersistedTokenBiddingJobRecord | null {
        const row = this.selectTokenJob.get({
            botKind: TRADING_BOT_KIND.Bidding,
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenId: params.tokenId,
            includeArchived: params.includeArchived ? 1 : 0,
        }) as BiddingJobRow | undefined;
        if (!row) {
            return null;
        }
        const job = this.mapBiddingJobRow(row);
        return job.targetKind === TRADING_JOB_TARGET_KIND.Token ? job : null;
    }

    getJobById(jobId: string): PersistedBiddingJobRecord | null {
        const row = this.selectJobById.get({
            botKind: TRADING_BOT_KIND.Bidding,
            jobId,
        }) as BiddingJobRow | undefined;
        return row ? this.mapBiddingJobRow(row) : null;
    }

    findJobByTarget(params: {
        chainId: number;
        collectionId: number;
        target: TradingBiddingJobTargetDescriptor;
        includeArchived?: boolean;
    }): PersistedBiddingJobRecord | null {
        if (params.target.targetKind === TRADING_JOB_TARGET_KIND.Token) {
            return this.getTokenJob({
                chainId: params.chainId,
                collectionId: params.collectionId,
                tokenId: params.target.tokenId,
                includeArchived: params.includeArchived,
            });
        }

        const targetKey = tradingBiddingJobTargetKey(params.target);
        for (const job of this.listCollectionJobs({
            chainId: params.chainId,
            collectionId: params.collectionId,
            includeArchived: params.includeArchived,
        })) {
            if (tradingBiddingJobTargetKey(this.persistedJobTarget(job)) === targetKey) {
                return job;
            }
        }
        return null;
    }

    upsertTokenJob(
        input: UpsertTokenBiddingJobInput,
    ): {
        job: PersistedTokenBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    } {
        return db.raw.transaction((transactionInput: UpsertTokenBiddingJobInput) =>
            this.upsertTokenJobInTransaction(transactionInput),
        )(input);
    }

    upsertTokenJobs(
        inputs: UpsertTokenBiddingJobInput[],
    ): {
        jobs: PersistedTokenBiddingJobRecord[];
        commands: TradingJobCommandRecord[];
    } {
        return db.raw.transaction((transactionInputs: UpsertTokenBiddingJobInput[]) => {
            const jobs: PersistedTokenBiddingJobRecord[] = [];
            const commands: TradingJobCommandRecord[] = [];
            for (const input of transactionInputs) {
                const result = this.upsertTokenJobInTransaction(input);
                jobs.push(result.job);
                commands.push(...result.commands);
            }
            return { jobs, commands };
        })(inputs);
    }

    upsertCollectionJob(
        input: UpsertCollectionBiddingJobInput,
    ): {
        job: PersistedCollectionBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    } {
        return db.raw.transaction(
            (transactionInput: UpsertCollectionBiddingJobInput) => {
                const targetTraits = this.normalizeTraitCriteria(
                    transactionInput.targetTraits,
                );
                const existing = this.findActiveCollectionJob({
                    chainId: transactionInput.chainId,
                    collectionId: transactionInput.collectionId,
                    quantity: transactionInput.quantity,
                    targetTraits,
                });

                if (existing) {
                    this.updateTradingJobById.run({
                        jobId: existing.jobId,
                        status: transactionInput.status,
                    });
                    this.updateBiddingSpecById.run({
                        jobId: existing.jobId,
                        floorWei: transactionInput.floorWei,
                        ceilingWei: transactionInput.ceilingWei,
                        deltaWei: transactionInput.deltaWei,
                        quantity: transactionInput.quantity,
                        targetTraitsJson: JSON.stringify(targetTraits),
                        competitorTraitsJson: null,
                        ...this.biddingPricingPayload(transactionInput),
                    });

                    const job = this.requireCollectionJobById(existing.jobId);
                    const commandKind =
                        job.status === TRADING_JOB_STATUS.Paused
                            ? TRADING_JOB_COMMAND_KIND.JobPaused
                            : TRADING_JOB_COMMAND_KIND.JobUpdated;
                    const commands = [
                        this.insertCommandRecord(
                            job.jobId,
                            commandKind,
                            job.revision,
                            this.collectionJobCommandPayload(job),
                        ),
                    ];
                    if (job.status === TRADING_JOB_STATUS.Paused) {
                        commands.push(
                            this.insertCommandRecord(
                                job.jobId,
                                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                                job.revision,
                                this.collectionJobCommandPayload(job),
                            ),
                        );
                    }
                    return { job, commands };
                }

                const jobId = randomUUID();
                this.insertTradingJob.run({
                    jobId,
                    botKind: TRADING_BOT_KIND.Bidding,
                    chainId: transactionInput.chainId,
                    collectionId: transactionInput.collectionId,
                    status: transactionInput.status,
                    targetKind: TRADING_JOB_TARGET_KIND.Collection,
                    tokenId: null,
                });
                this.insertBiddingSpec.run({
                    jobId,
                    floorWei: transactionInput.floorWei,
                    ceilingWei: transactionInput.ceilingWei,
                    deltaWei: transactionInput.deltaWei,
                    quantity: transactionInput.quantity,
                    targetTraitsJson: JSON.stringify(targetTraits),
                    competitorTraitsJson: null,
                    ...this.biddingPricingPayload(transactionInput),
                });

                const job = this.requireCollectionJobById(jobId);
                const command = this.insertCommandRecord(
                    job.jobId,
                    job.status === TRADING_JOB_STATUS.Paused
                        ? TRADING_JOB_COMMAND_KIND.JobPaused
                        : TRADING_JOB_COMMAND_KIND.JobCreated,
                    job.revision,
                    this.collectionJobCommandPayload(job),
                );
                return {
                    job,
                    commands: [command],
                };
            },
        )(input);
    }

    archiveTokenJob(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
    }): {
        job: PersistedTokenBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    } | null {
        return db.raw.transaction((input: {
            chainId: number;
            collectionId: number;
            tokenId: string;
        }) => {
            const existing = this.getTokenJob({
                chainId: input.chainId,
                collectionId: input.collectionId,
                tokenId: input.tokenId,
                includeArchived: false,
            });
            if (!existing) {
                return null;
            }

            const result = this.archiveJobByIdInTransaction({
                chainId: input.chainId,
                collectionId: input.collectionId,
                jobId: existing.jobId,
            });
            return result?.job.targetKind === TRADING_JOB_TARGET_KIND.Token
                ? { job: result.job, commands: result.commands }
                : null;
        })(params);
    }

    archiveJobById(params: {
        chainId: number;
        collectionId: number;
        jobId: string;
    }): {
        job: PersistedBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    } | null {
        return db.raw.transaction((input: {
            chainId: number;
            collectionId: number;
            jobId: string;
        }) => this.archiveJobByIdInTransaction(input))(params);
    }

    updateJobsPricingById(
        inputs: UpdateBiddingJobPricingByIdInput[],
    ): {
        jobs: PersistedBiddingJobRecord[];
        commands: TradingJobCommandRecord[];
    } {
        return db.raw.transaction(
            (transactionInputs: UpdateBiddingJobPricingByIdInput[]) => {
                const jobs: PersistedBiddingJobRecord[] = [];
                const commands: TradingJobCommandRecord[] = [];
                for (const input of transactionInputs) {
                    const result = this.updateJobPricingByIdInTransaction(input);
                    if (!result) {
                        continue;
                    }
                    jobs.push(result.job);
                    commands.push(...result.commands);
                }
                return { jobs, commands };
            },
        )(inputs);
    }

    listPendingCommands(params: { limit: number }): TradingJobCommandRecord[] {
        const rows = this.selectPendingCommands.all({
            botKind: TRADING_BOT_KIND.Bidding,
            limit: params.limit,
        }) as TradingJobCommandRow[];
        return rows.map((row) => this.mapCommandRow(row));
    }

    private requireTokenJobById(jobId: string): PersistedTokenBiddingJobRecord {
        const job = this.getJobById(jobId);
        if (!job || job.targetKind !== TRADING_JOB_TARGET_KIND.Token) {
            throw new Error(
                `Expected persisted token bidding job to exist for jobId=${jobId}`,
            );
        }
        return job;
    }

    private archiveJobByIdInTransaction(params: {
        chainId: number;
        collectionId: number;
        jobId: string;
    }): {
        job: PersistedBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    } | null {
        const existing = this.getJobById(params.jobId);
        if (
            !existing ||
            existing.chainId !== params.chainId ||
            existing.collectionId !== params.collectionId ||
            existing.status === TRADING_JOB_STATUS.Archived
        ) {
            return null;
        }

        this.archiveTradingJobById.run({ jobId: existing.jobId });

        const job = this.requireBiddingJobById(existing.jobId);
        const payload = this.biddingJobCommandPayload(job);
        const archivedCommand = this.insertCommandRecord(
            job.jobId,
            TRADING_JOB_COMMAND_KIND.JobArchived,
            job.revision,
            payload,
        );
        const cancelCommand = this.insertCommandRecord(
            job.jobId,
            TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
            job.revision,
            payload,
        );
        return {
            job,
            commands: [archivedCommand, cancelCommand],
        };
    }

    private updateJobPricingByIdInTransaction(
        input: UpdateBiddingJobPricingByIdInput,
    ): {
        job: PersistedBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    } | null {
        const existing = this.getJobById(input.jobId);
        if (
            !existing ||
            existing.chainId !== input.chainId ||
            existing.collectionId !== input.collectionId ||
            existing.status === TRADING_JOB_STATUS.Archived
        ) {
            return null;
        }

        this.updateTradingJobById.run({
            jobId: existing.jobId,
            status: existing.status,
        });
        this.updateBiddingSpecById.run({
            jobId: existing.jobId,
            floorWei: input.floorWei,
            ceilingWei: input.ceilingWei,
            deltaWei: input.deltaWei,
            ...this.biddingSpecTargetPayload(existing),
            priceTierId: input.priceTierId,
            pricingSourceJson: JSON.stringify(input.pricingSource),
        });

        const job = this.requireBiddingJobById(existing.jobId);
        const payload = this.biddingJobCommandPayload(job);
        const commandKind =
            job.status === TRADING_JOB_STATUS.Paused
                ? TRADING_JOB_COMMAND_KIND.JobPaused
                : TRADING_JOB_COMMAND_KIND.JobUpdated;
        const commands = [
            this.insertCommandRecord(
                job.jobId,
                commandKind,
                job.revision,
                payload,
            ),
        ];
        if (job.status === TRADING_JOB_STATUS.Paused) {
            commands.push(
                this.insertCommandRecord(
                    job.jobId,
                    TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                    job.revision,
                    payload,
                ),
            );
        }
        return { job, commands };
    }

    private requireBiddingJobById(jobId: string): PersistedBiddingJobRecord {
        const job = this.getJobById(jobId);
        if (!job) {
            throw new Error(
                `Expected persisted bidding job to exist for jobId=${jobId}`,
            );
        }
        return job;
    }

    private upsertTokenJobInTransaction(
        transactionInput: UpsertTokenBiddingJobInput,
    ): {
        job: PersistedTokenBiddingJobRecord;
        commands: TradingJobCommandRecord[];
    } {
        const existing = this.getTokenJob({
            chainId: transactionInput.chainId,
            collectionId: transactionInput.collectionId,
            tokenId: transactionInput.tokenId,
            includeArchived: false,
        });

        if (existing) {
            this.updateTradingJobById.run({
                jobId: existing.jobId,
                status: transactionInput.status,
            });
            this.updateBiddingSpecById.run({
                jobId: existing.jobId,
                floorWei: transactionInput.floorWei,
                ceilingWei: transactionInput.ceilingWei,
                deltaWei: transactionInput.deltaWei,
                quantity: null,
                targetTraitsJson: null,
                competitorTraitsJson: null,
                ...this.biddingPricingPayload(transactionInput),
            });

            const job = this.requireTokenJobById(existing.jobId);
            const commandKind =
                job.status === TRADING_JOB_STATUS.Paused
                    ? TRADING_JOB_COMMAND_KIND.JobPaused
                    : TRADING_JOB_COMMAND_KIND.JobUpdated;
            const commands = [
                this.insertCommandRecord(
                    job.jobId,
                    commandKind,
                    job.revision,
                    this.tokenJobCommandPayload(job),
                ),
            ];
            if (job.status === TRADING_JOB_STATUS.Paused) {
                commands.push(
                    this.insertCommandRecord(
                        job.jobId,
                        TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                        job.revision,
                        this.tokenJobCommandPayload(job),
                    ),
                );
            }
            return { job, commands };
        }

        const jobId = randomUUID();
        this.insertTradingJob.run({
            jobId,
            botKind: TRADING_BOT_KIND.Bidding,
            chainId: transactionInput.chainId,
            collectionId: transactionInput.collectionId,
            status: transactionInput.status,
            targetKind: TRADING_JOB_TARGET_KIND.Token,
            tokenId: transactionInput.tokenId,
        });
        this.insertBiddingSpec.run({
            jobId,
            floorWei: transactionInput.floorWei,
            ceilingWei: transactionInput.ceilingWei,
            deltaWei: transactionInput.deltaWei,
            quantity: null,
            targetTraitsJson: null,
            competitorTraitsJson: null,
            ...this.biddingPricingPayload(transactionInput),
        });

        const job = this.requireTokenJobById(jobId);
        const command = this.insertCommandRecord(
            job.jobId,
            job.status === TRADING_JOB_STATUS.Paused
                ? TRADING_JOB_COMMAND_KIND.JobPaused
                : TRADING_JOB_COMMAND_KIND.JobCreated,
            job.revision,
            this.tokenJobCommandPayload(job),
        );
        return {
            job,
            commands: [command],
        };
    }

    private tokenJobCommandPayload(
        job: PersistedTokenBiddingJobRecord,
    ): Record<string, unknown> {
        return {
            chainId: job.chainId,
            collectionId: job.collectionId,
            tokenId: job.tokenId,
            jobId: job.jobId,
        };
    }

    private requireCollectionJobById(
        jobId: string,
    ): PersistedCollectionBiddingJobRecord {
        const job = this.getJobById(jobId);
        if (!job || job.targetKind !== TRADING_JOB_TARGET_KIND.Collection) {
            throw new Error(
                `Expected persisted collection bidding job to exist for jobId=${jobId}`,
            );
        }
        return job;
    }

    private findActiveCollectionJob(params: {
        chainId: number;
        collectionId: number;
        quantity: number;
        targetTraits: TradingTraitCriterion[];
    }): PersistedCollectionBiddingJobRecord | null {
        const targetTraitsKey = this.traitCriteriaKey(params.targetTraits);
        for (const job of this.listCollectionJobs({
            chainId: params.chainId,
            collectionId: params.collectionId,
        })) {
            if (
                job.targetKind === TRADING_JOB_TARGET_KIND.Collection &&
                job.quantity === params.quantity &&
                this.traitCriteriaKey(job.targetTraits) === targetTraitsKey
            ) {
                return job;
            }
        }
        return null;
    }

    private collectionJobCommandPayload(
        job: PersistedNonTokenBiddingJobRecord,
    ): Record<string, unknown> {
        return {
            chainId: job.chainId,
            collectionId: job.collectionId,
            quantity: job.quantity,
            targetTraits: job.targetTraits,
            ...(job.targetKind === TRADING_JOB_TARGET_KIND.CompetitiveTrait
                ? { competitorTraits: job.competitorTraits }
                : {}),
            jobId: job.jobId,
        };
    }

    private biddingJobCommandPayload(
        job: PersistedBiddingJobRecord,
    ): Record<string, unknown> {
        if (job.targetKind === TRADING_JOB_TARGET_KIND.Token) {
            return this.tokenJobCommandPayload(job);
        }
        return this.collectionJobCommandPayload(job);
    }

    private persistedJobTarget(
        job: PersistedBiddingJobRecord,
    ): TradingBiddingJobTargetDescriptor {
        if (job.targetKind === TRADING_JOB_TARGET_KIND.Token) {
            return {
                targetKind: TRADING_JOB_TARGET_KIND.Token,
                tokenId: job.tokenId,
            };
        }
        if (job.targetKind === TRADING_JOB_TARGET_KIND.Collection) {
            return {
                targetKind: TRADING_JOB_TARGET_KIND.Collection,
                quantity: job.quantity,
                targetTraits: job.targetTraits,
            };
        }
        return {
            targetKind: TRADING_JOB_TARGET_KIND.CompetitiveTrait,
            quantity: job.quantity,
            targetTraits: job.targetTraits,
            competitorTraits: job.competitorTraits,
        };
    }

    private normalizeTraitCriteria(
        traits: TradingTraitCriterion[],
    ): TradingTraitCriterion[] {
        return normalizeTradingTraitCriteria(traits);
    }

    private traitCriteriaKey(traits: TradingTraitCriterion[]): string {
        return tradingTraitCriteriaKey(traits);
    }

    private biddingSpecTargetPayload(job: PersistedBiddingJobRecord): {
        quantity: number | null;
        targetTraitsJson: string | null;
        competitorTraitsJson: string | null;
    } {
        if (job.targetKind === TRADING_JOB_TARGET_KIND.Token) {
            return {
                quantity: null,
                targetTraitsJson: null,
                competitorTraitsJson: null,
            };
        }
        return {
            quantity: job.quantity,
            targetTraitsJson: JSON.stringify(job.targetTraits),
            competitorTraitsJson:
                job.targetKind === TRADING_JOB_TARGET_KIND.CompetitiveTrait
                    ? JSON.stringify(job.competitorTraits)
                    : null,
        };
    }

    private insertCommandRecord(
        jobId: string,
        commandKind: TradingJobCommandKind,
        requestedRevision: number,
        payload: Record<string, unknown>,
    ): TradingJobCommandRecord {
        const payloadJson = JSON.stringify(payload);
        const result = this.insertCommand.run({
            jobId,
            botKind: TRADING_BOT_KIND.Bidding,
            commandKind,
            status: TRADING_JOB_COMMAND_STATUS.Pending,
            requestedRevision,
            payloadJson,
        });
        const commandId = Number(result.lastInsertRowid);
        const row = db.prepare<{ commandId: number }>(
            "SELECT command_id, job_id, bot_kind, command_kind, status, requested_revision, payload_json, attempts, last_error, created_at, claimed_at, completed_at " +
                "FROM trading_job_commands WHERE command_id = @commandId LIMIT 1",
        ).get({ commandId }) as TradingJobCommandRow | undefined;
        if (!row) {
            throw new Error(`Failed to reload trading job command ${commandId}`);
        }
        return this.mapCommandRow(row);
    }

    private mapBiddingJobRow(row: BiddingJobRow): PersistedBiddingJobRecord {
        const runtime = this.mapRuntimeState(row);
        const base = {
            jobId: row.job_id,
            botKind: TRADING_BOT_KIND.Bidding,
            chainId: row.chain_id,
            collectionId: row.collection_id,
            collectionSlug: row.collection_slug,
            collectionOpenseaSlug: row.collection_opensea_slug,
            collectionAddress: row.collection_address,
            status: row.status as PersistedBiddingJobRecord["status"],
            floorWei: row.floor_wei,
            ceilingWei: row.ceiling_wei,
            deltaWei: row.delta_wei,
            priceTierId: row.price_tier_id,
            pricingSource: this.parsePricingSourceJson(
                row.pricing_source_json,
                row.job_id,
            ),
            revision: row.revision,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            archivedAt: row.archived_at,
            runtime,
        };

        const targetTraits = this.parseTraitCriteriaJson(row.target_traits_json);
        const competitorTraits = this.parseTraitCriteriaJson(
            row.competitor_traits_json,
        );

        if (row.target_kind === TRADING_JOB_TARGET_KIND.Token) {
            if (!row.token_id) {
                throw new Error(
                    `Invalid persisted token bidding job: missing token_id for jobId=${row.job_id}`,
                );
            }
            return {
                ...base,
                targetKind: TRADING_JOB_TARGET_KIND.Token,
                tokenId: row.token_id,
                quantity: null,
                targetTraits: [],
                competitorTraits: [],
            };
        }

        if (row.target_kind === TRADING_JOB_TARGET_KIND.Collection) {
            if (row.quantity === null || row.quantity <= 0) {
                throw new Error(
                    `Invalid persisted collection bidding job: missing quantity for jobId=${row.job_id}`,
                );
            }
            return {
                ...base,
                targetKind: TRADING_JOB_TARGET_KIND.Collection,
                tokenId: null,
                quantity: row.quantity,
                targetTraits,
                competitorTraits: [],
            };
        }

        if (row.target_kind === TRADING_JOB_TARGET_KIND.CompetitiveTrait) {
            if (row.quantity === null || row.quantity <= 0) {
                throw new Error(
                    `Invalid persisted competitive-trait bidding job: missing quantity for jobId=${row.job_id}`,
                );
            }
            return {
                ...base,
                targetKind: TRADING_JOB_TARGET_KIND.CompetitiveTrait,
                tokenId: null,
                quantity: row.quantity,
                targetTraits,
                competitorTraits,
            };
        }

        throw new Error(
            `Unsupported persisted bidding job target_kind=${String(row.target_kind)}`,
        );
    }

    private mapRuntimeState(
        row: BiddingJobRow,
    ): PersistedBiddingJobRuntimeState | null {
        if (!row.runtime_updated_at) {
            return null;
        }

        return {
            currentPriceWei: row.current_price_wei,
            activeOrderId: row.active_order_id,
            activeProtocolAddress: row.active_protocol_address,
            activeExpirationTimeMs: row.active_expiration_time_ms,
            bidPosition: parseRuntimeBidPosition(row.bid_position),
            bidConstraints: parseRuntimeBidConstraints(row.bid_constraints_json),
            competitorPriceWei: row.competitor_price_wei,
            lastRunAt: row.last_run_at,
            lastError: row.last_error,
            cancellationRequestedAt: row.cancellation_requested_at,
            cancellationCompletedAt: row.cancellation_completed_at,
            cancellationError: row.cancellation_error,
            updatedAt: row.runtime_updated_at,
        };
    }

    private mapCommandRow(row: TradingJobCommandRow): TradingJobCommandRecord {
        return {
            commandId: row.command_id,
            jobId: row.job_id,
            botKind: row.bot_kind,
            commandKind: row.command_kind,
            status: row.status,
            requestedRevision: row.requested_revision,
            payload: this.parseCommandPayload(row.payload_json, row.command_id),
            attempts: row.attempts,
            lastError: row.last_error,
            createdAt: row.created_at,
            claimedAt: row.claimed_at,
            completedAt: row.completed_at,
        };
    }

    private parseTraitCriteriaJson(value: string | null): TradingTraitCriterion[] {
        if (!value) {
            return [];
        }

        try {
            const parsed = JSON.parse(value);
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed.flatMap((entry) => {
                const record = entry as { type?: unknown; value?: unknown };
                if (
                    typeof record.type !== "string" ||
                    typeof record.value !== "string"
                ) {
                    return [];
                }
                return [
                    {
                        type: record.type,
                        value: record.value,
                    },
                ];
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Invalid persisted bidding trait JSON: ${message}. value=${value}`,
            );
        }
    }

    private biddingPricingPayload(
        input: {
            priceTierId?: string | null;
            pricingSource?: TradingBiddingJobPricingSource | null;
        },
    ): {
        priceTierId: string | null;
        pricingSourceJson: string | null;
    } {
        const pricingSource = input.pricingSource ?? {
            kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.Manual,
        };
        return {
            priceTierId: input.priceTierId ?? null,
            pricingSourceJson: JSON.stringify(pricingSource),
        };
    }

    private parsePricingSourceJson(
        value: string | null,
        jobId: string,
    ): TradingBiddingJobPricingSource | null {
        if (!value) {
            return null;
        }
        try {
            const parsed = JSON.parse(value) as TradingBiddingJobPricingSource;
            if (
                parsed.kind !== TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.Manual &&
                parsed.kind !== TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier
            ) {
                throw new Error("unsupported kind");
            }
            return parsed;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Invalid persisted bidding pricing source JSON for jobId=${jobId}: ${message}. value=${value}`,
            );
        }
    }

    private parseCommandPayload(
        payloadJson: string,
        commandId: number,
    ): Record<string, unknown> {
        try {
            const parsed = JSON.parse(payloadJson);
            return parsed && typeof parsed === "object"
                ? (parsed as Record<string, unknown>)
                : {};
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Invalid trading job command payload for commandId=${commandId}: ${message}`,
            );
        }
    }
}

function parseRuntimeBidPosition(
    value: string | null,
): TradingBiddingJobRuntimeBidPosition | null {
    return isTradingBiddingJobRuntimeBidPosition(value) ? value : null;
}

function parseRuntimeBidConstraints(
    value: string | null,
): TradingBiddingJobRuntimeConstraint[] {
    if (!value) {
        return [];
    }

    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.flatMap((entry) =>
            isTradingBiddingJobRuntimeConstraint(entry) ? [entry] : [],
        );
    } catch {
        return [];
    }
}
