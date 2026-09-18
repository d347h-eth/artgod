import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    COLLECTION_STANDARD,
    COLLECTION_STATUS,
    TRADING_BOT_KIND,
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_COMMAND_STATUS,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
} from "@artgod/shared/types";
import { SqliteBiddingJobCommandRepository } from "./sqlite-bidding-job-command-repository.js";
import { BIDDING_COMMAND_QUEUE_STATUS } from "../../application/use-cases/bidding/bidding-command-queue-health.js";

// Command repository tests seed an isolated collection fixture.
const JOB_COMMAND_FIXTURE_SLUG = "job-command-fixture";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-command-repo-"));
    return join(dir, "main.sqlite");
}

function seedCollection(): number {
    const result = db
        .prepare<{
            chainId: number;
            slug: string;
            address: string;
            standard: string;
            status: string;
            tokenScopeKind: string;
        }>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind) " +
                "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind)",
        )
        .run({
            chainId: 1,
            slug: JOB_COMMAND_FIXTURE_SLUG,
            address: "0x1111111111111111111111111111111111111111",
            standard: COLLECTION_STANDARD.Erc721,
            status: COLLECTION_STATUS.Live,
            tokenScopeKind:
                EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
        });

    return Number(result.lastInsertRowid);
}

function seedJob(collectionId: number): string {
    const jobId = "job-token";
    db.prepare<{
        jobId: string;
        botKind: string;
        chainId: number;
        collectionId: number;
        status: string;
        targetKind: string;
        tokenId: string;
    }>(
        "INSERT INTO trading_jobs " +
            "(job_id, bot_kind, chain_id, collection_id, status, target_kind, token_id) " +
            "VALUES (@jobId, @botKind, @chainId, @collectionId, @status, @targetKind, @tokenId)",
    ).run({
        jobId,
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: 1,
        collectionId,
        status: TRADING_JOB_STATUS.Enabled,
        targetKind: TRADING_JOB_TARGET_KIND.Token,
        tokenId: "1",
    });
    db.prepare<{ jobId: string }>(
        "INSERT INTO trading_bidding_job_specs " +
            "(job_id, floor_wei, ceiling_wei, delta_wei) " +
            "VALUES (@jobId, '100000000000000000', '200000000000000000', '1000000000000000')",
    ).run({ jobId });
    return jobId;
}

function seedCommand(params: {
    jobId: string;
    status: string;
    claimedAt?: string | null;
    createdAt?: string;
}): number {
    const result = db
        .prepare<{
            jobId: string;
            botKind: string;
            commandKind: string;
            status: string;
            requestedRevision: number;
            payloadJson: string;
            claimedAt: string | null;
            createdAt: string | null;
        }>(
            "INSERT INTO trading_job_commands " +
                "(job_id, bot_kind, command_kind, status, requested_revision, payload_json, created_at, claimed_at) " +
                "VALUES (@jobId, @botKind, @commandKind, @status, @requestedRevision, @payloadJson, COALESCE(@createdAt, CURRENT_TIMESTAMP), @claimedAt)",
        )
        .run({
            jobId: params.jobId,
            botKind: TRADING_BOT_KIND.Bidding,
            commandKind: TRADING_JOB_COMMAND_KIND.JobUpdated,
            status: params.status,
            requestedRevision: 1,
            payloadJson: JSON.stringify({ jobId: params.jobId }),
            claimedAt: params.claimedAt ?? null,
            createdAt: params.createdAt ?? null,
        });
    return Number(result.lastInsertRowid);
}

function getCommandRow(commandId: number): {
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: string | null;
    claimed_at: string | null;
    completed_at: string | null;
} {
    return db
        .prepare<{
            commandId: number;
        }>(
            "SELECT status, attempts, last_error, created_at, claimed_at, completed_at FROM trading_job_commands WHERE command_id = @commandId",
        )
        .get({ commandId }) as {
        status: string;
        attempts: number;
        last_error: string | null;
        created_at: string | null;
        claimed_at: string | null;
        completed_at: string | null;
    };
}

