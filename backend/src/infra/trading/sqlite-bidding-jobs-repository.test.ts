import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
} from "@artgod/shared/types";
import { SqliteBiddingJobsRepository } from "./sqlite-bidding-jobs-repository.js";

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

    it("updates an existing token bidding job, preserves job identity, and keeps joined runtime state", () => {
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

        db.prepare<{
            jobId: string;
            currentPriceWei: string;
            activeOrderId: string;
            activeProtocolAddress: string;
            activeExpirationTimeMs: number;
            lastRunAt: string;
            lastError: string;
        }>(
            "INSERT INTO trading_bidding_job_runtime_state " +
                "(job_id, current_price_wei, active_order_id, active_protocol_address, active_expiration_time_ms, last_run_at, last_error) " +
                "VALUES (@jobId, @currentPriceWei, @activeOrderId, @activeProtocolAddress, @activeExpirationTimeMs, @lastRunAt, @lastError)",
        ).run({
            jobId: created.job.jobId,
            currentPriceWei: "150000000000000000",
            activeOrderId: "0xactive-order",
            activeProtocolAddress: "0x00000000006c3852cbef3e08e8df289169ede581",
            activeExpirationTimeMs: 1_700_000_000_000,
            lastRunAt: "2026-04-23T12:00:00.000Z",
            lastError: "none",
        });

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
        assert.equal(updated.job.runtime?.activeOrderId, "0xactive-order");
        assert.equal(updated.job.runtime?.currentPriceWei, "150000000000000000");

        assert.equal(updated.commands.length, 2);
        assert.deepEqual(
            updated.commands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.JobPaused,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
            ],
        );
        assert.equal(updated.commands[0]?.requestedRevision, 2);

        const pendingCommands = repository.listPendingCommands({ limit: 10 });
        assert.deepEqual(
            pendingCommands.map((command) => command.commandKind),
            [
                TRADING_JOB_COMMAND_KIND.JobCreated,
                TRADING_JOB_COMMAND_KIND.JobPaused,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
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
                TRADING_JOB_COMMAND_KIND.JobArchived,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
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
                TRADING_JOB_COMMAND_KIND.JobArchived,
                TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
            ],
        );
    });
});
