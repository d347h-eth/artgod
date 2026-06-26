import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
    TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
    TRADING_BOT_KIND,
    TRADING_BOT_RUNTIME_STATE,
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type TradingBiddingJobRuntimeBidPosition,
    type TradingBiddingJobRuntimeConstraint,
} from "@artgod/shared/types";
import { SqliteBiddingJobsRepository } from "./sqlite-bidding-jobs-repository.js";

const ACTIVE_ORDER_ID = "0xactive-order";
const ACTIVE_PROTOCOL_ADDRESS = "0x00000000006c3852cbef3e08e8df289169ede581";
const ACTIVE_ORDER_PLACED_AT = "2026-05-17T00:00:00Z";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-bidding-jobs-"));
    return join(dir, "main.sqlite");
}

function seedCollection(): number {
    const result = db.prepare<{
        chainId: number;
        slug: string;
        address: string;
        standard: string;
        status: string;
        tokenScopeKind: string;
        openseaSlug: string;
    }>(
        "INSERT INTO collections " +
            "(chain_id, slug, address, standard, status, token_scope_kind, opensea_slug) " +
            "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind, @openseaSlug)",
    ).run({
        chainId: 1,
        slug: "artgod-slug",
        address: "0x1111111111111111111111111111111111111111",
        standard: "erc721",
        status: "live",
        tokenScopeKind: "contract_all_tokens",
        openseaSlug: "terraforms",
    });

    return Number(result.lastInsertRowid);
}

