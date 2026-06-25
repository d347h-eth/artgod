import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    TRADING_BOT_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
} from "@artgod/shared/types";
import { SqliteBiddingJobRuntimeState } from "./sqlite-bidding-job-runtime-state.js";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-runtime-state-"));
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
    }>(
        "INSERT INTO collections " +
            "(chain_id, slug, address, standard, status, token_scope_kind) " +
            "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind)",
    ).run({
        chainId: 1,
        slug: "terraforms",
        address: "0x1111111111111111111111111111111111111111",
        standard: "erc721",
        status: "live",
        tokenScopeKind: "contract_all_tokens",
    });
    return Number(result.lastInsertRowid);
}

function seedBiddingJob(collectionId: number): void {
    db.prepare<{
        jobId: string;
        botKind: string;
        chainId: number;
        collectionId: number;
        status: string;
        targetKind: string;
        tokenId: string | null;
    }>(
        "INSERT INTO trading_jobs " +
            "(job_id, bot_kind, chain_id, collection_id, status, target_kind, token_id) " +
            "VALUES (@jobId, @botKind, @chainId, @collectionId, @status, @targetKind, @tokenId)",
    ).run({
        jobId: "job-token",
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: 1,
        collectionId,
        status: TRADING_JOB_STATUS.Archived,
        targetKind: TRADING_JOB_TARGET_KIND.Token,
        tokenId: "123",
    });
}

describe("SqliteBiddingJobRuntimeState", () => {
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        seedBiddingJob(seedCollection());
    });

    it("records placed order timing with runtime state", () => {
        const runtimeState = new SqliteBiddingJobRuntimeState();

        runtimeState.persistJobRuntimeState({
            jobId: "job-token",
            currentPriceWei: "150000000000000000",
            activeOrderId: "0xmine",
            activeProtocolAddress:
                "0x0000000000000068f116a894984e2db1123eb395",
            activeOrderPlacedAt: "2026-05-17T00:00:00Z",
            activeExpirationTimeMs: 1_900_000_000_000,
            bidPosition: null,
            bidConstraints: [],
            competitorPriceWei: null,
            lastRunAt: "2026-05-17T00:00:01Z",
            lastError: null,
        });

        const row = db
            .prepare(
                "SELECT active_order_placed_at FROM trading_bidding_job_runtime_state WHERE job_id = ?",
            )
            .get("job-token") as { active_order_placed_at: string };

        assert.equal(row.active_order_placed_at, "2026-05-17T00:00:00Z");
    });

    it("records completed offer cancellations with the owning collection scope", () => {
        const runtimeState = new SqliteBiddingJobRuntimeState();

        runtimeState.recordJobOfferCancellation({
            jobId: "job-token",
            orderId: "0xmine",
            makerAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            requestedAt: "2026-05-17T00:00:00Z",
            completedAt: null,
            cancellationError: null,
        });
        runtimeState.recordJobOfferCancellation({
            jobId: "job-token",
            orderId: "0xmine",
            makerAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            requestedAt: "2026-05-17T00:00:00Z",
            completedAt: "2026-05-17T00:00:01Z",
            cancellationError: null,
        });
        runtimeState.recordJobOfferCancellation({
            jobId: "job-token",
            orderId: "0xmine",
            makerAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            requestedAt: "2026-05-17T00:00:02Z",
            completedAt: null,
            cancellationError: null,
        });

        const row = db.prepare<{ orderId: string }>(
            "SELECT order_id, job_id, chain_id, collection_id, maker, requested_at, completed_at, cancellation_error " +
                "FROM trading_bidding_order_cancellations WHERE order_id = @orderId",
        ).get({ orderId: "0xmine" }) as
            | {
                  order_id: string;
                  job_id: string;
                  chain_id: number;
                  collection_id: number;
                  maker: string;
                  requested_at: string;
                  completed_at: string | null;
                  cancellation_error: string | null;
              }
            | undefined;

        assert.deepEqual(row, {
            order_id: "0xmine",
            job_id: "job-token",
            chain_id: 1,
            collection_id: 1,
            maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            requested_at: "2026-05-17T00:00:02Z",
            completed_at: "2026-05-17T00:00:01Z",
            cancellation_error: null,
        });
    });
});
