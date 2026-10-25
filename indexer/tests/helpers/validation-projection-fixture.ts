import { db } from "@artgod/shared/database";
import { needsCurrentOrderValidation } from "../../src/domain/order-validation-demand.js";
import { validatedQuantityUpdate } from "../../src/domain/order-quantity.js";
import type { OrderValidationProjectionPort } from "../../src/ports/order-validation-demand.js";
import { heavyMakerOrder } from "../fixtures/heavy-maker.js";

/** The SQL demand/progress adapters are real. This narrow projection double isolates
 * lease/coverage behavior from source normalization and protocol result policy. */
export function validationProjectionFixture(): OrderValidationProjectionPort {
    const candidate: OrderValidationProjectionPort["validationCandidate"] = (
        request,
    ) => {
        const row = db
            .prepare(
                "SELECT o.*,c.bootstrap_anchor_block FROM orders o JOIN collections c ON c.collection_id=o.collection_id WHERE o.id=? AND o.chain_id=?",
            )
            .get(request.orderId, request.chainId) as any;
        if (!row) return null;
        const order = {
            ...heavyMakerOrder(Number(row.fixture_index ?? 0)),
            id: row.id,
            chainId: row.chain_id,
            collectionId: row.collection_id,
            sourceStatus: row.source_status,
            fillabilityStatus: row.fillability_status,
            validUntil: row.valid_until,
        };
        if (
            !needsCurrentOrderValidation(
                order,
                Math.floor(Date.now() / 1000),
            ) ||
            (!request.anchorIndependent &&
                request.minimumBlock !== null &&
                request.minimumBlock <= row.bootstrap_anchor_block)
        )
            return null;
        return { order, revision: row.state_revision };
    };
    return {
        refreshValidationProjection() {},
        validationCandidate: candidate,
        applyDemandValidation(claim, result, evidence) {
            const current = candidate(claim.demand);
            if (!current || current.revision !== claim.candidate.revision)
                return null;
            const revision =
                current.revision +
                (current.order.fillabilityStatus === result.status ? 0 : 1);
            const quantities = validatedQuantityUpdate(result);
            db.prepare(
                "UPDATE orders SET fillability_status=?,state_revision=?,validated_at=?,block_number=?,block_hash=?,proof_block_number=?,proof_block_hash=?,proof_chain_revision=?,proof_admission_sequence=?,proof_order_revision=?,proof_at=?,quantity=?,original_quantity=COALESCE(original_quantity,?),fillable_quantity=? WHERE id=?",
            ).run(
                result.status,
                revision,
                Math.floor(evidence.observedAt / 1000),
                evidence.block.number,
                evidence.block.hash,
                evidence.block.number,
                evidence.block.hash,
                evidence.checkpoint.revision,
                evidence.admissionSequence,
                revision,
                evidence.observedAt,
                quantities.remaining,
                quantities.original,
                quantities.fillable,
                claim.demand.orderId,
            );
            return revision;
        },
    };
}