describe("SqliteBiddingJobsRepository", () => {
    let collectionId = 0;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();
        collectionId = seedCollection();
    });

    it("creates a token bidding job and emits a job_created outbox row", () => {
        const repository = new SqliteBiddingJobsRepository();

        const result = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
        });

        assert.equal(result.job.targetKind, TRADING_JOB_TARGET_KIND.Token);
        assert.equal(result.job.collectionSlug, "artgod-slug");
        assert.equal(result.job.collectionOpenseaSlug, "terraforms");
        assert.equal(result.job.collectionAddress, "0x1111111111111111111111111111111111111111");
        assert.equal(result.job.tokenId, "123");
        assert.equal(result.job.priceTierId, null);
        assert.deepEqual(result.job.pricingSource, {
            kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.Manual,
        });
        assert.equal(result.job.revision, 1);
        assert.equal(result.job.runtime, null);

        assert.equal(result.commands.length, 1);
        assert.equal(
            result.commands[0]?.commandKind,
            TRADING_JOB_COMMAND_KIND.JobCreated,
        );
        assert.equal(result.commands[0]?.requestedRevision, 1);

        const listed = repository.listCollectionJobs({
            chainId: 1,
            collectionId,
        });
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.jobId, result.job.jobId);

        const loaded = repository.getTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
        });
        assert.equal(loaded?.jobId, result.job.jobId);

        const pendingCommands = repository.listPendingCommands({ limit: 10 });
        assert.equal(pendingCommands.length, 1);
        assert.equal(
            pendingCommands[0]?.commandKind,
            TRADING_JOB_COMMAND_KIND.JobCreated,
        );
    });

    it("persists tier-backed pricing metadata beside scalar token job prices", () => {
        const repository = new SqliteBiddingJobsRepository();

        const result = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "120000000000000000",
            ceilingWei: "150000000000000000",
            deltaWei: "10000000000000000",
            priceTierId: "tier-base",
            pricingSource: {
                kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                tierId: "tier-base",
                tierName: "base",
                resolvedAt: "2026-01-01T00:00:00Z",
                resolvedFloorWei: "120000000000000000",
                resolvedCeilingWei: "150000000000000000",
                deltaWei: "10000000000000000",
            },
        });

        assert.equal(result.job.priceTierId, "tier-base");
        assert.deepEqual(result.job.pricingSource, {
            kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
            tierId: "tier-base",
            tierName: "base",
            resolvedAt: "2026-01-01T00:00:00Z",
            resolvedFloorWei: "120000000000000000",
            resolvedCeilingWei: "150000000000000000",
            deltaWei: "10000000000000000",
        });
    });

    it("reapplies tier-backed pricing by job id and emits a normal update command", () => {
        const repository = new SqliteBiddingJobsRepository();
        const created = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "120000000000000000",
            ceilingWei: "150000000000000000",
            deltaWei: "10000000000000000",
            priceTierId: "tier-base",
            pricingSource: {
                kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                tierId: "tier-base",
                tierName: "base",
                resolvedAt: "2026-01-01T00:00:00Z",
                resolvedFloorWei: "120000000000000000",
                resolvedCeilingWei: "150000000000000000",
                deltaWei: "10000000000000000",
            },
        });
        seedBiddingJobRuntimeState({
            jobId: created.job.jobId,
            currentPriceWei: "140000000000000000",
            activeOrderId: ACTIVE_ORDER_ID,
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "200000000000000000",
        });

        const result = repository.updateJobsPricingById([
            {
                chainId: 1,
                collectionId,
                jobId: created.job.jobId,
                floorWei: "130000000000000000",
                ceilingWei: "160000000000000000",
                deltaWei: "10000000000000000",
                priceTierId: "tier-base",
                pricingSource: {
                    kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
                    tierId: "tier-base",
                    tierName: "base",
                    resolvedAt: "2026-01-02T00:00:00Z",
                    resolvedFloorWei: "130000000000000000",
                    resolvedCeilingWei: "160000000000000000",
                    deltaWei: "10000000000000000",
                },
            },
        ]);

        assert.equal(result.jobs.length, 1);
        assert.equal(result.jobs[0]?.jobId, created.job.jobId);
        assert.equal(result.jobs[0]?.revision, 2);
        assert.equal(result.jobs[0]?.floorWei, "130000000000000000");
        assert.equal(result.jobs[0]?.runtime, null);
        assert.equal(repository.getJobById(created.job.jobId)?.runtime, null);
        assert.deepEqual(result.jobs[0]?.pricingSource, {
            kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
            tierId: "tier-base",
            tierName: "base",
            resolvedAt: "2026-01-02T00:00:00Z",
            resolvedFloorWei: "130000000000000000",
            resolvedCeilingWei: "160000000000000000",
            deltaWei: "10000000000000000",
        });
        assert.deepEqual(
            result.commands.map((command) => command.commandKind),
            [TRADING_JOB_COMMAND_KIND.JobUpdated],
        );
        assert.equal(result.commands[0]?.requestedRevision, 2);
    });

    it("creates multiple token bidding jobs in one batch transaction", () => {
        const repository = new SqliteBiddingJobsRepository();

        const result = repository.upsertTokenJobs([
            {
                chainId: 1,
                collectionId,
                tokenId: "123",
                status: TRADING_JOB_STATUS.Enabled,
                floorWei: "100000000000000000",
                ceilingWei: "200000000000000000",
                deltaWei: "1000000000000000",
            },
            {
                chainId: 1,
                collectionId,
                tokenId: "456",
                status: TRADING_JOB_STATUS.Enabled,
                floorWei: "100000000000000000",
                ceilingWei: "200000000000000000",
                deltaWei: "1000000000000000",
            },
        ]);

        assert.deepEqual(
            result.jobs.map((job) => job.tokenId),
            ["123", "456"],
        );
        assert.deepEqual(
            result.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.JobCreated,
                TRADING_JOB_COMMAND_KIND.JobCreated,
            ],
        );
        assert.equal(
            repository.listCollectionJobs({ chainId: 1, collectionId }).length,
            2,
        );
    });

    it("updates an existing token bidding job, preserves job identity, and hides stale runtime by revision", () => {
        const repository = new SqliteBiddingJobsRepository();
        const created = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
        });

        seedBiddingJobRuntimeState({
            jobId: created.job.jobId,
            currentPriceWei: "150000000000000000",
            activeOrderId: ACTIVE_ORDER_ID,
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "250000000000000000",
        });
        seedBiddingBotRuntimeState();

        const updated = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Paused,
            floorWei: "120000000000000000",
            ceilingWei: "240000000000000000",
            deltaWei: "2000000000000000",
        });

        assert.equal(updated.job.jobId, created.job.jobId);
        assert.equal(updated.job.revision, 2);
        assert.equal(updated.job.status, TRADING_JOB_STATUS.Paused);
        assert.equal(updated.job.floorWei, "120000000000000000");
        assert.equal(updated.job.runtime, null);
        assert.equal(
            repository.getJobById(created.job.jobId)?.runtime,
            null,
        );
        assert.equal(countRuntimeRows(created.job.jobId), 1);

        assert.equal(updated.commands.length, 2);
        assert.deepEqual(
            updated.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobPaused,
            ],
        );
        assert.equal(updated.commands[0]?.payload.activeOrderId, ACTIVE_ORDER_ID);
        assert.equal(updated.commands[0]?.payload.activeOrderJobRevision, 1);
        assert.equal(
            updated.commands[0]?.payload.activeProtocolAddress,
            ACTIVE_PROTOCOL_ADDRESS,
        );
        assert.equal(
            updated.commands[0]?.payload.activeOrderPlacedAt,
            ACTIVE_ORDER_PLACED_AT,
        );
        assert.deepEqual(selectCancellationRequest(ACTIVE_ORDER_ID), {
            order_id: ACTIVE_ORDER_ID,
            job_id: created.job.jobId,
            job_revision: 1,
            maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            price_wei: "150000000000000000",
            protocol_address: ACTIVE_PROTOCOL_ADDRESS,
            placed_at: ACTIVE_ORDER_PLACED_AT,
            expiration_time_ms: 1_700_000_000_000,
            completed_at: null,
            cancellation_error: null,
        });
        assert.equal(updated.commands[0]?.requestedRevision, 2);

        const pendingCommands = repository.listPendingCommands({ limit: 10 });
        assert.deepEqual(
            pendingCommands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.JobCreated,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobPaused,
            ],
        );
    });

    it("creates and updates a trait-scoped collection bidding job", () => {
        const repository = new SqliteBiddingJobsRepository();

        const created = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
            quantity: 1,
            targetTraits: [
                { type: "Mode", value: "Terrain" },
                { type: "Biome", value: "42" },
            ],
        });

        assert.equal(created.job.targetKind, TRADING_JOB_TARGET_KIND.Collection);
        assert.equal(created.job.quantity, 1);
        assert.deepEqual(created.job.targetTraits, [
            { type: "Biome", value: "42" },
            { type: "Mode", value: "Terrain" },
        ]);
        assert.equal(created.commands.length, 1);
        assert.equal(
            created.commands[0]?.commandKind,
            TRADING_JOB_COMMAND_KIND.JobCreated,
        );

        const updated = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Paused,
            floorWei: "120000000000000000",
            ceilingWei: "240000000000000000",
            deltaWei: "2000000000000000",
            quantity: 1,
            targetTraits: [
                { type: "Biome", value: "42" },
                { type: "Mode", value: "Terrain" },
            ],
        });

        assert.equal(updated.job.jobId, created.job.jobId);
        assert.equal(updated.job.revision, 2);
        assert.equal(updated.job.status, TRADING_JOB_STATUS.Paused);
        assert.equal(updated.job.floorWei, "120000000000000000");
        assert.deepEqual(
            updated.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobPaused,
            ],
        );

        const listed = repository.listCollectionJobs({
            chainId: 1,
            collectionId,
        });
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.jobId, created.job.jobId);
    });

    it("hides stale trait job runtime across pause and reactivation on the same target", () => {
        const repository = new SqliteBiddingJobsRepository();

        const created = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
            quantity: 1,
            targetTraits: [
                { type: "Mode", value: "Terrain" },
                { type: "Biome", value: "42" },
            ],
        });
        seedBiddingJobRuntimeState({
            jobId: created.job.jobId,
            currentPriceWei: "150000000000000000",
            activeOrderId: "0xtrait-active-order",
            bidPosition: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
            bidConstraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
            competitorPriceWei: "250000000000000000",
        });

        const paused = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Paused,
            floorWei: "120000000000000000",
            ceilingWei: "240000000000000000",
            deltaWei: "2000000000000000",
            quantity: 1,
            targetTraits: [
                { type: "Biome", value: "42" },
                { type: "Mode", value: "Terrain" },
            ],
        });

        assert.equal(paused.job.jobId, created.job.jobId);
        assert.equal(paused.job.revision, 2);
        assert.equal(paused.job.runtime, null);
        assert.deepEqual(
            paused.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobPaused,
            ],
        );
        assert.equal(
            paused.commands[0]?.payload.activeOrderId,
            "0xtrait-active-order",
        );
        assert.equal(
            repository.getJobById(created.job.jobId)?.runtime,
            null,
        );
        assert.equal(countRuntimeRows(created.job.jobId), 1);

        const reactivated = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "130000000000000000",
            ceilingWei: "260000000000000000",
            deltaWei: "3000000000000000",
            quantity: 1,
            targetTraits: [
                { type: "Biome", value: "42" },
                { type: "Mode", value: "Terrain" },
            ],
        });

        assert.equal(reactivated.job.jobId, created.job.jobId);
        assert.equal(reactivated.job.revision, 3);
        assert.equal(reactivated.job.status, TRADING_JOB_STATUS.Enabled);
        assert.equal(reactivated.job.runtime, null);
        assert.deepEqual(
            reactivated.commands.map((command) => command.commandKind),
            [TRADING_JOB_COMMAND_KIND.JobUpdated],
        );

        const listed = repository.listCollectionJobs({
            chainId: 1,
            collectionId,
        });
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.jobId, created.job.jobId);
        assert.equal(listed[0]?.runtime, null);
        assert.equal(countRuntimeRows(created.job.jobId), 1);
    });

    it("resolves existing jobs by canonical target equivalence", () => {
        const repository = new SqliteBiddingJobsRepository();
        const tokenJob = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
        });
        const traitJob = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
            quantity: 2,
            targetTraits: [
                { type: "Mode", value: "Terrain" },
                { type: "Biome", value: "42" },
            ],
        });

        const foundToken = repository.findJobByTarget({
            chainId: 1,
            collectionId,
            target: {
                targetKind: TRADING_JOB_TARGET_KIND.Token,
                tokenId: "123",
            },
        });
        assert.equal(foundToken?.jobId, tokenJob.job.jobId);

        const foundTrait = repository.findJobByTarget({
            chainId: 1,
            collectionId,
            target: {
                targetKind: TRADING_JOB_TARGET_KIND.Collection,
                quantity: 2,
                targetTraits: [
                    { type: "Biome", value: "42" },
                    { type: "Mode", value: "Terrain" },
                ],
            },
        });
        assert.equal(foundTrait?.jobId, traitJob.job.jobId);

        const wrongQuantity = repository.findJobByTarget({
            chainId: 1,
            collectionId,
            target: {
                targetKind: TRADING_JOB_TARGET_KIND.Collection,
                quantity: 1,
                targetTraits: [
                    { type: "Biome", value: "42" },
                    { type: "Mode", value: "Terrain" },
                ],
            },
        });
        assert.equal(wrongQuantity, null);
    });

    it("archives a collection bidding job by id and emits archive plus cancel commands", () => {
        const repository = new SqliteBiddingJobsRepository();
        const created = repository.upsertCollectionJob({
            chainId: 1,
            collectionId,
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
            quantity: 1,
            targetTraits: [{ type: "Biome", value: "42" }],
        });

        const archived = repository.archiveJobById({
            chainId: 1,
            collectionId,
            jobId: created.job.jobId,
        });

        assert.ok(archived);
        assert.equal(archived?.job.jobId, created.job.jobId);
        assert.equal(archived?.job.status, TRADING_JOB_STATUS.Archived);
        assert.equal(archived?.job.revision, 2);
        assert.deepEqual(
            archived?.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobArchived,
            ],
        );

        assert.equal(
            repository.findJobByTarget({
                chainId: 1,
                collectionId,
                target: {
                    targetKind: TRADING_JOB_TARGET_KIND.Collection,
                    quantity: 1,
                    targetTraits: [{ type: "Biome", value: "42" }],
                },
            }),
            null,
        );

        const pendingCommands = repository.listPendingCommands({ limit: 10 });
        assert.deepEqual(
            pendingCommands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.JobCreated,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobArchived,
            ],
        );
    });

    it("archives a token bidding job, hides it from active token lookups, and emits archive plus cancel commands", () => {
        const repository = new SqliteBiddingJobsRepository();
        const created = repository.upsertTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            status: TRADING_JOB_STATUS.Enabled,
            floorWei: "100000000000000000",
            ceilingWei: "200000000000000000",
            deltaWei: "1000000000000000",
        });

        const archived = repository.archiveTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
        });

        assert.ok(archived);
        assert.equal(archived?.job.jobId, created.job.jobId);
        assert.equal(archived?.job.status, TRADING_JOB_STATUS.Archived);
        assert.equal(archived?.job.revision, 2);
        assert.ok(archived?.job.archivedAt);
        assert.deepEqual(
            archived?.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobArchived,
            ],
        );

        const activeLookup = repository.getTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
        });
        assert.equal(activeLookup, null);

        const archivedLookup = repository.getTokenJob({
            chainId: 1,
            collectionId,
            tokenId: "123",
            includeArchived: true,
        });
        assert.equal(archivedLookup?.status, TRADING_JOB_STATUS.Archived);

        const listed = repository.listCollectionJobs({
            chainId: 1,
            collectionId,
        });
        assert.equal(listed.length, 0);

        const listedIncludingArchived = repository.listCollectionJobs({
            chainId: 1,
            collectionId,
            includeArchived: true,
        });
        assert.equal(listedIncludingArchived.length, 1);
        assert.equal(
            listedIncludingArchived[0]?.status,
            TRADING_JOB_STATUS.Archived,
        );

        const byId = repository.getJobById(created.job.jobId);
        assert.equal(byId?.status, TRADING_JOB_STATUS.Archived);

        const pendingCommands = repository.listPendingCommands({ limit: 10 });
        assert.deepEqual(
            pendingCommands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.JobCreated,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
                TRADING_JOB_COMMAND_KIND.JobArchived,
            ],
        );
    });
});

