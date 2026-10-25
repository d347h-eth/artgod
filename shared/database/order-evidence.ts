import { COLLECTION_STATUS } from "../types/browse.js";
import { FILL_KIND } from "../market-data/fills.js";
import { ORDER_SIDE } from "../market-data/orders.js";
import {
    GLOBAL_MAKER_TRIGGER_REASON,
    MAKER_REVALIDATION_STATUS,
    MAKER_TRIGGER_SCOPE,
} from "../market-data/order-validation.js";
import { MARKET_DATA_STORAGE_POLICY } from "../market-data/storage-policy.js";

/** Evidence usability is independent of displayed protocol/source status. SQL
 * expressions are adapter-owned, never request input. nowMs adds one binding
 * when passed as `?`; proof timestamps are local epoch milliseconds. Usable
 * quotes require positive known remaining units and funding capacity. Pending
 * maker expansion blocks only proofs not yet covering that scope requirement,
 * so a completed order can become usable before its whole maker pass finishes. */
export function usableOrderEvidenceSql(input: {
    orderAlias: string;
    nowMs: string;
}): string {
    const o = input.orderAlias;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o))
        throw new Error("Order evidence requires an SQL table alias");
    const freshMs = MARKET_DATA_STORAGE_POLICY.orderRevalidationSeconds * 1_000;
    return `(
        ${o}.validation_ready=1
        AND ${o}.quantity NOT GLOB '*[^0-9]*' AND LTRIM(${o}.quantity,'0')<>''
        AND ${o}.fillable_quantity NOT GLOB '*[^0-9]*' AND LTRIM(${o}.fillable_quantity,'0')<>''
        AND ${o}.proof_order_revision=${o}.state_revision
        AND ${o}.proof_at>(${input.nowMs})-${freshMs}
        AND EXISTS (
            SELECT 1 FROM chain_sync_progress evidence_chain
            LEFT JOIN chain_sync_revisions evidence_revision
              ON evidence_revision.chain_id=evidence_chain.chain_id
            JOIN collection_sync_progress evidence_scope
              ON evidence_scope.chain_id=evidence_chain.chain_id
             AND evidence_scope.collection_id=${o}.collection_id
             AND evidence_scope.revision=evidence_chain.revision
            JOIN collections evidence_collection
              ON evidence_collection.chain_id=evidence_scope.chain_id
             AND evidence_collection.collection_id=evidence_scope.collection_id
             AND evidence_collection.bootstrap_anchor_block=evidence_scope.anchor_block
             AND evidence_collection.status IN ('${COLLECTION_STATUS.Live}','${COLLECTION_STATUS.Bootstrapping}')
            JOIN blocks evidence_block
              ON evidence_block.chain_id=evidence_chain.chain_id
             AND evidence_block.block_number=${o}.proof_block_number
             AND evidence_block.block_hash=${o}.proof_block_hash
            WHERE evidence_chain.chain_id=${o}.chain_id
              AND evidence_chain.revision=${o}.proof_chain_revision
              AND evidence_chain.revision=COALESCE(evidence_revision.revision,0)
              AND evidence_chain.disputed_from IS NULL
              AND ${o}.proof_block_number BETWEEN MAX(evidence_chain.anchor_block,evidence_scope.anchor_block)
                  AND MIN(evidence_chain.applied_block,evidence_scope.applied_block)
              AND NOT EXISTS (
                  SELECT 1 FROM chain_reorg_recoveries evidence_recovery
                  WHERE evidence_recovery.chain_id=${o}.chain_id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM maker_order_revalidation_runs evidence_maker
                  WHERE evidence_maker.chain_id=${o}.chain_id
                    AND evidence_maker.scope_maker=${o}.maker
                    AND evidence_maker.status='${MAKER_REVALIDATION_STATUS.Pending}'
                    AND ${o}.kind='${FILL_KIND.Seaport}'
                    AND (
                        (evidence_maker.required_block_number IS NULL
                         AND ${o}.proof_admission_sequence<evidence_maker.requested_admission_sequence)
                        OR (evidence_maker.required_block_number IS NOT NULL
                            AND evidence_maker.required_chain_revision=evidence_chain.revision
                            AND evidence_maker.required_block_number>evidence_scope.anchor_block
                            AND (${o}.proof_block_number<evidence_maker.required_block_number OR (
                                ${o}.proof_block_number=evidence_maker.required_block_number
                                AND ${o}.proof_block_hash IS NOT evidence_maker.required_block_hash
                            ))
                        )
                    )
                    AND (
                        (evidence_maker.scope_kind='${MAKER_TRIGGER_SCOPE.Global}' AND (
                            evidence_maker.scope_reason='${GLOBAL_MAKER_TRIGGER_REASON.OrderCounter}' OR (
                                evidence_maker.scope_reason IN ('${GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance}','${GLOBAL_MAKER_TRIGGER_REASON.ApprovalChange}')
                                AND ${o}.side='${ORDER_SIDE.Buy}'
                                AND ${o}.currency=evidence_maker.scope_currency
                            )
                        )) OR (
                            evidence_maker.scope_collection_id=${o}.collection_id
                            AND ${o}.side='${ORDER_SIDE.Sell}' AND (
                                evidence_maker.scope_kind='${MAKER_TRIGGER_SCOPE.Collection}' OR (
                                    evidence_maker.scope_kind='${MAKER_TRIGGER_SCOPE.Token}'
                                    AND evidence_maker.scope_token_id=${o}.token_id
                                )
                            )
                        )
                    )
              )
        )
        AND NOT EXISTS (
            SELECT 1 FROM order_validation_demand evidence_demand
            WHERE evidence_demand.chain_id=${o}.chain_id
              AND evidence_demand.order_id=${o}.id AND evidence_demand.pending=1
        )
    )`;
}
