import { SqliteChainProgress } from "../storage/sqlite-chain-progress.js";
import { MARKET_DATA_STORAGE_POLICY as STORAGE_POLICY } from "@artgod/shared/market-data/storage-policy";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import type { PendingCanonicalCheck } from "../../domain/canonical-check.js";
import {
    ChainSyncConflict,
    type ValidationCheckpoint,
    type ChainSyncCheckpoint,
} from "../../domain/chain-sync.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../../domain/orders.js";
import { FILL_KIND } from "@artgod/shared/market-data/fills";
import { db } from "@artgod/shared/database";
import {
    ORDER_VALIDATION_DEMAND_POLICY as POLICY,
    ORDER_VALIDATION_DEMAND_OUTCOME as OUTCOME,
    assertOrderValidationRequest,
    validationProofCovers,
    advancesValidationDemand,
    validationProofSatisfies,
    orderValidationRetryDelay,
    observedOrderValidationRequest,
    type ClaimedOrderValidation,
    type OrderValidationDemand,
    type OrderValidationEvidence,
    type OrderValidationRequest,
    type OrderValidationClaimBatch,
    type OrderValidationCompletion,
    type OrderValidationCompletionCounts,
} from "../../domain/order-validation-demand.js";
import type {
    OrderValidationDemandPort,
    OrderValidationProjectionPort,
} from "../../ports/order-validation-demand.js";
import {
    assertChainSyncCheckpoint,
    captureChainSyncCheckpoint,
} from "../storage/sqlite-chain-revisions.js";

type DemandRow = Omit<
    OrderValidationDemand,
    "pending" | "anchorIndependent"
> & { pending: number; anchorIndependent: number };
const SELECT =
    "SELECT d.chain_id AS chainId,d.order_id AS orderId,d.generation,d.revision,d.required_at AS requiredAt,d.minimum_block AS minimumBlock,d.minimum_block_hash AS minimumBlockHash,d.observation_key AS observationKey,d.admission_sequence AS admissionSequence,d.anchor_independent AS anchorIndependent,d.pending,d.proof_revision AS proofRevision,d.proof_at AS proofAt,d.proof_block AS proofBlock,d.proof_block_hash AS proofBlockHash,d.proof_admission_sequence AS proofAdmissionSequence,d.proof_chain_revision AS proofChainRevision,d.lease_owner AS leaseOwner,d.lease_version AS leaseVersion,d.lease_until AS leaseUntil,d.failures FROM order_validation_demand d ";

// Waiting rows are excluded before LIMIT. A large unsampled/bootstrap/recovery
// backlog cannot occupy leases or hide runnable work in another collection.
const READY_JOINS =
    "JOIN orders o ON o.id=d.order_id AND o.chain_id=d.chain_id " +
    "JOIN chain_sync_progress p ON p.chain_id=d.chain_id " +
    "LEFT JOIN chain_sync_revisions r ON r.chain_id=d.chain_id " +
    "JOIN collection_sync_progress c ON c.chain_id=d.chain_id AND c.collection_id=o.collection_id " +
    "JOIN blocks vb ON vb.chain_id=d.chain_id AND vb.block_number=MIN(p.applied_block,c.applied_block) " +
    "JOIN collections co ON co.chain_id=c.chain_id AND co.collection_id=c.collection_id " +
    "LEFT JOIN chain_head_samples s ON s.chain_id=d.chain_id AND s.revision=p.revision AND s.admission_watermark=(SELECT MIN(h.admission_watermark) FROM chain_head_samples h WHERE h.chain_id=d.chain_id AND h.revision=p.revision AND h.admission_watermark>=d.admission_sequence) " +
    "LEFT JOIN blocks sb ON sb.chain_id=s.chain_id AND sb.block_number=s.block_number AND sb.block_hash=s.block_hash " +
    "LEFT JOIN blocks eb ON eb.chain_id=d.chain_id AND eb.block_number=d.minimum_block AND eb.block_hash=d.minimum_block_hash ";
