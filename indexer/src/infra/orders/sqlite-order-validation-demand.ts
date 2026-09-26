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
    type OrderValidationProof,
    type OrderValidationRequest,
    type OrderValidationClaimBatch,
    type OrderValidationCompletion,
    type OrderValidationCompletionCounts,
} from "../../domain/order-validation-demand.js";
import type {
    OrderValidationDemandPort,
    OrderValidationProjectionPort,
} from "../../ports/order-validation-demand.js";

type DemandRow = Omit<
    OrderValidationDemand,
    "pending" | "anchorIndependent"
> & { pending: number; anchorIndependent: number };
const SELECT =
    "SELECT chain_id AS chainId,order_id AS orderId,generation,revision,required_at AS requiredAt,minimum_block AS minimumBlock,anchor_independent AS anchorIndependent,pending,proof_revision AS proofRevision,proof_at AS proofAt,proof_block AS proofBlock,lease_owner AS leaseOwner,lease_version AS leaseVersion,lease_until AS leaseUntil,failures FROM order_validation_demand ";

/** The pending row itself is the durable wakeup; polling cannot lose a sent broker message. */
export class SqliteOrderValidationDemand implements OrderValidationDemandPort {
    constructor(private readonly orders: OrderValidationProjectionPort) {}

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

    admit(request: OrderValidationRequest, now: number) {
        assertOrderValidationRequest(request);
        return db.writeTransaction(() => {
            const candidate = this.orders.validationCandidate(request);
            if (!candidate) return OUTCOME.Unneeded;
            const current = this.get(request.chainId, request.orderId);
            if (
                current &&
                validationProofCovers(current, candidate.revision, request)
            )
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
                    request.minimumBlock === null ? 1 : 0,
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
        proof: OrderValidationProof,
        now: number,
    ): OrderValidationCompletionCounts {
        // One bounded commit follows snapshot verification; RPC never holds this transaction.
        return db.writeTransaction(() => {
            const counts: OrderValidationCompletionCounts = {
                applied: 0,
                covered: 0,
                resolvedUnneeded: 0,
                followup: 0,
                lostClaims: 0,
            };
            for (const { claim, result } of completions) {
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
                    "UPDATE order_validation_demand SET pending=?,revision=COALESCE(?,revision),proof_revision=?,proof_at=?,proof_block=?,lease_owner=NULL,lease_until=0,failures=0,last_error=NULL,next_attempt_at=0,updated_at=? WHERE order_id=?",
                ).run(
                    pending ? 1 : 0,
                    revision,
                    revision,
                    revision === null ? null : proof.observedAt,
                    revision === null ? null : proof.blockNumber,
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