function seedBiddingJobRuntimeState(input: {
    jobId: string;
    jobRevision?: number;
    currentPriceWei: string;
    activeOrderId: string;
    bidPosition: TradingBiddingJobRuntimeBidPosition;
    bidConstraints: TradingBiddingJobRuntimeConstraint[];
    competitorPriceWei: string;
}): void {
    db.prepare<{
        jobId: string;
        jobRevision: number;
        currentPriceWei: string;
        activeOrderId: string;
        activeProtocolAddress: string;
        activeOrderPlacedAt: string;
        activeExpirationTimeMs: number;
        bidPosition: string;
        bidConstraintsJson: string;
        competitorPriceWei: string;
        lastRunAt: string;
        lastError: string;
    }>(
        "INSERT INTO trading_bidding_job_runtime_state " +
            "(job_id, job_revision, current_price_wei, active_order_id, active_protocol_address, active_order_placed_at, active_expiration_time_ms, bid_position, bid_constraints_json, competitor_price_wei, last_run_at, last_error) " +
            "VALUES (@jobId, @jobRevision, @currentPriceWei, @activeOrderId, @activeProtocolAddress, @activeOrderPlacedAt, @activeExpirationTimeMs, @bidPosition, @bidConstraintsJson, @competitorPriceWei, @lastRunAt, @lastError)",
    ).run({
        jobId: input.jobId,
        jobRevision: input.jobRevision ?? 1,
        currentPriceWei: input.currentPriceWei,
        activeOrderId: input.activeOrderId,
        activeProtocolAddress: ACTIVE_PROTOCOL_ADDRESS,
        activeOrderPlacedAt: ACTIVE_ORDER_PLACED_AT,
        activeExpirationTimeMs: 1_700_000_000_000,
        bidPosition: input.bidPosition,
        bidConstraintsJson: JSON.stringify(input.bidConstraints),
        competitorPriceWei: input.competitorPriceWei,
        lastRunAt: "2026-04-23T12:00:00.000Z",
        lastError: "none",
    });
}