const READY_WHERE =
    "WHERE d.chain_id=@chainId AND d.pending=1 AND d.next_attempt_at<=@now AND d.lease_until<=@now " +
    "AND o.validation_ready=1 AND o.kind=@kind AND o.source_status=@active AND (o.valid_until IS NULL OR o.valid_until>@nowSeconds) AND o.fillability_status NOT IN (@filled,@cancelled,@expired) AND p.revision=COALESCE(r.revision,0) AND c.revision=p.revision " +
    // Signed start is a checkpoint-time prerequisite, not terminal expiry or a
    // lost obligation. Exclude waiting orders before LIMIT and lease acquisition.
    "AND (o.valid_from IS NULL OR o.valid_from<=vb.timestamp) " +
    "AND co.bootstrap_anchor_block=c.anchor_block AND co.status IN (@live,@bootstrapping) AND MIN(p.applied_block,c.applied_block)>=p.anchor_block " +
    "AND p.disputed_from IS NULL AND NOT EXISTS(SELECT 1 FROM chain_reorg_recoveries recovery WHERE recovery.chain_id=d.chain_id) " +
    "AND (d.admission_sequence=0 OR (s.block_number<=MIN(p.applied_block,c.applied_block) AND sb.block_hash IS NOT NULL)) " +
    "AND (d.minimum_block IS NULL OR (d.minimum_block<=MIN(p.applied_block,c.applied_block) AND eb.block_hash IS NOT NULL)) ";
const READY_ORDER =
    "ORDER BY d.next_attempt_at,d.lease_until,d.updated_at,d.order_id ";
function readyParams(chainId: number, now: number) {
    return {
        chainId,
        now,
        nowSeconds: Math.floor(now / 1000),
        kind: FILL_KIND.Seaport,
        active: ORDER_SOURCE_STATUS.Active,
        filled: ORDER_STATUS.Filled,
        cancelled: ORDER_STATUS.Cancelled,
        expired: ORDER_STATUS.Expired,
        live: COLLECTION_STATUS.Live,
        bootstrapping: COLLECTION_STATUS.Bootstrapping,
    };
}

/** Allocate inside the same writer as the source/scope obligation. */
export function allocateOrderValidationAdmission(chainId: number): number {
    return (
        db
            .prepare(
                "INSERT INTO chain_sync_revisions(chain_id,revision,admission_sequence) VALUES (?,0,1) ON CONFLICT(chain_id) DO UPDATE SET admission_sequence=admission_sequence+1 RETURNING admission_sequence AS sequence",
            )
            .get(chainId) as { sequence: number }
    ).sequence;
}

/** The pending row itself is the durable wakeup; polling cannot lose a sent broker message. */
export class SqliteOrderValidationDemand implements OrderValidationDemandPort {
    constructor(
        private readonly orders: OrderValidationProjectionPort,
        private readonly progress = new SqliteChainProgress(),
    ) {}

    captureSyncCheckpoint = captureChainSyncCheckpoint;
    retainDispute(check: PendingCanonicalCheck): void {
        this.progress.retainDispute(check);
    }

    hasReady(chainId: number, now: number): boolean {
        return !!db
            .prepare(
                "SELECT 1 FROM order_validation_demand d " +
                    READY_JOINS +
                    READY_WHERE +
                    "LIMIT 1",
            )
            .get(readyParams(chainId, now));
    }

    scheduleDue(chainId: number, now: number): number {
        return db.writeTransaction(() => {
            this.resolveObsoletePage(chainId, now);
            // Every newly admitted declaration already owns demand. A due index
            // schedules retained proofs without sorting or scanning the order book.
            const rows = db
                .prepare(
                    "SELECT order_id AS id,generation FROM order_validation_demand " +
                        "WHERE chain_id=? AND pending=0 AND refresh_at IS NOT NULL AND refresh_at<=? ORDER BY refresh_at,order_id LIMIT ?",
                )
                .all(chainId, now, POLICY.batchOrders) as {
                id: string;
                generation: number;
            }[];
            let admitted = 0;
            for (const row of rows) {
                const outcome = this.admit(
                    observedOrderValidationRequest(
                        chainId,
                        row.id,
                        `freshness:${row.generation}`,
                    ),
                    now,
                );
                if (outcome === OUTCOME.Pending) admitted++;
                else
                    db.prepare(
                        "UPDATE order_validation_demand SET refresh_at=NULL WHERE chain_id=? AND order_id=?",
                    ).run(chainId, row.id);
            }
            return admitted;
        })();
    }

