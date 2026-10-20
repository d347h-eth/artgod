import { makerUpdateQueue } from "../../domain/order-processing.js";
import { decodeSyncWorkClass } from "@artgod/shared/types/sync-work-class";
import { randomUUID } from "node:crypto";
import { db } from "@artgod/shared/database";
import {
    MAKER_REVALIDATION_POLICY as POLICY,
    MAKER_REVALIDATION_STATUS as STATUS,
    MakerRevalidationConflict,
    canonicalMakerRequest,
    makerContinuationJob,
    makerValidationScopeKey,
    advancesMakerDemand,
    mergeMakerRequirements,
    type MakerRevalidationRun,
    type MakerWakeup,
} from "../../domain/maker-revalidation.js";
import type {
    MakerOrderProjectionPort,
    MakerRevalidationStore,
} from "../../ports/maker-revalidation.js";
import type {
    QueueReplayBoundary,
    QueueDeliveryOrigin,
} from "../../ports/queue.js";
import { SqliteQueueOutbox } from "../queue/sqlite-queue-outbox.js";
import type { OrderValidationDemandPort } from "../../ports/order-validation-demand.js";
import {
    ORDER_VALIDATION_DEMAND_OUTCOME,
    eventValidationRequest,
    observedOrderValidationRequest,
} from "../../domain/order-validation-demand.js";
import { captureChainSyncCheckpoint } from "../storage/sqlite-chain-revisions.js";
import { allocateOrderValidationAdmission } from "./sqlite-order-validation-demand.js";
import {
    MAKER_TRIGGER_SCOPE,
    GLOBAL_MAKER_TRIGGER_REASON,
} from "../../domain/maker-triggers.js";

type RunRow = Omit<MakerRevalidationRun, "payload" | "requestedPayload"> & {
    payloadJson: string;
    sourcePayloadJson: string;
    requestedPayloadJson: string;
};
const SELECT_RUN =
    "SELECT run_id AS runId,chain_id AS chainId,source_job_id AS sourceJobId,payload_json AS payloadJson,source_payload_json AS sourcePayloadJson,requested_payload_json AS requestedPayloadJson,scope_key AS scopeKey,required_chain_revision AS chainRevision,admission_sequence AS admissionSequence,requested_admission_sequence AS requestedAdmissionSequence,observation_key AS observationKey,requested_observation_key AS requestedObservationKey,generation,pass_generation AS passGeneration,pass_started_at AS passStartedAt,requested_at AS requestedAt,status,after_id AS afterId,upper_order_id AS upperOrderId,upper_rowid AS upperRowId,lease_owner AS leaseOwner,lease_version AS leaseVersion,lease_until AS leaseUntil,step,resolved_orders AS resolvedOrders,deferred_orders AS deferredOrders,failures,wakeup_outbox_id AS wakeupOutboxId,wakeup_generation AS wakeupGeneration FROM maker_order_revalidation_runs ";

/** Shares the projection's connection so order effects and progress have one commit boundary. */
export class SqliteMakerRevalidations implements MakerRevalidationStore {
    private readonly outbox = new SqliteQueueOutbox();
    constructor(
        private readonly orders: MakerOrderProjectionPort,
        private readonly validation: Pick<OrderValidationDemandPort, "admit">,
        private readonly wethAddress: string,
    ) {}

    scheduleWakeup(run: MakerRevalidationRun, now: number): void {
        db.writeTransaction(() => {
            const current = this.get(run.runId);
            if (
                current?.status === STATUS.Pending &&
                current.wakeupOutboxId === null
            )
                this.replaceWakeup(current, now);
        })();
    }

    private validationRequest(run: MakerRevalidationRun, orderId: string) {
        return run.payload.blockNumber == null
            ? {
                  ...observedOrderValidationRequest(
                      run.chainId,
                      orderId,
                      run.observationKey!,
                  ),
                  admissionSequence: run.admissionSequence,
              }
            : eventValidationRequest(
                  run.chainId,
                  orderId,
                  run.payload.blockNumber,
                  run.payload.blockHash!,
              );
    }

