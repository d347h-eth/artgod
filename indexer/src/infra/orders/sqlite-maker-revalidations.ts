import { randomUUID } from "node:crypto";
import { db } from "@artgod/shared/database";
import {
    MAKER_REVALIDATION_POLICY as POLICY,
    MAKER_REVALIDATION_STATUS as STATUS,
    MakerRevalidationConflict,
    canonicalMakerRequest,
    type MakerRevalidationRun,
    type MakerValidationResolution,
} from "../../domain/maker-revalidation.js";
import type {
    MakerOrderProjectionPort,
    MakerRevalidationStore,
} from "../../ports/maker-revalidation.js";
import type { QueueReplayBoundary } from "../../ports/queue.js";

type RunRow = Omit<MakerRevalidationRun, "payload" | "origin"> & {
    payloadJson: string;
    originStreamId: string | null;
    originConsumer: string | null;
    originSequence: number | null;
};
const SELECT_RUN =
    "SELECT run_id AS runId,chain_id AS chainId,source_job_id AS sourceJobId,payload_json AS payloadJson,status,after_id AS afterId,upper_order_id AS upperOrderId,upper_rowid AS upperRowId,lease_owner AS leaseOwner,lease_version AS leaseVersion,lease_until AS leaseUntil,step,resolved_orders AS resolvedOrders,failures,origin_stream_id AS originStreamId,origin_consumer AS originConsumer,origin_sequence AS originSequence FROM maker_order_revalidation_runs ";

/** Shares the projection's connection so order effects and progress have one commit boundary. */
export class SqliteMakerRevalidations implements MakerRevalidationStore {
    constructor(private readonly orders: MakerOrderProjectionPort) {}

    get(runId: string): MakerRevalidationRun | undefined {
        const row = db.prepare(SELECT_RUN + "WHERE run_id=?").get(runId) as
            | RunRow
            | undefined;
        return row ? mapRun(row) : undefined;
    }

    admit(
        input: Parameters<MakerRevalidationStore["admit"]>[0],
    ): MakerRevalidationRun {
        return db.writeTransaction(() => {
            const row = db
                .prepare(SELECT_RUN + "WHERE chain_id=? AND source_job_id=?")
                .get(input.payload.chainId, input.jobId) as RunRow | undefined;
            const payloadJson = JSON.stringify(
                canonicalMakerRequest(input.payload),
            );
            if (row && row.payloadJson !== payloadJson)
                throw new MakerRevalidationConflict(
                    "Maker request identity reused with different payload",
                );
            const runId = row?.runId ?? randomUUID();
            if (!row) {
                const boundary = this.orders.captureMakerPass();
                db.prepare<Record<string, unknown>>(
                    "INSERT INTO maker_order_revalidation_runs (run_id,chain_id,source_job_id,payload_json,status,upper_order_id,upper_rowid,created_at,updated_at) VALUES (@runId,@chainId,@jobId,@payloadJson,@status,@upperOrderId,@upperRowId,@now,@now)",
                ).run({
                    runId,
                    chainId: input.payload.chainId,
                    jobId: input.jobId,
                    payloadJson,
                    status: STATUS.Pending,
                    ...boundary,
                    now: input.now,
                });
            }
            if (input.origin) {
                db.prepare(
                    "UPDATE maker_order_revalidation_runs SET origin_sequence=CASE WHEN origin_stream_id=? AND origin_consumer=? THEN MAX(COALESCE(origin_sequence,0),?) ELSE ? END,origin_stream_id=?,origin_consumer=? WHERE run_id=?",
                ).run(
                    input.origin.streamId,
                    input.origin.consumerName,
                    input.origin.sequence,
                    input.origin.sequence,
                    input.origin.streamId,
                    input.origin.consumerName,
                    runId,
                );
            }
            return this.get(runId)!;
        })();
    }

    claim(
        runId: string,
        owner: string,
        now: number,
    ): MakerRevalidationRun | null {
        return db.writeTransaction(() => {
            const changed = db
                .prepare(
                    "UPDATE maker_order_revalidation_runs SET lease_owner=?,lease_version=lease_version+1,lease_until=?,updated_at=? WHERE run_id=? AND status=? AND (lease_owner IS NULL OR lease_until<=?)",
                )
                .run(
                    owner,
                    now + POLICY.leaseMs,
                    now,
                    runId,
                    STATUS.Pending,
                    now,
                );
            return changed.changes ? this.get(runId)! : null;
        })();
    }