    private resolveObsoletePage(chainId: number, now: number): void {
        const cursor = db
            .prepare(
                "SELECT after_order_id AS afterId FROM order_validation_sweeps WHERE chain_id=?",
            )
            .get(chainId) as { afterId: string } | undefined;
        const rows = db
            .prepare(
                SELECT +
                    "WHERE d.chain_id=? AND d.pending=1 AND d.order_id>? ORDER BY d.order_id LIMIT ?",
            )
            .all(
                chainId,
                cursor?.afterId ?? "",
                POLICY.batchOrders,
            ) as DemandRow[];
        for (const row of rows) {
            if (
                this.orders.validationCandidate({
                    ...row,
                    anchorIndependent: row.anchorIndependent === 1,
                    minimumBlock: row.anchorIndependent
                        ? null
                        : row.minimumBlock,
                })
            )
                continue;
            db.prepare(
                "UPDATE order_validation_demand SET pending=0,refresh_at=NULL,lease_owner=NULL,lease_until=0,claim_admission_sequence=NULL,claim_block=NULL,claim_block_hash=NULL,claim_chain_revision=NULL,updated_at=? WHERE order_id=?",
            ).run(now, row.orderId);
        }
        const afterId =
            rows.length === POLICY.batchOrders
                ? rows[rows.length - 1]!.orderId
                : "";
        if (afterId !== (cursor?.afterId ?? ""))
            db.prepare(
                "INSERT INTO order_validation_sweeps(chain_id,after_order_id) VALUES (?,?) ON CONFLICT(chain_id) DO UPDATE SET after_order_id=excluded.after_order_id",
            ).run(chainId, afterId);
    }

    private isCovered(
        request: OrderValidationRequest,
        revision: number,
    ): boolean {
        if (this.orders.validationCandidate(request)?.revision !== revision)
            return false;
        const current = this.get(request.chainId, request.orderId);
        return (
            !!current &&
            validationProofCovers(
                current,
                revision,
                request,
                captureChainSyncCheckpoint(request.chainId).revision,
            ) &&
            this.canonicalRequirementPresent(request) &&
            this.proofUsable(current)
        );
    }

    get(chainId: number, orderId: string): OrderValidationDemand | null {
        const row = db
            .prepare(SELECT + "WHERE d.chain_id=? AND d.order_id=?")
            .get(chainId, orderId) as DemandRow | undefined;
        return row
            ? {
                  ...row,
                  pending: row.pending === 1,
                  anchorIndependent: row.anchorIndependent === 1,
              }
            : null;
    }

    admit(
        request: OrderValidationRequest,
        now: number,
        checkpoint?: ChainSyncCheckpoint,
    ) {
        assertOrderValidationRequest(request);
        return db.writeTransaction(() => {
            if (checkpoint) {
                if (checkpoint.chainId !== request.chainId)
                    throw new Error("Admission checkpoint chain mismatch");
                assertChainSyncCheckpoint(checkpoint);
            }
            const candidate = this.orders.validationCandidate(request);
            if (!candidate || !this.canonicalRequirementPresent(request))
                return OUTCOME.Unneeded;
            const current = this.get(request.chainId, request.orderId);
            if (current && this.isCovered(request, candidate.revision))
                return OUTCOME.Covered;
            if (
                current &&
                !advancesValidationDemand(current, candidate.revision, request)
            )
                return OUTCOME.Pending;
            const currentChainRevision = captureChainSyncCheckpoint(
                request.chainId,
            ).revision;
            const sourceStillRequired =
                current?.pending &&
                !(
                    current.proofChainRevision === currentChainRevision &&
                    current.proofAdmissionSequence >= current.admissionSequence
                );
            let sequence = sourceStillRequired ? current!.admissionSequence : 0;
            if (request.observationKey !== null) {
                if (request.admissionSequence !== undefined) {
                    const watermark = this.progress.captureHeadSample(
                        request.chainId,
                    ).admissionWatermark;
                    if (request.admissionSequence > watermark)
                        throw new Error(
                            "Source admission sequence has not been retained",
                        );
                    sequence = Math.max(sequence, request.admissionSequence);
                } else
                    sequence = allocateOrderValidationAdmission(
                        request.chainId,
                    );
            }
            const stronger =
                request.minimumBlock !== null &&
                (current?.minimumBlock == null ||
                    request.minimumBlock >= current.minimumBlock);
            const minimumBlock = stronger
                ? request.minimumBlock
                : current?.pending
                  ? current.minimumBlock
                  : null;
            const minimumBlockHash = stronger
                ? request.minimumBlockHash
                : current?.pending
                  ? current.minimumBlockHash
                  : null;
            db.prepare(
                "INSERT INTO order_validation_demand(order_id,chain_id,revision,required_at,minimum_block,minimum_block_hash,observation_key,admission_sequence,anchor_independent,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) " +
                    "ON CONFLICT(order_id) DO UPDATE SET generation=generation+1,revision=excluded.revision,required_at=excluded.required_at,minimum_block=excluded.minimum_block,minimum_block_hash=excluded.minimum_block_hash,observation_key=excluded.observation_key,admission_sequence=excluded.admission_sequence,anchor_independent=excluded.anchor_independent,pending=1,next_attempt_at=0,updated_at=excluded.updated_at",
            ).run(
                request.orderId,
                request.chainId,
                candidate.revision,
                now,
                minimumBlock,
                minimumBlockHash,
                request.observationKey ?? current?.observationKey ?? null,
                sequence,
                sequence > 0 ? 1 : 0,
                now,
            );
            return OUTCOME.Pending;
        })();
    }