    get(runId: string): MakerRevalidationRun | undefined {
        const row = db.prepare(SELECT_RUN + "WHERE run_id=?").get(runId) as
            | RunRow
            | undefined;
        return row ? mapRun(row) : undefined;
    }

    admit(
        input: Parameters<MakerRevalidationStore["admit"]>[0],
    ): MakerRevalidationRun | null {
        return db.writeTransaction(() => {
            const payload = canonicalMakerRequest(input.payload);
            const payloadJson = JSON.stringify(payload);
            const checkpoint = captureChainSyncCheckpoint(payload.chainId);
            const observationKey =
                payload.blockNumber == null
                    ? (input.observationKey ?? input.jobId)
                    : null;
            if (observationKey === "")
                throw new MakerRevalidationConflict(
                    "Empty maker observation identity",
                );
            let row = db
                .prepare(SELECT_RUN + "WHERE chain_id=? AND source_job_id=?")
                .get(payload.chainId, input.jobId) as RunRow | undefined;
            if (row && row.sourcePayloadJson !== payloadJson)
                throw new MakerRevalidationConflict(
                    "Maker request identity reused with different payload",
                );
            const scopeKey = makerValidationScopeKey(
                payload,
                checkpoint.revision,
            );
            if (!row) {
                row = db
                    .prepare(SELECT_RUN + "WHERE chain_id=? AND scope_key=?")
                    .get(payload.chainId, scopeKey) as RunRow | undefined;
                // A canonical global event can mention any address on chain. The
                // indexed owner lookup happens inside the commit writer, after
                // source admission races have settled, and allocates no empty scope.
                if (
                    !row &&
                    payload.blockNumber != null &&
                    !this.orders.selectMakerCandidates(
                        payload,
                        "",
                        this.orders.captureMakerPass(),
                        1,
                    ).length
                )
                    return null;
                if (
                    row &&
                    advancesMakerDemand(mapRun(row), payload, observationKey)
                ) {
                    const requested = mergeMakerRequirements(
                        mapRun(row),
                        payload,
                    );
                    const sequence =
                        observationKey === null
                            ? 0
                            : allocateOrderValidationAdmission(payload.chainId);
                    db.prepare(
                        "UPDATE maker_order_revalidation_runs SET generation=generation+1,requested_payload_json=?,requested_at=?,requested_observation_key=?,requested_admission_sequence=?,required_block_number=?,required_block_hash=?,updated_at=? WHERE run_id=?",
                    ).run(
                        JSON.stringify(requested),
                        input.now,
                        observationKey,
                        sequence,
                        requested.blockNumber ?? null,
                        requested.blockHash ?? null,
                        input.now,
                        row.runId,
                    );
                    if (row.status === STATUS.Completed) {
                        this.startFollowup(row.runId, input.now);
                        this.replaceWakeup(this.get(row.runId)!, input.now);
                    }
                }
            }
            const runId = row?.runId ?? randomUUID();
            if (!row) {
                const boundary = this.orders.captureMakerPass();
                const sequence =
                    observationKey === null
                        ? 0
                        : allocateOrderValidationAdmission(payload.chainId);
                const currency =
                    payload.scope === MAKER_TRIGGER_SCOPE.Global &&
                    payload.reason !== GLOBAL_MAKER_TRIGGER_REASON.OrderCounter
                        ? this.wethAddress.toLowerCase()
                        : null;
                db.prepare<Record<string, unknown>>(
                    "INSERT INTO maker_order_revalidation_runs (run_id,chain_id,source_job_id,payload_json,source_payload_json,requested_payload_json,scope_key,requested_at,pass_started_at,status,upper_order_id,upper_rowid,created_at,updated_at,scope_kind,scope_maker,scope_collection_id,scope_token_id,scope_reason,scope_currency,required_chain_revision,required_block_number,required_block_hash,observation_key,requested_observation_key,admission_sequence,requested_admission_sequence) VALUES (@runId,@chainId,@jobId,@payloadJson,@payloadJson,@payloadJson,@scopeKey,@now,@now,@status,@upperOrderId,@upperRowId,@now,@now,@scope,@maker,@collectionId,@tokenId,@reason,@currency,@revision,@blockNumber,@blockHash,@observationKey,@observationKey,@sequence,@sequence)",
                ).run({
                    runId,
                    chainId: payload.chainId,
                    jobId: input.jobId,
                    payloadJson,
                    scopeKey,
                    now: input.now,
                    status: STATUS.Pending,
                    ...boundary,
                    scope: payload.scope,
                    maker: payload.maker,
                    collectionId:
                        payload.scope === MAKER_TRIGGER_SCOPE.Global
                            ? null
                            : payload.collectionId,
                    tokenId:
                        payload.scope === MAKER_TRIGGER_SCOPE.Token
                            ? payload.tokenId
                            : null,
                    reason: payload.reason,
                    currency,
                    revision: checkpoint.revision,
                    blockNumber: payload.blockNumber ?? null,
                    blockHash: payload.blockHash ?? null,
                    observationKey,
                    sequence,
                });
            }
            this.recordOrigin(runId, input.origin);
            return this.get(runId)!;
        })();
    }

