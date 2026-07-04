import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    TRADING_BOT_KIND,
    TRADING_JOB_COMMAND_KIND,
    TRADING_JOB_COMMAND_STATUS,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
} from "@artgod/shared/types";
import { SqliteBiddingJobRuntimeState } from "./sqlite-bidding-job-runtime-state.js";

const RECOVERABLE_RETRY_CUTOFF = "9999-01-01T00:00:00.000Z";
const BEFORE_RECORDED_RETRY_CUTOFF = "1970-01-01T00:00:00.000Z";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-runtime-state-"));
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
            jobRevision: 1,
            currentPriceWei: "150000000000000000",
            activeOrderId: "0xmine",
            activeProtocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
            activeOrderPlacedAt: "2026-05-17T00:00:00Z",
            activeOrderVerifiedAt: "2026-05-17T00:00:02Z",
            activeExpirationTimeMs: 1_900_000_000_000,
            bidPosition: null,
            bidConstraints: [],
            competitorPriceWei: null,
            lastRunAt: "2026-05-17T00:00:01Z",
            lastError: null,
        });

        const row = db
            .prepare(
                "SELECT job_revision, active_order_placed_at, active_order_verified_at FROM trading_bidding_job_runtime_state WHERE job_id = ?",
            )
            .get("job-token") as {
            job_revision: number;
            active_order_placed_at: string;
            active_order_verified_at: string;
        };

        assert.equal(row.job_revision, 1);
        assert.equal(row.active_order_placed_at, "2026-05-17T00:00:00Z");
        assert.equal(row.active_order_verified_at, "2026-05-17T00:00:02Z");
    });

    it("marks enabled active-order evidence unverified on bot startup", () => {
        const runtimeState = new SqliteBiddingJobRuntimeState();
        db.prepare("UPDATE trading_jobs SET status = ? WHERE job_id = ?").run(
            TRADING_JOB_STATUS.Enabled,
            "job-token",
        );

        runtimeState.persistJobRuntimeState({
            jobId: "job-token",
            jobRevision: 1,
            currentPriceWei: "150000000000000000",
            activeOrderId: "0xmine",
            activeProtocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
            activeOrderPlacedAt: "2026-05-17T00:00:00Z",
            activeOrderVerifiedAt: "2026-05-17T00:00:02Z",
            activeExpirationTimeMs: 1_900_000_000_000,
            bidPosition: null,
            bidConstraints: [],
            competitorPriceWei: null,
            lastRunAt: "2026-05-17T00:00:01Z",
            lastError: null,
        });

        runtimeState.invalidateEnabledActiveOrderVerification({ chainId: 1 });

        const row = db
            .prepare(
                "SELECT active_order_id, active_order_verified_at FROM trading_bidding_job_runtime_state WHERE job_id = ?",
            )
            .get("job-token") as {
            active_order_id: string;
            active_order_verified_at: string | null;
        };

        assert.equal(row.active_order_id, "0xmine");
        assert.equal(row.active_order_verified_at, null);
    });

    it("records completed offer cancellations with the owning collection scope", () => {
        const runtimeState = new SqliteBiddingJobRuntimeState();

        runtimeState.recordJobOfferCancellation({
            jobId: "job-token",
            jobRevision: 1,
            orderId: "0xmine",
            priceWei: "150000000000000000",
            protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
            placedAt: "2026-05-17T00:00:00Z",
            expirationTimeMs: 1_900_000_000_000,
            makerAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            requestedAt: "2026-05-17T00:00:00Z",
            completedAt: null,
            cancellationError: null,
        });
        runtimeState.recordJobOfferCancellation({
            jobId: "job-token",
            jobRevision: 1,
            orderId: "0xmine",
            priceWei: "150000000000000000",
            protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
            placedAt: "2026-05-17T00:00:00Z",
            expirationTimeMs: 1_900_000_000_000,
            makerAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            requestedAt: "2026-05-17T00:00:00Z",
            completedAt: "2026-05-17T00:00:01Z",
            cancellationError: null,
        });
        runtimeState.recordJobOfferCancellation({
            jobId: "job-token",
            jobRevision: 1,
            orderId: "0xmine",
            priceWei: "150000000000000000",
            protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
            placedAt: "2026-05-17T00:00:00Z",
            expirationTimeMs: 1_900_000_000_000,
            makerAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            requestedAt: "2026-05-17T00:00:02Z",
            completedAt: null,
            cancellationError: null,
        });

        const row = db
            .prepare<{
                orderId: string;
            }>(
                "SELECT order_id, job_id, job_revision, chain_id, collection_id, maker, price_wei, protocol_address, placed_at, expiration_time_ms, requested_at, completed_at, cancellation_error " +
                    "FROM trading_bidding_order_cancellations WHERE order_id = @orderId",
            )
            .get({ orderId: "0xmine" }) as
            | {
                  order_id: string;
                  job_id: string;
                  job_revision: number;
                  chain_id: number;
                  collection_id: number;
                  maker: string;
                  price_wei: string;
                  protocol_address: string;
                  placed_at: string;
                  expiration_time_ms: number;
                  requested_at: string;
                  completed_at: string | null;
                  cancellation_error: string | null;
              }
            | undefined;

        assert.deepEqual(row, {
            order_id: "0xmine",
            job_id: "job-token",
            job_revision: 1,
            chain_id: 1,
            collection_id: 1,
            maker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            price_wei: "150000000000000000",
            protocol_address: "0x0000000000000068f116a894984e2db1123eb395",
            placed_at: "2026-05-17T00:00:00Z",
            expiration_time_ms: 1_900_000_000_000,
            requested_at: "2026-05-17T00:00:02Z",
            completed_at: "2026-05-17T00:00:01Z",
            cancellation_error: null,
        });
    });

    it("marks pending offer cancellations as failed", () => {
        const runtimeState = new SqliteBiddingJobRuntimeState();

        runtimeState.recordJobOfferCancellation({
            jobId: "job-token",
            jobRevision: 1,
            orderId: "0xmine",
            priceWei: "150000000000000000",
            protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
            placedAt: "2026-05-17T00:00:00Z",
            expirationTimeMs: 1_900_000_000_000,
            makerAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            requestedAt: "2026-05-17T00:00:00Z",
            completedAt: null,
            cancellationError: null,
        });

        runtimeState.markOfferCancellationFailed({
            jobId: "job-token",
            orderId: "0xmine",
            cancellationError: "OpenSea unavailable",
        });

        const row = db
            .prepare<{
                orderId: string;
            }>(
                "SELECT completed_at, cancellation_error FROM trading_bidding_order_cancellations WHERE order_id = @orderId",
            )
            .get({ orderId: "0xmine" }) as
            | {
                  completed_at: string | null;
                  cancellation_error: string | null;
              }
            | undefined;

        assert.deepEqual(row, {
            completed_at: null,
            cancellation_error: "OpenSea unavailable",
        });
    });

    it("lists recoverable offer cancellations and marks proven-absent rows completed", () => {
        const runtimeState = new SqliteBiddingJobRuntimeState();

        runtimeState.recordJobOfferCancellation({
            jobId: "job-token",
            jobRevision: 1,
            orderId: "0xmine",
            priceWei: "150000000000000000",
            protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
            placedAt: "2026-05-17T00:00:00Z",
            expirationTimeMs: 1_900_000_000_000,
            makerAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            requestedAt: "2026-05-17T00:00:00Z",
            completedAt: null,
            cancellationError: null,
        });
        runtimeState.markOfferCancellationFailed({
            jobId: "job-token",
            orderId: "0xmine",
            cancellationError: "OpenSea unavailable",
        });

        assert.deepEqual(
            runtimeState.listRecoverableOfferCancellations({
                chainId: 1,
                limit: 10,
                retryCutoff: BEFORE_RECORDED_RETRY_CUTOFF,
            }),
            [],
        );

        assert.deepEqual(
            runtimeState.listRecoverableOfferCancellations({
                chainId: 1,
                limit: 10,
                retryCutoff: RECOVERABLE_RETRY_CUTOFF,
            }),
            [
                {
                    jobId: "job-token",
                    orderId: "0xmine",
                    protocolAddress:
                        "0x0000000000000068f116a894984e2db1123eb395",
                    placedAt: "2026-05-17T00:00:00Z",
                    expirationTimeMs: 1_900_000_000_000,
                    collectionAddress:
                        "0x1111111111111111111111111111111111111111",
                    collectionSlug: "terraforms",
                    tokenId: "123",
                    cancellationError: "OpenSea unavailable",
                    terminalCommandError: null,
                    hasTerminalCommand: false,
                },
            ],
        );

        runtimeState.markOfferCancellationCompleted({
            jobId: "job-token",
            orderId: "0xmine",
            completedAt: "2026-05-17T00:00:05Z",
        });

        const row = db
            .prepare<{
                orderId: string;
            }>(
                "SELECT completed_at, cancellation_error FROM trading_bidding_order_cancellations WHERE order_id = @orderId",
            )
            .get({ orderId: "0xmine" }) as
            | {
                  completed_at: string | null;
                  cancellation_error: string | null;
              }
            | undefined;

        assert.deepEqual(row, {
            completed_at: "2026-05-17T00:00:05Z",
            cancellation_error: null,
        });
        assert.deepEqual(
            runtimeState.listRecoverableOfferCancellations({
                chainId: 1,
                limit: 10,
                retryCutoff: RECOVERABLE_RETRY_CUTOFF,
            }),
            [],
        );

        runtimeState.markOfferCancellationFailed({
            jobId: "job-token",
            orderId: "0xmine",
            cancellationError: "stale terminal failure",
        });

        const afterStaleFailure = db
            .prepare<{
                orderId: string;
            }>(
                "SELECT completed_at, cancellation_error FROM trading_bidding_order_cancellations WHERE order_id = @orderId",
            )
            .get({ orderId: "0xmine" }) as
            | {
                  completed_at: string | null;
                  cancellation_error: string | null;
              }
            | undefined;

        assert.deepEqual(afterStaleFailure, {
            completed_at: "2026-05-17T00:00:05Z",
            cancellation_error: null,
        });
    });

    it("lists unresolved cancellation rows when their cancel command is terminal", () => {
        const runtimeState = new SqliteBiddingJobRuntimeState();

        runtimeState.recordJobOfferCancellation({
            jobId: "job-token",
            jobRevision: 1,
            orderId: "0xmine",
            priceWei: "150000000000000000",
            protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
            placedAt: "2026-05-17T00:00:00Z",
            expirationTimeMs: 1_900_000_000_000,
            makerAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            requestedAt: "2026-05-17T00:00:00Z",
            completedAt: null,
            cancellationError: null,
        });
        db.prepare<{
            jobId: string;
            botKind: string;
            commandKind: string;
            status: string;
            requestedRevision: number;
            payloadJson: string;
            attempts: number;
            lastError: string;
        }>(
            "INSERT INTO trading_job_commands " +
                "(job_id, bot_kind, command_kind, status, requested_revision, payload_json, attempts, last_error) " +
                "VALUES (@jobId, @botKind, @commandKind, @status, @requestedRevision, @payloadJson, @attempts, @lastError)",
        ).run({
            jobId: "job-token",
            botKind: TRADING_BOT_KIND.Bidding,
            commandKind: TRADING_JOB_COMMAND_KIND.CancelActiveOffer,
            status: TRADING_JOB_COMMAND_STATUS.FailedTerminal,
            requestedRevision: 2,
            payloadJson: "{}",
            attempts: 5,
            lastError: "Unable to confirm tracked active offer",
        });

        assert.deepEqual(
            runtimeState.listRecoverableOfferCancellations({
                chainId: 1,
                limit: 10,
                retryCutoff: RECOVERABLE_RETRY_CUTOFF,
            }),
            [
                {
                    jobId: "job-token",
                    orderId: "0xmine",
                    protocolAddress:
                        "0x0000000000000068f116a894984e2db1123eb395",
                    placedAt: "2026-05-17T00:00:00Z",
                    expirationTimeMs: 1_900_000_000_000,
                    collectionAddress:
                        "0x1111111111111111111111111111111111111111",
                    collectionSlug: "terraforms",
                    tokenId: "123",
                    cancellationError: null,
                    terminalCommandError:
                        "Unable to confirm tracked active offer",
                    hasTerminalCommand: true,
                },
            ],
        );

        db.prepare(
            "UPDATE trading_job_commands SET status = ?, last_error = NULL WHERE job_id = ?",
        ).run(TRADING_JOB_COMMAND_STATUS.Completed, "job-token");

        assert.deepEqual(
            runtimeState.listRecoverableOfferCancellations({
                chainId: 1,
                limit: 10,
                retryCutoff: RECOVERABLE_RETRY_CUTOFF,
            }),
            [
                {
                    jobId: "job-token",
                    orderId: "0xmine",
                    protocolAddress:
                        "0x0000000000000068f116a894984e2db1123eb395",
                    placedAt: "2026-05-17T00:00:00Z",
                    expirationTimeMs: 1_900_000_000_000,
                    collectionAddress:
                        "0x1111111111111111111111111111111111111111",
                    collectionSlug: "terraforms",
                    tokenId: "123",
                    cancellationError: null,
                    terminalCommandError: null,
                    hasTerminalCommand: true,
                },
            ],
        );
    });

    it("preserves cancellation order details when settling from partial tracked state", () => {
        const runtimeState = new SqliteBiddingJobRuntimeState();

        runtimeState.recordJobOfferCancellation({
            jobId: "job-token",
            jobRevision: 1,
            orderId: "0xmine",
            priceWei: "150000000000000000",
            protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
            placedAt: "2026-05-17T00:00:00Z",
            expirationTimeMs: 1_900_000_000_000,
            makerAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            requestedAt: "2026-05-17T00:00:00Z",
            completedAt: null,
            cancellationError: null,
        });
        runtimeState.recordJobOfferCancellation({
            jobId: "job-token",
            jobRevision: 1,
            orderId: "0xmine",
            priceWei: null,
            protocolAddress: null,
            placedAt: null,
            expirationTimeMs: null,
            makerAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
            requestedAt: "2026-05-17T00:00:02Z",
            completedAt: "2026-05-17T00:00:03Z",
            cancellationError: null,
        });

        const row = db
            .prepare<{
                orderId: string;
            }>(
                "SELECT price_wei, protocol_address, placed_at, expiration_time_ms, requested_at, completed_at " +
                    "FROM trading_bidding_order_cancellations WHERE order_id = @orderId",
            )
            .get({ orderId: "0xmine" }) as
            | {
                  price_wei: string | null;
                  protocol_address: string | null;
                  placed_at: string | null;
                  expiration_time_ms: number | null;
                  requested_at: string;
                  completed_at: string | null;
              }
            | undefined;

        assert.deepEqual(row, {
            price_wei: "150000000000000000",
            protocol_address: "0x0000000000000068f116a894984e2db1123eb395",
            placed_at: "2026-05-17T00:00:00Z",
            expiration_time_ms: 1_900_000_000_000,
            requested_at: "2026-05-17T00:00:00Z",
            completed_at: "2026-05-17T00:00:03Z",
        });
    });
});
