import assert from "node:assert/strict";
import { decodeEventLog, encodeEventTopics } from "viem";
import { COLLECTION_STANDARD } from "../../../shared/types/browse.ts";
import { TRANSFER_ABI } from "../world/wire.mjs";
import { assertSimulationProperty as property } from "./oracle-assertions.mjs";
import { assertCanonicalFillFacts } from "./fill-oracle.mjs";
import {
    assertOrderValidationRequest,
    validationProofSatisfies,
} from "../../../indexer/src/domain/order-validation-demand.ts";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
} from "../../../shared/market-data/orders.ts";

export const SIMULATION_PROPERTY = Object.freeze({
    CollectionCoverage: "canonical-collection-coverage",
    CanonicalHeaders: "canonical-stored-headers",
    CanonicalOwnership: "canonical-erc721-ownership",
    CanonicalTransfers: "canonical-transfer-facts",
    SellValidation: "current-sell-validation",
    BuyValidation: "current-buy-validation",
});

const TRANSFER_TOPIC = encodeEventTopics({
    abi: TRANSFER_ABI,
    eventName: "Transfer",
})[0];

const ownerOrder = (left, right) =>
    left.token_id.localeCompare(right.token_id) ||
    left.owner.localeCompare(right.owner);
const transferOrder = (left, right) =>
    left.block_number - right.block_number ||
    left.log_index - right.log_index ||
    left.token_id.localeCompare(right.token_id) ||
    left.tx_hash.localeCompare(right.tx_hash);

// Decode independent external wire facts, without invoking the production event
// decoder, ownership reducer, rollback implementation or persistence adapter.
function canonicalTransferFacts(ledger, branch, head) {
    const facts = [];
    for (let number = ledger.anchorBlock + 1; number <= head; number++) {
        const block = ledger.blockAt(branch, number);
        for (const log of block.logs) {
            if (
                log.address.toLowerCase() !==
                    ledger.addresses.nft.toLowerCase() ||
                log.topics[0] !== TRANSFER_TOPIC
            )
                continue;
            const { args } = decodeEventLog({
                abi: TRANSFER_ABI,
                data: log.data,
                topics: log.topics,
                strict: true,
            });
            facts.push({
                chain_id: ledger.chainId,
                contract_address: log.address.toLowerCase(),
                from_address: args.from.toLowerCase(),
                to_address: args.to.toLowerCase(),
                token_id: args.tokenId.toString(),
                amount: "1",
                block_number: block.number,
                block_hash: block.hash,
                block_timestamp: block.timestamp,
                tx_hash: log.transactionHash,
                log_index: Number(BigInt(log.logIndex)),
                kind: COLLECTION_STANDARD.Erc721,
            });
        }
    }
    return facts.sort(transferOrder);
}

/** Expected coverage and headers come from the independent external chain ledger. */
export function assertCanonicalAcquisition({ snapshot, ledger, branch, head }) {
    const heights = Array.from(
        { length: head - ledger.anchorBlock },
        (_, index) => ledger.anchorBlock + index + 1,
    );
    property(SIMULATION_PROPERTY.CollectionCoverage, () => {
        assert.deepEqual(
            snapshot.coverage
                .map((row) => row.block_number)
                .filter((number) => number > ledger.anchorBlock),
            heights,
            "The tested collection must cover every post-anchor block through its winning head exactly once",
        );
    });
    property(SIMULATION_PROPERTY.CanonicalHeaders, () => {
        const actual = snapshot.headers.filter(
            (row) => row.block_number > ledger.anchorBlock,
        );
        assert.deepEqual(
            actual.map((row) => row.block_number),
            heights,
            "Stored post-anchor headers must cover the declared final head",
        );
        for (const row of actual) {
            const expected = ledger.blockAt(branch, row.block_number);
            assert.equal(
                row.block_hash,
                expected.hash,
                `Canonical hash at block ${row.block_number}`,
            );
            assert.equal(
                row.parent_hash,
                expected.parentHash,
                `Canonical parent at block ${row.block_number}`,
            );
        }
    });
    property(SIMULATION_PROPERTY.CanonicalOwnership, () => {
        const expected = [...ledger.stateAt(branch, head).owners].map(
            ([tokenId, owner]) => ({
                token_id: tokenId,
                owner: owner.toLowerCase(),
                amount: "1",
            }),
        );
        assert.deepEqual(
            snapshot.owners
                .map(({ token_id, owner, amount }) => ({
                    token_id,
                    owner,
                    amount,
                }))
                .sort(ownerOrder),
            expected.sort(ownerOrder),
            "Every simulated ERC721 must have exactly its canonical owner and one unit, without collateral or orphan balances",
        );
    });
    property(SIMULATION_PROPERTY.CanonicalTransfers, () => {
        const expected = canonicalTransferFacts(ledger, branch, head);
        // Bootstrap ownership snapshots do not guarantee stored pre-anchor
        // transfer history. Require exact facts for the range acquired here.
        assert.deepEqual(
            snapshot.transfers
                .filter((row) => row.block_number > ledger.anchorBlock)
                .map((row) =>
                    Object.fromEntries(
                        [
                            "chain_id",
                            "contract_address",
                            "from_address",
                            "to_address",
                            "token_id",
                            "amount",
                            "block_number",
                            "block_hash",
                            "block_timestamp",
                            "tx_hash",
                            "log_index",
                            "kind",
                        ].map((key) => [key, row[key]]),
                    ),
                )
                .sort(transferOrder),
            expected,
            "Stored post-anchor transfer facts must equal the canonical external logs exactly, with no missing, duplicate or orphan facts",
        );
    });
    assertCanonicalFillFacts({ snapshot, ledger, branch, head });
}

