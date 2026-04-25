import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import {
    TRADING_BOT_KIND,
    TRADING_JOB_COMMAND_STATUS,
    type TradingJobCommandKind,
    type TradingJobCommandStatus,
} from "@artgod/shared/types";
import type {
    BiddingJobCommand,
    BiddingJobCommandRepository,
} from "../../application/use-cases/bidding/bidding-job-command-repository.js";

type TradingJobCommandRow = {
    command_id: number;
    job_id: string;
    command_kind: TradingJobCommandKind;
    status: TradingJobCommandStatus;
    requested_revision: number;
    payload_json: string;
    attempts: number;
};

export class SqliteBiddingJobCommandRepository
    implements BiddingJobCommandRepository
{
    private readonly selectClaimableCommands: BetterSqlite3NamedStatement<{
        botKind: typeof TRADING_BOT_KIND.Bidding;
        claimCutoff: string;
        limit: number;
    }>;
    private readonly claimCommandById: BetterSqlite3NamedStatement<{
        commandId: number;
    }>;
    private readonly selectCommandById: BetterSqlite3NamedStatement<{
        commandId: number;
    }>;
    private readonly completeCommandById: BetterSqlite3NamedStatement<{
        commandId: number;
    }>;
    private readonly failCommandById: BetterSqlite3NamedStatement<{
        commandId: number;
        status:
            | typeof TRADING_JOB_COMMAND_STATUS.FailedRetry
            | typeof TRADING_JOB_COMMAND_STATUS.FailedTerminal;
        lastError: string;
    }>;

    constructor() {
        this.selectClaimableCommands = db.prepare<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            claimCutoff: string;
            limit: number;
        }>(
            "SELECT command_id, job_id, command_kind, status, requested_revision, payload_json, attempts " +
                "FROM trading_job_commands " +
                "WHERE bot_kind = @botKind " +
                "AND completed_at IS NULL " +
                "AND (status IN ('pending', 'failed_retry') OR (status = 'processing' AND claimed_at < @claimCutoff)) " +
                "ORDER BY command_id ASC LIMIT @limit",
        ) as BetterSqlite3NamedStatement<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            claimCutoff: string;
            limit: number;
        }>;

        this.claimCommandById = db.prepare<{ commandId: number }>(
            "UPDATE trading_job_commands SET " +
                "status = 'processing', attempts = attempts + 1, claimed_at = CURRENT_TIMESTAMP, last_error = NULL " +
                "WHERE command_id = @commandId",
        ) as BetterSqlite3NamedStatement<{ commandId: number }>;

        this.selectCommandById = db.prepare<{ commandId: number }>(
            "SELECT command_id, job_id, command_kind, status, requested_revision, payload_json, attempts " +
                "FROM trading_job_commands WHERE command_id = @commandId LIMIT 1",
        ) as BetterSqlite3NamedStatement<{ commandId: number }>;

        this.completeCommandById = db.prepare<{ commandId: number }>(
            "UPDATE trading_job_commands SET " +
                "status = 'completed', completed_at = CURRENT_TIMESTAMP, last_error = NULL " +
                "WHERE command_id = @commandId",
        ) as BetterSqlite3NamedStatement<{ commandId: number }>;

        this.failCommandById = db.prepare<{
            commandId: number;
            status:
                | typeof TRADING_JOB_COMMAND_STATUS.FailedRetry
                | typeof TRADING_JOB_COMMAND_STATUS.FailedTerminal;
            lastError: string;
        }>(
            "UPDATE trading_job_commands SET " +
                "status = @status, last_error = @lastError " +
                "WHERE command_id = @commandId",
        ) as BetterSqlite3NamedStatement<{
            commandId: number;
            status:
                | typeof TRADING_JOB_COMMAND_STATUS.FailedRetry
                | typeof TRADING_JOB_COMMAND_STATUS.FailedTerminal;
            lastError: string;
        }>;
    }

    async claimNextBatch(params: {
        limit: number;
        claimTimeoutMs: number;
    }): Promise<BiddingJobCommand[]> {
        const claimCutoff = formatSqliteTimestamp(
            new Date(Date.now() - params.claimTimeoutMs),
        );

        // Claim commands transactionally so overlapping signal and poll paths cannot process the same row.
        return db.raw.transaction(() => {
            const rows = this.selectClaimableCommands.all({
                botKind: TRADING_BOT_KIND.Bidding,
                claimCutoff,
                limit: params.limit,
            }) as TradingJobCommandRow[];

            return rows.map((row) => {
                this.claimCommandById.run({ commandId: row.command_id });
                const claimed = this.selectCommandById.get({
                    commandId: row.command_id,
                }) as TradingJobCommandRow | undefined;
                if (!claimed) {
                    throw new Error(
                        `Failed to reload claimed trading job command ${row.command_id}`,
                    );
                }
                return this.mapRow(claimed);
            });
        })();
    }

    async markCompleted(commandId: number): Promise<void> {
        this.completeCommandById.run({ commandId });
    }

    async markFailedRetry(commandId: number, error: string): Promise<void> {
        this.failCommandById.run({
            commandId,
            status: TRADING_JOB_COMMAND_STATUS.FailedRetry,
            lastError: error,
        });
    }

    async markFailedTerminal(commandId: number, error: string): Promise<void> {
        this.failCommandById.run({
            commandId,
            status: TRADING_JOB_COMMAND_STATUS.FailedTerminal,
            lastError: error,
        });
    }

    private mapRow(row: TradingJobCommandRow): BiddingJobCommand {
        return {
            commandId: row.command_id,
            jobId: row.job_id,
            commandKind: row.command_kind,
            status: row.status,
            requestedRevision: row.requested_revision,
            payload: this.parsePayload(row),
            attempts: row.attempts,
        };
    }

    private parsePayload(
        row: TradingJobCommandRow,
    ): Record<string, unknown> {
        try {
            const parsed = JSON.parse(row.payload_json);
            return parsed && typeof parsed === "object"
                ? (parsed as Record<string, unknown>)
                : {};
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Invalid trading job command payload for commandId=${row.command_id}: ${message}`,
            );
        }
    }
}

function formatSqliteTimestamp(date: Date): string {
    return date.toISOString().replace("T", " ").slice(0, 19);
}