describe("SqliteBiddingJobCommandRepository", () => {
    let jobId = "";

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        jobId = seedJob(seedCollection());
    });

    it("claims pending commands and marks them completed", async () => {
        const createdAt = "2026-07-14 10:00:00";
        const commandId = seedCommand({
            jobId,
            status: TRADING_JOB_COMMAND_STATUS.Pending,
            createdAt,
        });
        const repository = new SqliteBiddingJobCommandRepository();

        const commands = await repository.claimNextBatch({
            limit: 10,
            claimTimeoutMs: 300_000,
        });

        assert.equal(commands.length, 1);
        assert.equal(commands[0]?.commandId, commandId);
        assert.equal(commands[0]?.attempts, 1);
        assert.equal(commands[0]?.reclaimed, false);
        const claimed = getCommandRow(commandId);
        assert.match(claimed.claimed_at ?? "", /\.\d{3}$/);
        assert.equal(
            commands[0]?.createdAtMs,
            Date.parse("2026-07-14T10:00:00Z"),
        );
        assert.equal(
            commands[0]?.claimedAtMs,
            Date.parse(`${claimed.claimed_at?.replace(" ", "T")}Z`),
        );
        assert.ok(commands[0]?.claimedAtMs);
        assert.equal(claimed.status, "processing");

        await repository.markCompleted(commandId);

        const completed = getCommandRow(commandId);
        assert.equal(completed.status, "completed");
        assert.ok(completed.completed_at);
    });

    it("reclaims stale processing commands and records retry failures", async () => {
        const commandId = seedCommand({
            jobId,
            status: TRADING_JOB_COMMAND_STATUS.Processing,
            claimedAt: "2000-01-01 00:00:00",
        });
        const repository = new SqliteBiddingJobCommandRepository();

        const commands = await repository.claimNextBatch({
            limit: 10,
            claimTimeoutMs: 1_000,
        });

        assert.equal(commands.length, 1);
        assert.equal(commands[0]?.reclaimed, true);
        assert.equal(commands[0]?.attempts, 1);

        await repository.markFailedRetry(commandId, "temporary failure");

        const failed = getCommandRow(commandId);
        assert.equal(failed.status, "failed_retry");
        assert.equal(failed.last_error, "temporary failure");
    });

    it("reads backlog health without claiming rows or counting completed history", async () => {
        const pending = seedCommand({
            jobId,
            status: TRADING_JOB_COMMAND_STATUS.Pending,
            createdAt: "2001-01-01 00:00:00.500",
        });
        seedCommand({
            jobId,
            status: TRADING_JOB_COMMAND_STATUS.FailedRetry,
            createdAt: "2000-01-01 00:00:00.250",
        });
        seedCommand({
            jobId,
            status: TRADING_JOB_COMMAND_STATUS.Processing,
            claimedAt: "2000-01-01 00:00:00",
        });
        seedCommand({
            jobId,
            status: TRADING_JOB_COMMAND_STATUS.Processing,
            claimedAt: "2999-01-01 00:00:00",
        });
        seedCommand({
            jobId,
            status: TRADING_JOB_COMMAND_STATUS.FailedTerminal,
        });
        seedCommand({
            jobId,
            status: TRADING_JOB_COMMAND_STATUS.Completed,
            createdAt: "1990-01-01 00:00:00",
        });
        const repository = new SqliteBiddingJobCommandRepository();
        assert.deepEqual(await repository.readQueueHealth(1000), {
            counts: {
                [BIDDING_COMMAND_QUEUE_STATUS.Pending]: 1,
                [BIDDING_COMMAND_QUEUE_STATUS.Retrying]: 1,
                [BIDDING_COMMAND_QUEUE_STATUS.Processing]: 2,
                [BIDDING_COMMAND_QUEUE_STATUS.FailedTerminal]: 1,
            },
            oldestPendingAtMs: Date.parse("2000-01-01T00:00:00.250Z"),
            staleProcessing: 1,
        });
        assert.equal(
            getCommandRow(pending).status,
            TRADING_JOB_COMMAND_STATUS.Pending,
        );
        assert.equal(getCommandRow(pending).attempts, 0);
    });

    it("continues claiming one command at a time after writer contention", async () => {
        const firstId = seedCommand({
            jobId,
            status: TRADING_JOB_COMMAND_STATUS.Pending,
        });
        const secondId = seedCommand({
            jobId,
            status: TRADING_JOB_COMMAND_STATUS.Pending,
        });
        const repository = new SqliteBiddingJobCommandRepository();
        const claimOptions = { limit: 1, claimTimeoutMs: 300_000 };
        db.raw.pragma("busy_timeout = 0");
        const competitor = new Database(db.raw.name);
        competitor.exec("BEGIN IMMEDIATE");
        // Release at the retry boundary so the first claim must encounter a real lock.
        const backoff = vi.spyOn(Atomics, "wait").mockImplementationOnce(() => {
            assert.equal(getCommandRow(firstId).attempts, 0);
            assert.equal(getCommandRow(secondId).attempts, 0);
            competitor.exec("COMMIT");
            return "ok";
        });

        try {
            const first = await repository.claimNextBatch(claimOptions);
            assert.equal(backoff.mock.calls.length, 1);
            assert.deepEqual(
                first.map((command) => command.commandId),
                [firstId],
            );
            assert.equal(getCommandRow(firstId).attempts, 1);
            assert.equal(
                getCommandRow(secondId).status,
                TRADING_JOB_COMMAND_STATUS.Pending,
            );

            const second = await repository.claimNextBatch(claimOptions);
            assert.deepEqual(
                second.map((command) => command.commandId),
                [secondId],
            );
            assert.equal(getCommandRow(secondId).attempts, 1);
            assert.deepEqual(await repository.claimNextBatch(claimOptions), []);
        } finally {
            backoff.mockRestore();
            competitor.close();
        }
    });
});