    private startFollowup(runId: string, now: number): void {
        const boundary = this.orders.captureMakerPass();
        db.prepare(
            "UPDATE maker_order_revalidation_runs SET status=?,after_id='',payload_json=requested_payload_json,observation_key=requested_observation_key,admission_sequence=requested_admission_sequence,pass_generation=generation,pass_started_at=?,upper_order_id=?,upper_rowid=?,step=step+1,updated_at=? WHERE run_id=?",
        ).run(
            STATUS.Pending,
            now,
            boundary.upperOrderId,
            boundary.upperRowId,
            now,
            runId,
        );
    }

    private recordOrigin(runId: string, origin?: QueueDeliveryOrigin): void {
        if (!origin) return;
        db.prepare(
            "INSERT INTO maker_validation_delivery_origins (run_id,consumer_name,stream_id,maximum_sequence) VALUES (?,?,?,?) ON CONFLICT(run_id,consumer_name) DO UPDATE SET acknowledged=CASE WHEN stream_id=excluded.stream_id AND maximum_sequence>=excluded.maximum_sequence THEN acknowledged ELSE 0 END,maximum_sequence=CASE WHEN stream_id=excluded.stream_id THEN MAX(maximum_sequence,excluded.maximum_sequence) ELSE excluded.maximum_sequence END,stream_id=excluded.stream_id",
        ).run(runId, origin.consumerName, origin.streamId, origin.sequence);
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

    resume(
        input: Parameters<MakerRevalidationStore["resume"]>[0],
    ): MakerRevalidationRun | null {
        return db.writeTransaction(() => {
            const run = this.get(input.runId);
            if (!run) return null; // An old continuation never recreates an already cleaned run.
            if (
                input.chainId !== run.chainId ||
                input.step > run.step ||
                input.queueName !== makerUpdateQueue(run.payload)
            )
                throw new MakerRevalidationConflict(
                    "Invalid maker continuation identity",
                );
            if (run.status === STATUS.Completed || input.step < run.step)
                return null;
            this.recordOrigin(run.runId, input.origin);
            return this.get(run.runId)!;
        })();
    }

    expand(run: MakerRevalidationRun, now: number): MakerRevalidationRun {
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
                    "Maker expansion lost its lease or cursor fence",
                );
            // Rollback already invalidates affected order proofs. An old-history scope
            // must not recreate orphaned hash requirements or consume a new pass.
            const checkpoint = captureChainSyncCheckpoint(run.chainId);
            if (
                run.payload.blockNumber != null &&
                checkpoint.revision !== run.chainRevision
            ) {
                db.prepare(
                    "UPDATE maker_order_revalidation_runs SET status=?,lease_owner=NULL,lease_until=0,updated_at=? WHERE run_id=?",
                ).run(STATUS.Completed, now, run.runId);
                this.replaceWakeup(this.get(run.runId)!, now);
                return this.get(run.runId)!;
            }
            const candidates = this.orders.selectMakerCandidates(
                run.payload,
                run.afterId,
                run,
                POLICY.batchOrders,
            );
            let afterId = run.afterId;
            let deferred = 0;
            for (const candidate of candidates) {
                if (
                    candidate.order.chainId !== run.chainId ||
                    candidate.order.id <= afterId ||
                    candidate.order.id > run.upperOrderId
                )
                    throw new MakerRevalidationConflict(
                        "Maker expansion candidates are out of order",
                    );
                if (candidate.currentAtTrigger) {
                    // Same writer as the finite cursor and scope retirement: the scope
                    // can stop guarding reads only after demand owns every obligation.
                    const outcome = this.validation.admit(
                        this.validationRequest(run, candidate.order.id),
                        now,
                        checkpoint,
                    );
                    if (outcome === ORDER_VALIDATION_DEMAND_OUTCOME.Pending)
                        deferred++;
                }
                afterId = candidate.order.id;
            }
            const complete = candidates.length < POLICY.batchOrders;
            const followup =
                complete && current.generation > run.passGeneration;
            const finished = complete && !followup;
            db.prepare(
                "UPDATE maker_order_revalidation_runs SET after_id=?,status=?,step=step+1,resolved_orders=resolved_orders+?,deferred_orders=deferred_orders+?,failures=0,last_error=NULL,lease_owner=NULL,lease_until=0,updated_at=? WHERE run_id=?",
            ).run(
                afterId,
                finished ? STATUS.Completed : STATUS.Pending,
                candidates.length - deferred,
                deferred,
                now,
                run.runId,
            );
            if (followup) this.startFollowup(run.runId, now);
            this.replaceWakeup(this.get(run.runId)!, now);
            return this.get(run.runId)!;
        })();
    }

    private replaceWakeup(run: MakerRevalidationRun, now: number): void {
        if (run.wakeupOutboxId !== null)
            db.prepare("DELETE FROM queue_outbox WHERE outbox_id=?").run(
                run.wakeupOutboxId,
            );
        if (run.status !== STATUS.Pending) return;
        const id = this.outbox.enqueueJob(makerContinuationJob(run, now));
        db.prepare(
            "UPDATE maker_order_revalidation_runs SET wakeup_outbox_id=?,updated_at=? WHERE run_id=?",
        ).run(id, now, run.runId);
    }

    listWakeups(now: number, limit: number): MakerWakeup[] {
        return db.writeTransaction(() => {
            const rows = db
                .prepare(
                    SELECT_RUN +
                        "WHERE status=? AND lease_until<=? AND updated_at<=? ORDER BY recovery_checked_at,updated_at,run_id LIMIT ?",
                )
                .all(
                    STATUS.Pending,
                    now,
                    now - POLICY.recoveryGraceMs,
                    limit,
                ) as RunRow[];
            return rows.map((row) => {
                // Round-robin inspection prevents healthy pending deliveries starving lost ones.
                db.prepare(
                    "UPDATE maker_order_revalidation_runs SET recovery_checked_at=? WHERE run_id=?",
                ).run(now, row.runId);
                const outbox =
                    row.wakeupOutboxId === null
                        ? undefined
                        : (db
                              .prepare(
                                  "SELECT status,job_json AS jobJson,queue_name AS queueName,publication_stream_id AS streamId,publication_sequence AS sequence FROM queue_outbox WHERE outbox_id=?",
                              )
                              .get(row.wakeupOutboxId) as
                              | {
                                    status: MakerWakeup["outboxStatus"];
                                    jobJson: string;
                                    queueName: MakerWakeup["queueName"];
                                    streamId: string | null;
                                    sequence: number | null;
                                }
                              | undefined);
                return {
                    run: mapRun(row),
                    outboxStatus: outbox?.status ?? null,
                    queueName: outbox?.queueName ?? null,
                    workClass: outbox
                        ? decodeSyncWorkClass(
                              JSON.parse(outbox.jobJson).workClass,
                          )
                        : undefined,
                    publication:
                        outbox?.streamId && outbox.sequence !== null
                            ? {
                                  streamId: outbox.streamId,
                                  sequence: outbox.sequence,
                              }
                            : undefined,
                };
            });
        })();
    }

    recoverWakeup(wakeup: MakerWakeup, now: number): boolean {
        return db.writeTransaction(() => {
            const run = this.get(wakeup.run.runId);
            if (
                !run ||
                run.status !== STATUS.Pending ||
                run.leaseUntil > now ||
                run.step !== wakeup.run.step ||
                run.wakeupGeneration !== wakeup.run.wakeupGeneration ||
                run.wakeupOutboxId !== wakeup.run.wakeupOutboxId
            )
                return false;
            db.prepare(
                "UPDATE maker_order_revalidation_runs SET wakeup_generation=wakeup_generation+1,lease_owner=NULL,lease_until=0 WHERE run_id=?",
            ).run(run.runId);
            this.replaceWakeup(this.get(run.runId)!, now);
            return true;
        })();
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
        return db.writeTransaction(() => {
            // Advance each consumer's proof independently of the rotating scope scan.
            // Otherwise alternating consumers can repeatedly inspect disjoint pages.
            db.prepare(
                "UPDATE maker_validation_delivery_origins SET acknowledged=1 WHERE (run_id,consumer_name) IN (SELECT run_id,consumer_name FROM maker_validation_delivery_origins WHERE consumer_name=? AND stream_id=? AND maximum_sequence<=? AND acknowledged=0 ORDER BY maximum_sequence LIMIT ?)",
            ).run(
                boundary.consumerName,
                boundary.streamId,
                boundary.ackFloor,
                limit,
            );
            const rows = db
                .prepare(
                    SELECT_RUN +
                        "WHERE status=? ORDER BY recovery_checked_at,updated_at,run_id LIMIT ?",
                )
                .all(STATUS.Completed, limit) as RunRow[];
            let removed = 0;
            for (const row of rows) {
                const run = mapRun(row);
                db.prepare(
                    "UPDATE maker_validation_delivery_origins SET acknowledged=1 WHERE run_id=? AND consumer_name=? AND stream_id=? AND maximum_sequence<=? AND acknowledged=0",
                ).run(
                    run.runId,
                    boundary.consumerName,
                    boundary.streamId,
                    boundary.ackFloor,
                );
                const origins = db
                    .prepare(
                        "SELECT COUNT(*) AS count,SUM(acknowledged) AS acknowledged FROM maker_validation_delivery_origins WHERE run_id=?",
                    )
                    .get(run.runId) as {
                    count: number;
                    acknowledged: number | null;
                };
                const replaySafe =
                    origins.count > 0 && origins.acknowledged === origins.count;
                if (
                    !replaySafe ||
                    this.orders.selectMakerCandidates(
                        run.payload,
                        "",
                        this.orders.captureMakerPass(),
                        1,
                    ).length
                ) {
                    // A live scope's admission record survives delivery ACKs. Deferred
                    // order work belongs to demand independently of this scan receipt.
                    db.prepare(
                        "UPDATE maker_order_revalidation_runs SET recovery_checked_at=? WHERE run_id=?",
                    ).run(Date.now(), run.runId);
                } else
                    removed += db
                        .prepare(
                            "DELETE FROM maker_order_revalidation_runs WHERE run_id=?",
                        )
                        .run(run.runId).changes;
            }
            return removed;
        })();
    }
}

function mapRun(row: RunRow): MakerRevalidationRun {
    const {
        payloadJson,
        sourcePayloadJson: _sourcePayloadJson,
        requestedPayloadJson,
        ...run
    } = row;
    return {
        ...run,
        payload: JSON.parse(payloadJson),
        requestedPayload: JSON.parse(requestedPayloadJson),
    };
}