    next(run: MakerRevalidationRun, limit: number) {
        return this.orders.selectMakerCandidates(
            run.payload,
            run.afterId,
            run,
            limit,
        );
    }

    checkpoint(
        run: MakerRevalidationRun,
        resolutions: MakerValidationResolution[],
        complete: boolean,
        now: number,
    ): MakerRevalidationRun {
        return db.writeTransaction(() => {
            const current = this.get(run.runId);
            if (
                !current ||
                current.status !== STATUS.Pending ||
                current.leaseOwner !== run.leaseOwner ||
                current.leaseVersion !== run.leaseVersion ||
                current.leaseUntil <= now ||
                current.afterId !== run.afterId ||
                current.step !== run.step
            )
                throw new MakerRevalidationConflict(
                    "Maker checkpoint lost its lease or cursor fence",
                );
            let afterId = run.afterId;
            for (const resolution of resolutions) {
                const order = resolution.candidate.order;
                if (
                    order.chainId !== run.chainId ||
                    order.id <= afterId ||
                    order.id > run.upperOrderId
                )
                    throw new MakerRevalidationConflict(
                        "Maker checkpoint candidates are out of order",
                    );
                this.orders.applyMakerResolution(run.payload, resolution);
                afterId = order.id;
            }
            db.prepare(
                "UPDATE maker_order_revalidation_runs SET after_id=?,status=?,step=step+1,resolved_orders=resolved_orders+?,failures=0,last_error=NULL,lease_owner=?,lease_until=?,updated_at=? WHERE run_id=?",
            ).run(
                afterId,
                complete ? STATUS.Completed : STATUS.Pending,
                resolutions.length,
                complete ? null : run.leaseOwner,
                complete ? 0 : now + POLICY.leaseMs,
                now,
                run.runId,
            );
            return this.get(run.runId)!;
        })();
    }

    renew(run: MakerRevalidationRun, now: number): boolean {
        return (
            db
                .prepare(
                    "UPDATE maker_order_revalidation_runs SET lease_until=? WHERE run_id=? AND lease_owner=? AND lease_version=? AND status=? AND lease_until>?",
                )
                .run(
                    now + POLICY.leaseMs,
                    run.runId,
                    run.leaseOwner,
                    run.leaseVersion,
                    STATUS.Pending,
                    now,
                ).changes > 0
        );
    }

    release(run: MakerRevalidationRun, now: number, error?: unknown): void {
        db.prepare(
            "UPDATE maker_order_revalidation_runs SET lease_owner=NULL,lease_until=0,failures=failures+?,last_error=?,updated_at=? WHERE run_id=? AND lease_owner=? AND lease_version=? AND status=?",
        ).run(
            error === undefined ? 0 : 1,
            error === undefined ? null : String(error),
            now,
            run.runId,
            run.leaseOwner,
            run.leaseVersion,
            STATUS.Pending,
        );
    }

    cleanup(boundary: QueueReplayBoundary, limit: number): number {
        // A missing origin or a different broker incarnation is never age-expired.
        return db
            .prepare(
                "DELETE FROM maker_order_revalidation_runs WHERE run_id IN (SELECT run_id FROM maker_order_revalidation_runs WHERE status=? AND origin_stream_id=? AND origin_consumer=? AND origin_sequence<=? ORDER BY origin_sequence LIMIT ?)",
            )
            .run(
                STATUS.Completed,
                boundary.streamId,
                boundary.consumerName,
                boundary.ackFloor,
                limit,
            ).changes;
    }
}

function mapRun(row: RunRow): MakerRevalidationRun {
    const {
        payloadJson,
        originStreamId,
        originConsumer,
        originSequence,
        ...run
    } = row;
    return {
        ...run,
        payload: JSON.parse(payloadJson),
        origin:
            originStreamId && originConsumer && originSequence !== null
                ? {
                      streamId: originStreamId,
                      consumerName: originConsumer,
                      sequence: originSequence,
                  }
                : undefined,
    };
}
