import { db } from "@artgod/shared/database";
import { tryParseHash } from "@artgod/shared/offchain/normalizer-utils";
import type { ChainSyncCheckpoint } from "../../domain/chain-sync.js";
import {
    ORDER_VALIDATION_DEMAND_POLICY as POLICY,
    assertOrderValidationRequest,
    observedOrderValidationRequest,
    sourceExecutionValidationRequest,
    orderValidationRetryDelay,
} from "../../domain/order-validation-demand.js";
import type { OrderValidationDemandPort } from "../../ports/order-validation-demand.js";
import type {
    ClaimedOrderExecution,
    OrderExecutionRequirement,
    OrderExecutionRequirementsPort,
} from "../../ports/order-execution-requirements.js";
import {
    assertChainSyncCheckpoint,
    captureChainSyncCheckpoint,
} from "../storage/sqlite-chain-revisions.js";

const SELECT =
    "SELECT chain_id AS chainId,order_id AS orderId,transaction_hash AS transactionHash,required_at AS requiredAt,lease_owner AS leaseOwner,lease_version AS leaseVersion,failures FROM order_execution_requirements ";
const OWNED =
    "chain_id=? AND order_id=? AND transaction_hash=? AND lease_owner=? AND lease_version=? AND lease_until>?";

/** Source retries coalesce by transaction; a later sale cannot overwrite an orphan. */
export class SqliteOrderExecutionRequirements implements OrderExecutionRequirementsPort {
    constructor(private readonly validation: OrderValidationDemandPort) {}
    captureSyncCheckpoint = captureChainSyncCheckpoint;

    async request(input: OrderExecutionRequirement): Promise<void> {
        const request = observedOrderValidationRequest(
            input.chainId,
            input.orderId,
            input.requiredAt,
        );
        assertOrderValidationRequest(request);
        const hash = tryParseHash(input.transactionHash);
        if (!hash) throw new Error("Invalid execution transaction hash");
        db.writeTransaction(() => {
            if (!this.validation.needsValidation(request)) return;
            db.prepare(
                "INSERT INTO order_execution_requirements(chain_id,order_id,transaction_hash,required_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING",
            ).run(
                input.chainId,
                input.orderId,
                hash,
                input.requiredAt,
                Date.now(),
            );
        })();
    }

    claim(
        chainId: number,
        owner: string,
        now: number,
    ): ClaimedOrderExecution | null {
        return db.writeTransaction(() => {
            const due = db
                .prepare(
                    SELECT +
                        "WHERE chain_id=? AND next_attempt_at<=? AND lease_until<=? ORDER BY next_attempt_at,updated_at,order_id,transaction_hash LIMIT ?",
                )
                .all(
                    chainId,
                    now,
                    now,
                    POLICY.batchOrders,
                ) as ClaimedOrderExecution[];
            for (const row of due) {
                if (
                    !this.validation.needsValidation(
                        observedOrderValidationRequest(chainId, row.orderId, 0),
                    )
                ) {
                    db.prepare(
                        "DELETE FROM order_execution_requirements WHERE chain_id=? AND order_id=? AND transaction_hash=?",
                    ).run(chainId, row.orderId, row.transactionHash);
                    continue;
                }
                db.prepare(
                    "UPDATE order_execution_requirements SET lease_owner=?,lease_version=lease_version+1,lease_until=? WHERE chain_id=? AND order_id=? AND transaction_hash=?",
                ).run(
                    owner,
                    now + POLICY.leaseMs,
                    chainId,
                    row.orderId,
                    row.transactionHash,
                );
                return {
                    ...row,
                    leaseOwner: owner,
                    leaseVersion: row.leaseVersion + 1,
                };
            }
            return null;
        })();
    }

    renew(claim: ClaimedOrderExecution, now: number): void {
        db.prepare(
            "UPDATE order_execution_requirements SET lease_until=? WHERE " +
                OWNED,
        ).run(now + POLICY.leaseMs, ...identity(claim, now));
    }

    complete(
        claim: ClaimedOrderExecution,
        blockNumber: number,
        checkpoint: ChainSyncCheckpoint,
        now: number,
    ): void {
        db.writeTransaction(() => {
            if (
                !db
                    .prepare(SELECT + "WHERE " + OWNED)
                    .get(...identity(claim, now))
            )
                return;
            if (checkpoint.chainId !== claim.chainId)
                throw new Error("Execution coverage chain mismatch");
            assertChainSyncCheckpoint(checkpoint);
            // Recheck current eligibility in admit. Cancellation, expiry and deletion
            // can settle the obligation without admitting new validation work.
            this.validation.admit(
                sourceExecutionValidationRequest(
                    claim.chainId,
                    claim.orderId,
                    blockNumber,
                ),
                now,
                checkpoint,
            );
            db.prepare(
                "DELETE FROM order_execution_requirements WHERE " + OWNED,
            ).run(...identity(claim, now));
        })();
    }

    defer(claim: ClaimedOrderExecution, error: unknown, now: number): void {
        db.prepare(
            "UPDATE order_execution_requirements SET lease_owner=NULL,lease_until=0,failures=failures+1,last_error=?,next_attempt_at=?,updated_at=? WHERE " +
                OWNED,
        ).run(
            String(error).slice(0, 1000),
            now + orderValidationRetryDelay(claim.failures + 1),
            now,
            ...identity(claim, now),
        );
    }

    release(claim: ClaimedOrderExecution, now: number): void {
        db.prepare(
            "UPDATE order_execution_requirements SET lease_owner=NULL,lease_until=0,next_attempt_at=?,updated_at=? WHERE " +
                OWNED,
        ).run(now + POLICY.pollMs, now, ...identity(claim, now));
    }
}

function identity(claim: ClaimedOrderExecution, now: number) {
    return [
        claim.chainId,
        claim.orderId,
        claim.transactionHash,
        claim.leaseOwner,
        claim.leaseVersion,
        now,
    ] as const;
}
