import type { ChainSyncCheckpoint } from "../../domain/chain-sync.js";
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
    "SELECT chain_id AS chainId,order_id AS orderId,generation,revision,required_at AS requiredAt,minimum_block AS minimumBlock,anchor_independent AS anchorIndependent,pending,proof_revision AS proofRevision,proof_at AS proofAt,proof_block AS proofBlock,proof_chain_revision AS proofChainRevision,lease_owner AS leaseOwner,lease_version AS leaseVersion,lease_until AS leaseUntil,failures FROM order_validation_demand ";

/** The pending row itself is the durable wakeup; polling cannot lose a sent broker message. */
export class SqliteOrderValidationDemand implements OrderValidationDemandPort {
    constructor(private readonly orders: OrderValidationProjectionPort) {}

    captureSyncCheckpoint = captureChainSyncCheckpoint;
    needsValidation(request: OrderValidationRequest): boolean {
        return this.orders.validationCandidate(request) !== null;
    }

    isCovered(request: OrderValidationRequest, revision: number): boolean {
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
            )
        );
    }

    recordValidation(
        request: OrderValidationRequest,
        revision: number,
        evidence: OrderValidationEvidence,
        now: number,
    ): void {
        if (evidence.checkpoint.chainId !== request.chainId)
            throw new Error("Validation evidence chain mismatch");
        assertChainSyncCheckpoint(evidence.checkpoint);
        if (!validationProofSatisfies(evidence, request))
            throw new Error("Validation does not cover maker requirement");
        const current = this.get(request.chainId, request.orderId);
        const pending =
            !!current?.pending && !validationProofSatisfies(evidence, current);
        db.prepare(
            "INSERT INTO order_validation_demand(order_id,chain_id,revision,required_at,minimum_block,anchor_independent,pending,proof_revision,proof_at,proof_block,proof_chain_revision,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET revision=excluded.revision,pending=excluded.pending,proof_revision=excluded.proof_revision,proof_at=excluded.proof_at,proof_block=excluded.proof_block,proof_chain_revision=excluded.proof_chain_revision,lease_owner=NULL,lease_until=0,failures=0,last_error=NULL,next_attempt_at=0,updated_at=excluded.updated_at",
        ).run(
            request.orderId,
            request.chainId,
            revision,
            request.requiredAt,
            request.minimumBlock,
            request.minimumBlock === null || request.anchorIndependent ? 1 : 0,
            pending ? 1 : 0,
            revision,
            evidence.observedAt,
            evidence.blockNumber,
            evidence.checkpoint.revision,
            now,
        );
    }

    get(chainId: number, orderId: string): OrderValidationDemand | null {
        const row = db
            .prepare(SELECT + "WHERE chain_id=? AND order_id=?")
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
                    throw new Error("Execution coverage chain mismatch");
                assertChainSyncCheckpoint(checkpoint);
            }
            const candidate = this.orders.validationCandidate(request);
            if (!candidate) return OUTCOME.Unneeded;
            const current = this.get(request.chainId, request.orderId);
            if (current && this.isCovered(request, candidate.revision))
                return OUTCOME.Covered;
            if (!current) {
                db.prepare(
                    "INSERT INTO order_validation_demand (order_id,chain_id,revision,required_at,minimum_block,anchor_independent,updated_at) VALUES (?,?,?,?,?,?,?)",
                ).run(
                    request.orderId,
                    request.chainId,
                    candidate.revision,
                    request.requiredAt,
                    request.minimumBlock,
                    request.minimumBlock === null || request.anchorIndependent
                        ? 1
                        : 0,
                    now,
                );
            } else if (
                advancesValidationDemand(current, candidate.revision, request)
            ) {
                db.prepare(
                    "UPDATE order_validation_demand SET generation=generation+1,revision=?,required_at=MAX(required_at,?),minimum_block=CASE WHEN ? IS NULL THEN minimum_block WHEN minimum_block IS NULL THEN ? ELSE MAX(minimum_block,?) END,anchor_independent=?,pending=1,next_attempt_at=0,updated_at=? WHERE chain_id=? AND order_id=?",
                ).run(
                    candidate.revision,
                    request.requiredAt,
                    request.minimumBlock,
                    request.minimumBlock,
                    request.minimumBlock,
                    request.minimumBlock === null ||
                        request.anchorIndependent ||
                        (current.pending && current.anchorIndependent)
                        ? 1
                        : 0,
                    now,
                    request.chainId,
                    request.orderId,
                );
            }
            return OUTCOME.Pending;
        })();
    }

    defer(request: OrderValidationRequest, error: string, now: number) {
        return db.writeTransaction(() => {
            const outcome = this.admit(request, now);
            if (outcome === OUTCOME.Pending) {
                // Retry this known failure alone, preserving stronger requirements
                // and an existing executor's lease.
                db.prepare(
                    "UPDATE order_validation_demand SET failures=MAX(failures,?),next_attempt_at=MAX(next_attempt_at,?),last_error=?,updated_at=? WHERE chain_id=? AND order_id=?",
                ).run(
                    POLICY.isolateAfterFailures,
                    now + POLICY.retryBaseMs,
                    error,
                    now,
                    request.chainId,
                    request.orderId,
                );
            }
            return outcome;
        })();
    }

    claimBatch(
        chainId: number,
        owner: string,
        now: number,
    ): OrderValidationClaimBatch {
        return db.writeTransaction(() => {
            // Retired/ineligible rows cannot make one tick scan an unbounded backlog.
            const due = db
                .prepare(
                    SELECT +
                        "WHERE chain_id=? AND pending=1 AND next_attempt_at<=? AND lease_until<=? ORDER BY next_attempt_at,lease_until,updated_at,order_id LIMIT ?",
                )
                .all(chainId, now, now, POLICY.batchOrders) as DemandRow[];
            // Repeatedly failed snapshots must not keep unrelated orders in one retry
            // group forever. Retry those rows alone, retaining due-order fairness and
            // fresh batches for the preceding rows. A first transient failure still batches.
            const retry = due.findIndex(
                (row) => row.failures >= POLICY.isolateAfterFailures,
            );
            const rows = due.slice(
                0,
                retry < 0 ? due.length : Math.max(1, retry),
            );
            const batch: OrderValidationClaimBatch = {
                claims: [],
                scanned: rows.length,
                resolvedUnneeded: 0,
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
                        "UPDATE order_validation_demand SET pending=0,lease_owner=NULL,lease_until=0,proof_revision=NULL,proof_at=NULL,proof_block=NULL,updated_at=? WHERE order_id=?",
                    ).run(now, row.orderId);
                    batch.resolvedUnneeded++;
                    continue;
                }
                db.prepare(
                    "UPDATE order_validation_demand SET generation=generation+CASE WHEN revision<>? THEN 1 ELSE 0 END,revision=?,lease_owner=?,lease_version=lease_version+1,lease_until=?,updated_at=? WHERE order_id=?",
                ).run(
                    candidate.revision,
                    candidate.revision,
                    owner,
                    now + POLICY.leaseMs,
                    now,
                    row.orderId,
                );
                batch.claims.push({
                    demand: this.get(chainId, row.orderId)!,
                    candidate,
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
        // One bounded commit follows snapshot verification; RPC never holds this transaction.
        return db.writeTransaction(() => {
            assertChainSyncCheckpoint(proof.checkpoint);
            const counts: OrderValidationCompletionCounts = {
                applied: 0,
                covered: 0,
                resolvedUnneeded: 0,
                followup: 0,
                lostClaims: 0,
            };
            for (const { claim, result } of completions) {
                if (proof.checkpoint.chainId !== claim.demand.chainId)
                    throw new Error("Validation evidence chain mismatch");
                const current = this.get(
                    claim.demand.chainId,
                    claim.demand.orderId,
                );
                if (!this.owns(current, claim, now)) {
                    counts.lostClaims++;
                    continue;
                }
                if (!validationProofSatisfies(proof, claim.demand))
                    throw new Error(
                        "Validation snapshot does not cover captured demand",
                    );
                const revision = this.orders.applyDemandValidation(
                    claim,
                    result,
                    proof,
                );
                // A terminal source/expiry/anchor change can resolve this obligation now.
                // A changed but still actionable revision or generation must remain pending.
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
                db.prepare(
                    "UPDATE order_validation_demand SET pending=?,revision=COALESCE(?,revision),proof_revision=?,proof_at=?,proof_block=?,proof_chain_revision=?,lease_owner=NULL,lease_until=0,failures=0,last_error=NULL,next_attempt_at=0,updated_at=? WHERE order_id=?",
                ).run(
                    pending ? 1 : 0,
                    revision,
                    revision,
                    revision === null ? null : proof.observedAt,
                    revision === null ? null : proof.blockNumber,
                    revision === null ? null : proof.checkpoint.revision,
                    now,
                    claim.demand.orderId,
                );
                if (revision !== null) counts.applied++;
                if (unneeded) counts.resolvedUnneeded++;
                else if (pending) counts.followup++;
                else counts.covered++;
            }
            return counts;
        })();
    }

    release(claims: readonly ClaimedOrderValidation[], now: number): number {
        if (!claims.length) return 0;
        return db.writeTransaction(() => {
            let released = 0;
            for (const { demand } of claims)
                released += db
                    .prepare(
                        "UPDATE order_validation_demand SET lease_owner=NULL,lease_until=0,updated_at=? WHERE order_id=? AND chain_id=? AND lease_owner=? AND lease_version=? AND lease_until>?",
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
        const retryMs = Math.min(
            POLICY.retryMaxMs,
            POLICY.retryBaseMs * 2 ** Math.min(failures - 1, 16),
        );
        return db
            .prepare(
                "UPDATE order_validation_demand SET lease_owner=NULL,lease_until=0,failures=failures+1,last_error=?,next_attempt_at=?,updated_at=? WHERE order_id=? AND chain_id=? AND lease_owner=? AND lease_version=? AND lease_until>?",
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
    const orphanedState =
        "(o.block_number>=@fromBlock OR (d.proof_block>=@fromBlock AND (o.block_number IS NULL OR o.fillability_status NOT IN (@filled,@cancelled))))";
    const select = db.prepare<{
        chainId: number;
        fromBlock: number;
        afterId: string;
        limit: number;
        kind: string;
        sourceCancelled: string;
        filled: string;
        cancelled: string;
    }>(
        "SELECT o.id,COALESCE(" +
            orphanedState +
            ",0) AS orphaned FROM orders o LEFT JOIN order_validation_demand d ON d.order_id=o.id AND d.chain_id=o.chain_id " +
            "WHERE o.chain_id=@chainId AND o.id>@afterId AND o.kind=@kind AND o.seaport_data_json IS NOT NULL AND o.source_status<>@sourceCancelled AND " +
            "(" +
            orphanedState +
            " OR (d.pending=1 AND d.minimum_block>=@fromBlock)) " +
            "ORDER BY o.id LIMIT @limit",
    );
    const reset = db.prepare<{ chainId: number; id: string; status: string }>(
        "UPDATE orders SET fillability_status=@status,quantity=COALESCE(original_quantity,quantity),fillable_quantity=NULL,validated_at=0,state_revision=state_revision+1,block_number=NULL,block_hash=NULL,tx_hash=NULL,log_index=NULL,updated_at=CURRENT_TIMESTAMP WHERE chain_id=@chainId AND id=@id",
    );
    const admit = db.prepare<{
        chainId: number;
        id: string;
        fromBlock: number;
        now: number;
    }>(
        "INSERT INTO order_validation_demand(order_id,chain_id,revision,required_at,minimum_block,anchor_independent,updated_at) " +
            "SELECT id,chain_id,state_revision,0,@fromBlock,1,@now FROM orders WHERE chain_id=@chainId AND id=@id " +
            "ON CONFLICT(order_id) DO UPDATE SET generation=generation+1,revision=excluded.revision,required_at=0,minimum_block=excluded.minimum_block,anchor_independent=1,pending=1,proof_revision=NULL,proof_at=NULL,proof_block=NULL,proof_chain_revision=NULL,lease_owner=NULL,lease_until=0,failures=0,last_error=NULL,next_attempt_at=0,updated_at=excluded.updated_at",
    );
    let afterId = "";
    while (true) {
        const rows = select.all({
            chainId,
            fromBlock,
            afterId,
            limit: POLICY.batchOrders,
            kind: FILL_KIND.Seaport,
            sourceCancelled: ORDER_SOURCE_STATUS.Cancelled,
            filled: ORDER_STATUS.Filled,
            cancelled: ORDER_STATUS.Cancelled,
        }) as { id: string; orphaned: number }[];
        if (!rows.length) return;
        for (const row of rows) {
            if (row.orphaned)
                reset.run({
                    chainId,
                    id: row.id,
                    status: ORDER_STATUS.Unvalidated,
                });
            admit.run({ chainId, id: row.id, fromBlock, now });
        }
        afterId = rows[rows.length - 1]!.id;
    }
}