    claimBatch(
        chainId: number,
        owner: string,
        now: number,
    ): OrderValidationClaimBatch {
        return db.writeTransaction(() => {
            const first = db
                .prepare(
                    "SELECT o.collection_id AS collectionId FROM order_validation_demand d " +
                        READY_JOINS +
                        READY_WHERE +
                        READY_ORDER +
                        "LIMIT 1",
                )
                .get(readyParams(chainId, now)) as
                | { collectionId: number }
                | undefined;
            const checkpoint = first
                ? this.progress.validationCheckpoint(
                      chainId,
                      first.collectionId,
                  )
                : null;
            const empty: OrderValidationClaimBatch = {
                claims: [],
                scanned: 0,
                resolvedUnneeded: 0,
                oldestRequiredAt: null,
                checkpoint,
            };
            if (!checkpoint) return empty;
            const due = db
                .prepare(
                    SELECT +
                        READY_JOINS +
                        READY_WHERE +
                        "AND o.collection_id=@collectionId " +
                        READY_ORDER +
                        "LIMIT @limit",
                )
                .all({
                    ...readyParams(chainId, now),
                    collectionId: first!.collectionId,
                    limit: POLICY.batchOrders,
                }) as DemandRow[];
            const retry = due.findIndex(
                (row) => row.failures >= POLICY.isolateAfterFailures,
            );
            const rows = due.slice(
                0,
                retry < 0 ? due.length : Math.max(1, retry),
            );
            const batch: OrderValidationClaimBatch = {
                ...empty,
                scanned: rows.length,
                oldestRequiredAt: rows.length
                    ? Math.min(...rows.map((row) => row.requiredAt))
                    : null,
            };
            for (const row of rows) {
                const candidate = this.orders.validationCandidate({
                    ...row,
                    anchorIndependent: row.anchorIndependent === 1,
                    minimumBlock: row.anchorIndependent
                        ? null
                        : row.minimumBlock,
                });
                if (!candidate) {
                    db.prepare(
                        "UPDATE order_validation_demand SET pending=0,lease_owner=NULL,lease_until=0,claim_admission_sequence=NULL,claim_block=NULL,claim_block_hash=NULL,claim_chain_revision=NULL,updated_at=? WHERE order_id=?",
                    ).run(now, row.orderId);
                    batch.resolvedUnneeded++;
                    continue;
                }
                db.prepare(
                    "UPDATE order_validation_demand SET generation=generation+CASE WHEN revision<>? THEN 1 ELSE 0 END,revision=?,lease_owner=?,lease_version=lease_version+1,lease_until=?,claim_admission_sequence=admission_sequence,claim_block=?,claim_block_hash=?,claim_chain_revision=?,updated_at=? WHERE order_id=?",
                ).run(
                    candidate.revision,
                    candidate.revision,
                    owner,
                    now + POLICY.leaseMs,
                    checkpoint.block.number,
                    checkpoint.block.hash,
                    checkpoint.revision,
                    now,
                    row.orderId,
                );
                batch.claims.push({
                    demand: this.get(chainId, row.orderId)!,
                    candidate,
                    checkpoint,
                });
            }
            return batch;
        })();
    }