/** Assert the fixture's executable convergence endpoint, not optimistic
 * intermediate visibility or separate protocol-terminal/refusal endpoints.
 * Non-active source evidence remains independent of protocol fillability.
 * Stored coverage may predate a rollback without having been reused. A
 * fixture-witnessed new request is checked separately by its freshness owner.
 */
export function assertMarketConvergence({
    snapshot,
    ledger,
    expectedSourceStatuses = {},
}) {
    for (const [name, order] of Object.entries(ledger.orders)) {
        property(
            name === "bid"
                ? SIMULATION_PROPERTY.BuyValidation
                : SIMULATION_PROPERTY.SellValidation,
            () => {
                const actual = snapshot.orders.find(
                    (row) => row.id === order.orderHash,
                );
                assert.ok(
                    actual,
                    `Current ${name} observation must be admitted`,
                );
                const expectedSource =
                    expectedSourceStatuses[order.orderHash] ??
                    ORDER_SOURCE_STATUS.Active;
                assert.equal(
                    actual.source_status,
                    expectedSource,
                    `Current ${name} must retain the declared source evidence`,
                );
                // Source cancellation makes an order non-actionable without
                // changing its independent onchain fillability or requiring a
                // new RPC proof for that cancelled source observation.
                if (expectedSource !== ORDER_SOURCE_STATUS.Active) return;
                assert.equal(
                    actual.fillability_status,
                    ORDER_STATUS.Fillable,
                    `Current ${name} must be executable on the independent world branch`,
                );
                assert.ok(
                    actual.validated_at > 0,
                    `Current ${name} needs a full validation checkpoint`,
                );
                const proof = snapshot.validationProofs.find(
                    (row) => row.order_id === order.orderHash,
                );
                assert.ok(
                    proof,
                    `Current ${name} must retain validation evidence`,
                );
                assert.equal(
                    proof.pending,
                    0,
                    `Current ${name} demand must be settled`,
                );
                // These are deliberately read-only SQLite boundary fields.
                // Missing requirements are unknown evidence, not zero/null
                // defaults. The owning contract combines source identity,
                // chain identity and the retained observation/trigger floors.
                const request = {
                    chainId: ledger.chainId,
                    orderId: order.orderHash,
                    requiredAt: proof.required_at,
                    minimumBlock: proof.minimum_block,
                };
                assertOrderValidationRequest(request);
                for (const [field, value] of [
                    ["canonical order revision", actual.state_revision],
                    ["canonical chain revision", snapshot.revision],
                    ["proof revision", proof.proof_revision],
                    ["proof chain revision", proof.proof_chain_revision],
                    ["proof observation time", proof.proof_at],
                    ["proof block", proof.proof_block],
                ])
                    assert.ok(
                        Number.isSafeInteger(value) && value >= 0,
                        `Current ${name} requires an explicit valid ${field}`,
                    );
                assert.equal(
                    proof.proof_revision,
                    actual.state_revision,
                    `Current ${name} proof must cover its canonical order revision`,
                );
                assert.ok(
                    proof.proof_chain_revision <= snapshot.revision,
                    `Current ${name} cannot retain proof from a future chain revision`,
                );
                assert.equal(
                    validationProofSatisfies(
                        {
                            observedAt: proof.proof_at,
                            blockNumber: proof.proof_block,
                        },
                        request,
                    ),
                    true,
                    `Current ${name} proof must cover its retained source-time/event-height requirements`,
                );
            },
        );
    }
}
