import { db } from "@artgod/shared/database";
import type {
    OpenSeaOrderbookRunInput,
    OpenSeaOrderbookRunsPort,
} from "../../ports/opensea-orderbook-runs.js";

export class SqliteOpenSeaOrderbookRuns implements OpenSeaOrderbookRunsPort {
    private insertRun = db.prepare<{
        chainId: number;
        collectionId: number;
        kind: string;
        status: string;
    }>(
        "INSERT INTO opensea_orderbook_runs " +
            "(chain_id, collection_id, kind, status) " +
            "VALUES (@chainId, @collectionId, @kind, @status)",
    );
    private completeRunStmt = db.prepare<{ runId: number }>(
        "UPDATE opensea_orderbook_runs SET " +
            "status = 'completed', " +
            "completed_at = CURRENT_TIMESTAMP, " +
            "error_message = NULL " +
            "WHERE run_id = @runId",
    );
    private failRunStmt = db.prepare<{ runId: number; errorMessage: string }>(
        "UPDATE opensea_orderbook_runs SET " +
            "status = 'failed', " +
            "completed_at = CURRENT_TIMESTAMP, " +
            "error_message = @errorMessage " +
            "WHERE run_id = @runId",
    );

    startRun(input: OpenSeaOrderbookRunInput): number {
        const result = this.insertRun.run({
            chainId: input.chainId,
            collectionId: input.collectionId,
            kind: input.kind,
            status: "running",
        });
        return Number(result.lastInsertRowid);
    }

    completeRun(runId: number): boolean {
        return this.completeRunStmt.run({ runId }).changes > 0;
    }

    failRun(runId: number, errorMessage: string): boolean {
        return (
            this.failRunStmt.run({
                runId,
                errorMessage,
            }).changes > 0
        );
    }
}