    renew(claim: ClaimedOrderValidation, now: number): boolean {
        return (
            db
                .prepare(
                    "UPDATE order_validation_demand SET lease_until=? WHERE chain_id=? AND order_id=? AND lease_owner=? AND lease_version=? AND lease_until>?",
                )
                .run(
                    now + POLICY.leaseMs,
                    claim.demand.chainId,
                    claim.demand.orderId,
                    claim.demand.leaseOwner,
                    claim.demand.leaseVersion,
                    now,
                ).changes > 0
        );
    }

    completeBatch(
        completions: readonly OrderValidationCompletion[],
        proof: OrderValidationEvidence,
        now: number,
    ): OrderValidationCompletionCounts {
        return db.writeTransaction(() => {
            this.assertEvidence(proof);
            const counts: OrderValidationCompletionCounts = {
                applied: 0,
                covered: 0,
                resolvedUnneeded: 0,
                followup: 0,
                lostClaims: 0,
            };
            for (const { claim, result } of completions) {
                if (
                    proof.checkpoint.chainId !== claim.demand.chainId ||
                    proof.checkpoint.collectionId !==
                        claim.candidate.order.collectionId ||
                    proof.checkpoint.revision !== claim.checkpoint.revision ||
                    proof.block.hash !== claim.checkpoint.block.hash
                )
                    throw new Error(
                        "Validation evidence does not match claimed checkpoint",
                    );
                const current = this.get(
                    claim.demand.chainId,
                    claim.demand.orderId,
                );
                if (!this.owns(current, claim, now)) {
                    counts.lostClaims++;
                    continue;
                }
                if (
                    !validationProofSatisfies(proof, claim.demand) ||
                    !this.canonicalRequirementPresent(claim.demand)
                )
                    throw new Error(
                        "Validation does not cover captured demand",
                    );
                if (!this.acceptsProof(current!, proof)) {
                    this.release([claim], now);
                    counts.followup++;
                    continue;
                }
                const revision = this.orders.applyDemandValidation(
                    claim,
                    result,
                    proof,
                );
                const unneeded =
                    revision === null &&
                    !this.orders.validationCandidate({
                        ...current!,
                        minimumBlock: current!.anchorIndependent
                            ? null
                            : current!.minimumBlock,
                    });
                const pending =
                    !unneeded &&
                    (revision === null ||
                        current!.generation !== claim.demand.generation);
                if (revision !== null) {
                    db.prepare(
                        "UPDATE order_validation_demand SET pending=?,revision=?,proof_revision=?,proof_at=?,proof_block=?,proof_block_hash=?,proof_admission_sequence=?,proof_chain_revision=?,minimum_block_hash=CASE WHEN minimum_block<=? THEN NULL ELSE minimum_block_hash END,minimum_block=CASE WHEN minimum_block<=? THEN NULL ELSE minimum_block END,admission_sequence=CASE WHEN admission_sequence<=? THEN 0 ELSE admission_sequence END,lease_owner=NULL,lease_until=0,claim_admission_sequence=NULL,claim_block=NULL,claim_block_hash=NULL,claim_chain_revision=NULL,refresh_at=?,failures=0,last_error=NULL,next_attempt_at=0,updated_at=? WHERE order_id=?",
                    ).run(
                        pending ? 1 : 0,
                        revision,
                        revision,
                        proof.observedAt,
                        proof.block.number,
                        proof.block.hash,
                        current!.proofChainRevision ===
                            proof.checkpoint.revision
                            ? Math.max(
                                  current!.proofAdmissionSequence,
                                  proof.admissionSequence,
                              )
                            : proof.admissionSequence,
                        proof.checkpoint.revision,
                        proof.block.number,
                        proof.block.number,
                        current!.proofChainRevision ===
                            proof.checkpoint.revision
                            ? Math.max(
                                  current!.proofAdmissionSequence,
                                  proof.admissionSequence,
                              )
                            : proof.admissionSequence,
                        [
                            ORDER_STATUS.Filled,
                            ORDER_STATUS.Cancelled,
                            ORDER_STATUS.Expired,
                        ].some((status) => status === result.status)
                            ? null
                            : proof.observedAt +
                                  STORAGE_POLICY.orderRevalidationSeconds *
                                      1000,
                        now,
                        claim.demand.orderId,
                    );
                    this.orders.refreshValidationProjection(
                        claim.demand.chainId,
                        claim.demand.orderId,
                        now,
                    );
                    counts.applied++;
                } else
                    db.prepare(
                        "UPDATE order_validation_demand SET pending=?,lease_owner=NULL,lease_until=0,claim_admission_sequence=NULL,claim_block=NULL,claim_block_hash=NULL,claim_chain_revision=NULL,updated_at=? WHERE order_id=?",
                    ).run(pending ? 1 : 0, now, claim.demand.orderId);
                if (unneeded) counts.resolvedUnneeded++;
                else if (pending) counts.followup++;
                else counts.covered++;
            }
            return counts;
        })();
    }