function seedBiddingBotRuntimeState(): void {
    db.prepare(
        "INSERT INTO trading_bot_runtime_state " +
            "(bot_kind, chain_id, wallet_id, address, state, heartbeat_at, started_at, updated_at, last_error) " +
            "VALUES (@botKind, 1, @walletId, @address, @state, @heartbeatAt, @startedAt, @updatedAt, NULL)",
    ).run({
        botKind: TRADING_BOT_KIND.Bidding,
        walletId: "default",
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: TRADING_BOT_RUNTIME_STATE.Running,
        heartbeatAt: "2026-05-17T00:00:00Z",
        startedAt: "2026-05-17T00:00:00Z",
        updatedAt: "2026-05-17T00:00:00Z",
    });
}

function selectCancellationRequest(orderId: string):
    | {
          order_id: string;
          job_id: string;
          job_revision: number;
          maker: string;
          price_wei: string;
          protocol_address: string;
          placed_at: string;
          expiration_time_ms: number;
          completed_at: string | null;
          cancellation_error: string | null;
      }
    | undefined {
    return db
        .prepare<{ orderId: string }>(
            "SELECT order_id, job_id, job_revision, maker, price_wei, protocol_address, placed_at, expiration_time_ms, completed_at, cancellation_error " +
                "FROM trading_bidding_order_cancellations WHERE order_id = @orderId",
        )
        .get({ orderId }) as
        | {
              order_id: string;
              job_id: string;
              job_revision: number;
              maker: string;
              price_wei: string;
              protocol_address: string;
              placed_at: string;
              expiration_time_ms: number;
              completed_at: string | null;
              cancellation_error: string | null;
          }
        | undefined;
}

function countRuntimeRows(jobId: string): number {
    const row = db
        .prepare<{ jobId: string }>(
            "SELECT COUNT(*) AS count FROM trading_bidding_job_runtime_state WHERE job_id = @jobId",
        )
        .get({ jobId }) as { count: number };
    return row.count;
}