    private canonicalRequirementPresent(
        request: Pick<
            OrderValidationRequest,
            "chainId" | "minimumBlock" | "minimumBlockHash"
        >,
    ): boolean {
        return (
            request.minimumBlock === null ||
            !!db
                .prepare(
                    "SELECT 1 FROM blocks WHERE chain_id=? AND block_number=? AND block_hash=?",
                )
                .get(
                    request.chainId,
                    request.minimumBlock,
                    request.minimumBlockHash,
                )
        );
    }

    private proofUsable(demand: OrderValidationDemand): boolean {
        const row = db
            .prepare(
                "SELECT collection_id AS collectionId FROM orders WHERE chain_id=? AND id=?",
            )
            .get(demand.chainId, demand.orderId) as
            | { collectionId: number }
            | undefined;
        if (
            !row ||
            demand.proofBlock === null ||
            demand.proofBlockHash === null
        )
            return false;
        return (
            this.progress.validationCheckpoint(
                demand.chainId,
                row.collectionId,
                {
                    chainId: demand.chainId,
                    blockNumber: demand.proofBlock,
                    blockHash: demand.proofBlockHash,
                },
            ) !== null
        );
    }

    private acceptsProof(
        demand: OrderValidationDemand,
        proof: OrderValidationEvidence,
    ): boolean {
        return (
            demand.proofChainRevision === null ||
            demand.proofChainRevision < proof.checkpoint.revision ||
            (demand.proofChainRevision === proof.checkpoint.revision &&
                (demand.proofBlock === null ||
                    proof.block.number > demand.proofBlock ||
                    (proof.block.number === demand.proofBlock &&
                        proof.block.hash === demand.proofBlockHash &&
                        proof.admissionSequence >=
                            demand.proofAdmissionSequence)))
        );
    }

    private assertEvidence(proof: OrderValidationEvidence): void {
        this.progress.assertValidationCheckpoint(proof.checkpoint);
        if (
            proof.block.number !== proof.checkpoint.block.number ||
            proof.block.hash !== proof.checkpoint.block.hash ||
            proof.block.parentHash !== proof.checkpoint.block.parentHash ||
            proof.block.timestamp !== proof.checkpoint.block.timestamp ||
            !Number.isSafeInteger(proof.admissionSequence) ||
            proof.admissionSequence < 0
        )
            throw new Error("Invalid validation evidence");
        if (proof.admissionSequence > 0) {
            const barrier = this.progress.admissionBarrier(
                proof.checkpoint.chainId,
                proof.admissionSequence,
            );
            if (
                !barrier ||
                barrier.blockNumber > proof.block.number ||
                !this.progress.validationCheckpoint(
                    proof.checkpoint.chainId,
                    proof.checkpoint.collectionId,
                    barrier,
                )
            )
                throw new ChainSyncConflict(
                    "Validation has not covered its source admission barrier",
                );
        }
    }

    release(claims: readonly ClaimedOrderValidation[], now: number): number {
        if (!claims.length) return 0;
        return db.writeTransaction(() => {
            let released = 0;
            for (const { demand } of claims)
                released += db
                    .prepare(
                        "UPDATE order_validation_demand SET lease_owner=NULL,lease_until=0,claim_admission_sequence=NULL,claim_block=NULL,claim_block_hash=NULL,claim_chain_revision=NULL,updated_at=? WHERE order_id=? AND chain_id=? AND lease_owner=? AND lease_version=? AND lease_until>?",
                    )
                    .run(
                        now,
                        demand.orderId,
                        demand.chainId,
                        demand.leaseOwner,
                        demand.leaseVersion,
                        now,
                    ).changes;
            return released;
        })();
    }

    fail(
        claims: readonly ClaimedOrderValidation[],
        error: unknown,
        now: number,
    ): number {
        if (!claims.length) return 0;
        return db.writeTransaction(() => {
            let failed = 0;
            for (const claim of claims)
                failed += this.failClaim(claim, error, now);
            return failed;
        })();
    }

    private failClaim(
        claim: ClaimedOrderValidation,
        error: unknown,
        now: number,
    ): number {
        const failures = claim.demand.failures + 1;
        const retryMs = orderValidationRetryDelay(failures);
        return db
            .prepare(
                "UPDATE order_validation_demand SET lease_owner=NULL,lease_until=0,claim_admission_sequence=NULL,claim_block=NULL,claim_block_hash=NULL,claim_chain_revision=NULL,failures=failures+1,last_error=?,next_attempt_at=?,updated_at=? WHERE order_id=? AND chain_id=? AND lease_owner=? AND lease_version=? AND lease_until>?",
            )
            .run(
                String(error).slice(0, 1_000),
                now + retryMs,
                now,
                claim.demand.orderId,
                claim.demand.chainId,
                claim.demand.leaseOwner,
                claim.demand.leaseVersion,
                now,
            ).changes;
    }

    private owns(
        current: OrderValidationDemand | null,
        claim: ClaimedOrderValidation,
        now: number,
    ): boolean {
        return (
            current !== null &&
            current.pending &&
            current.leaseOwner === claim.demand.leaseOwner &&
            current.leaseVersion === claim.demand.leaseVersion &&
            current.leaseUntil > now
        );
    }
}

/** Shares the verified rollback writer. Signed declarations survive a fork;
 * orphaned protocol results become unvalidated and use the normal demand owner.
 * Bounded pages close their reader before issuing writes on this connection. */
export function invalidateOrderValidationFromBlock(
    chainId: number,
    fromBlock: number,
    now: number,
): void {
    // The latest executable proof and the fact first establishing a result are
    // independent. An unchanged result at 900 cannot justify proof at orphaned
    // 1000; invalidate the latter while preserving the canonical result at 900.
    const orphanedState = "o.block_number>=@fromBlock";
    const affected =
        "(" +
        orphanedState +
        " OR o.proof_block_number>=@fromBlock OR d.proof_block>=@fromBlock OR (d.pending=1 AND d.minimum_block>=@fromBlock))";
    const select = db.prepare<{
        chainId: number;
        fromBlock: number;
        afterId: string;
        limit: number;
    }>(
        "SELECT o.id,COALESCE(" +
            orphanedState +
            ",0) AS orphaned FROM orders o " +
            "LEFT JOIN order_validation_demand d ON d.order_id=o.id AND d.chain_id=o.chain_id " +
            "WHERE o.chain_id=@chainId AND o.id>@afterId AND " +
            affected +
            " ORDER BY o.id LIMIT @limit",
    );
    const reset = db.prepare<{ chainId: number; id: string; status: string }>(
        "UPDATE orders SET fillability_status=@status,quantity=NULL,fillable_quantity=NULL," +
            "validated_at=0,state_revision=state_revision+1,block_number=NULL,block_hash=NULL,tx_hash=NULL,log_index=NULL," +
            "updated_at=CURRENT_TIMESTAMP WHERE chain_id=@chainId AND id=@id",
    );
    const clearProof = db.prepare<[number, string]>(
        "UPDATE orders SET proof_block_number=NULL,proof_block_hash=NULL,proof_chain_revision=NULL,proof_admission_sequence=0," +
            "proof_order_revision=NULL,proof_at=NULL,validated_at=0 WHERE chain_id=? AND id=?",
    );
    const discard = db.prepare<[number, string]>(
        "UPDATE order_validation_demand SET pending=0,minimum_block=NULL,minimum_block_hash=NULL,admission_sequence=0," +
            "proof_revision=NULL,proof_at=NULL,proof_block=NULL,proof_block_hash=NULL,proof_admission_sequence=0,proof_chain_revision=NULL," +
            "lease_owner=NULL,lease_until=0,claim_admission_sequence=NULL,claim_block=NULL,claim_block_hash=NULL,claim_chain_revision=NULL," +
            "refresh_at=NULL WHERE chain_id=? AND order_id=?",
    );
    const admissionSequence = allocateOrderValidationAdmission(chainId);
    const observationKey = `rollback:${captureChainSyncCheckpoint(chainId).revision}:${fromBlock}`;
    const admit = db.prepare<{
        chainId: number;
        id: string;
        sequence: number;
        observationKey: string;
        now: number;
        active: string;
        kind: string;
        filled: string;
        cancelled: string;
        expired: string;
    }>(
        "INSERT INTO order_validation_demand(order_id,chain_id,revision,required_at,minimum_block,minimum_block_hash,observation_key,admission_sequence,anchor_independent,updated_at) " +
            "SELECT id,chain_id,state_revision,@now,NULL,NULL,@observationKey,@sequence,1,@now FROM orders WHERE chain_id=@chainId AND id=@id AND kind=@kind AND source_status=@active AND fillability_status NOT IN (@filled,@cancelled,@expired) AND (valid_until IS NULL OR valid_until>@now/1000) " +
            "ON CONFLICT(order_id) DO UPDATE SET generation=generation+1,revision=excluded.revision,required_at=excluded.required_at,minimum_block=NULL,minimum_block_hash=NULL,observation_key=excluded.observation_key,admission_sequence=excluded.admission_sequence,anchor_independent=1,pending=1,proof_revision=NULL,proof_at=NULL,proof_block=NULL,proof_block_hash=NULL,proof_admission_sequence=0,proof_chain_revision=NULL,lease_owner=NULL,lease_until=0,claim_admission_sequence=NULL,claim_block=NULL,claim_block_hash=NULL,claim_chain_revision=NULL,failures=0,last_error=NULL,next_attempt_at=0,updated_at=excluded.updated_at",
    );
    let afterId = "";
    while (true) {
        const rows = select.all({
            chainId,
            fromBlock,
            afterId,
            limit: POLICY.batchOrders,
        }) as { id: string; orphaned: number }[];
        if (!rows.length) return;
        for (const row of rows) {
            if (row.orphaned)
                reset.run({
                    chainId,
                    id: row.id,
                    status: ORDER_STATUS.Unvalidated,
                });
            clearProof.run(chainId, row.id);
            const retained = admit.run({
                active: ORDER_SOURCE_STATUS.Active,
                kind: FILL_KIND.Seaport,
                filled: ORDER_STATUS.Filled,
                cancelled: ORDER_STATUS.Cancelled,
                expired: ORDER_STATUS.Expired,
                chainId,
                id: row.id,
                sequence: admissionSequence,
                observationKey,
                now,
            });
            if (!retained.changes) discard.run(chainId, row.id);
        }
        afterId = rows[rows.length - 1]!.id;
    }
}

/** The rollback owner calls this after advancing the revision and retaining the
 * verified ancestor. Exact surviving hashes certify existing proofs unchanged;
 * pending obligations and captured claims keep their original fences. */
export function rebindSurvivingOrderValidationProofs(
    chainId: number,
    fromBlock: number,
    newRevision: number,
): void {
    assertChainSyncCheckpoint({ chainId, revision: newRevision });
    const values = { chainId, fromBlock, newRevision };
    db.prepare(
        "UPDATE orders SET proof_chain_revision=@newRevision WHERE chain_id=@chainId " +
            "AND proof_chain_revision=@newRevision-1 AND proof_block_number<@fromBlock " +
            "AND proof_order_revision=state_revision AND EXISTS(SELECT 1 FROM blocks b " +
            "WHERE b.chain_id=orders.chain_id AND b.block_number=orders.proof_block_number AND b.block_hash=orders.proof_block_hash)",
    ).run(values);
    db.prepare(
        "UPDATE order_validation_demand SET proof_chain_revision=@newRevision WHERE chain_id=@chainId " +
            "AND proof_chain_revision=@newRevision-1 AND proof_block<@fromBlock " +
            "AND EXISTS(SELECT 1 FROM orders o JOIN blocks b ON b.chain_id=o.chain_id " +
            "AND b.block_number=order_validation_demand.proof_block AND b.block_hash=order_validation_demand.proof_block_hash " +
            "WHERE o.chain_id=order_validation_demand.chain_id AND o.id=order_validation_demand.order_id " +
            "AND o.state_revision=order_validation_demand.proof_revision)",
    ).run(values);
}
