import assert from "node:assert/strict";
import { decodeEventLog, encodeEventTopics } from "viem";
import {
    FILL_KIND,
    FILL_ITEM_SIDE,
    FILL_ITEM_TYPE,
} from "../../../shared/market-data/fills.ts";
import { ORDER_SIDE } from "../../../shared/market-data/orders.ts";
import {
    ACTIVITY_KIND,
    ACTIVITY_SCOPE_KIND,
    ACTIVITY_SOURCE_KIND,
} from "../../../shared/types/activity-feed.ts";
import { FULFILLED_ABI } from "../world/wire.mjs";
import { assertSimulationProperty as property } from "./oracle-assertions.mjs";

export const FILL_STORAGE_PROPERTY = Object.freeze({
    Fixture: "supported-independent-fill-fixture",
    Executions: "canonical-fill-execution-facts",
    Items: "canonical-fill-item-facts",
    Attributions: "canonical-fill-collection-attributions",
});
export const FILL_HTTP_PROPERTY = "canonical-fulfillment-http-sale";

const FULFILLED_TOPIC = encodeEventTopics({
    abi: FULFILLED_ABI,
    eventName: "OrderFulfilled",
})[0];

/**
 * A reviewed truth table for this fixture's one ERC721-for-WETH take-ask.
 * This deliberately does not call the production fill decoder, payment
 * classifier, quantity allocator, transfer matcher or persistence writer.
 * New execution shapes need their own independently reviewed oracle.
 */
function expectedFillFacts(ledger, branch, head, collectionId) {
    const executions = [],
        items = [],
        attributions = [];
    property(FILL_STORAGE_PROPERTY.Fixture, () => {
        assert.ok(
            Number.isSafeInteger(collectionId) && collectionId > 0,
            "Fill assertions require the real declared collection identity",
        );
        for (let number = 0; number <= head; number++) {
            const block = ledger.blockAt(branch, number);
            for (const log of block.logs) {
                if (
                    log.address.toLowerCase() !==
                        ledger.addresses.seaport.toLowerCase() ||
                    log.topics[0] !== FULFILLED_TOPIC
                )
                    continue;
                assert.ok(
                    number > ledger.anchorBlock,
                    "This fill fixture does not model pre-anchor execution completeness",
                );
                const { args } = decodeEventLog({
                    abi: FULFILLED_ABI,
                    data: log.data,
                    topics: log.topics,
                    strict: true,
                });
                const transaction = ledger.transactions.get(
                    log.transactionHash,
                );
                const nft = args.offer[0],
                    payment = args.consideration[0];
                assert.equal(
                    args.offer.length,
                    1,
                    "Fill oracle supports exactly one offered NFT",
                );
                assert.equal(
                    args.consideration.length,
                    1,
                    "Fill oracle supports exactly one monetary consideration",
                );
                assert.equal(args.orderHash, ledger.orders.listing.orderHash);
                assert.equal(
                    args.offerer.toLowerCase(),
                    ledger.addresses.seller,
                );
                assert.equal(
                    args.recipient.toLowerCase(),
                    ledger.addresses.buyer,
                );
                assert.equal(
                    transaction?.from.toLowerCase(),
                    ledger.addresses.buyer,
                );
                assert.equal(nft.itemType, FILL_ITEM_TYPE.Erc721);
                assert.equal(nft.token.toLowerCase(), ledger.addresses.nft);
                assert.equal(
                    nft.identifier.toString(),
                    ledger.orders.listing.tokenId,
                );
                assert.equal(nft.amount, 1n);
                assert.equal(payment.itemType, FILL_ITEM_TYPE.Erc20);
                assert.equal(
                    payment.token.toLowerCase(),
                    ledger.addresses.weth,
                );
                assert.equal(payment.identifier, 0n);
                assert.equal(
                    payment.amount,
                    ledger.orders.listing.components.consideration[0]
                        .startAmount,
                );
                assert.equal(
                    payment.recipient.toLowerCase(),
                    ledger.addresses.seller,
                );
                const logIndex = Number(BigInt(log.logIndex));
                // Assert this documented storage serialization independently: a
                // shared identity-writer regression must not rewrite the oracle.
                const executionId = `${ledger.chainId}:${FILL_KIND.Seaport}:${log.transactionHash.toLowerCase()}:${logIndex}`;
                const provenance = {
                    chain_id: ledger.chainId,
                    kind: FILL_KIND.Seaport,
                    tx_hash: log.transactionHash.toLowerCase(),
                    log_index: logIndex,
                    block_number: block.number,
                    block_hash: block.hash,
                    block_timestamp: block.timestamp,
                };
                executions.push({
                    id: executionId,
                    ...provenance,
                    protocol_address: log.address.toLowerCase(),
                    price_exclusion: null,
                    total_price: payment.amount.toString(),
                    currency: payment.token.toLowerCase(),
                    nft_quantity: "1",
                });
                items.push(
                    {
                        execution_id: executionId,
                        item_index: 0,
                        side: FILL_ITEM_SIDE.Offer,
                        item_type: FILL_ITEM_TYPE.Erc721,
                        contract_address: nft.token.toLowerCase(),
                        identifier: nft.identifier.toString(),
                        amount: "1",
                        recipient: args.recipient.toLowerCase(),
                        unit_offset: "0",
                    },
                    {
                        execution_id: executionId,
                        item_index: 1,
                        side: FILL_ITEM_SIDE.Consideration,
                        item_type: FILL_ITEM_TYPE.Erc20,
                        contract_address: payment.token.toLowerCase(),
                        identifier: payment.identifier.toString(),
                        amount: payment.amount.toString(),
                        recipient: payment.recipient.toLowerCase(),
                        unit_offset: "1",
                    },
                );
                attributions.push({
                    ...provenance,
                    collection_id: collectionId,
                    execution_id: executionId,
                    item_index: 0,
                    order_id: args.orderHash,
                    order_side: ORDER_SIDE.Sell,
                    maker: args.offerer.toLowerCase(),
                    taker: transaction.from.toLowerCase(),
                    contract_address: nft.token.toLowerCase(),
                    token_id: nft.identifier.toString(),
                    amount: "1",
                });
            }
        }
    });
    return { executions, items, attributions };
}

const factOrder = (left, right) =>
    (left.id ?? left.execution_id).localeCompare(
        right.id ?? right.execution_id,
    ) ||
    (left.item_index ?? 0) - (right.item_index ?? 0) ||
    (left.collection_id ?? 0) - (right.collection_id ?? 0);

/** Compare raw rows, without parent joins that could hide dangling children. */
export function assertCanonicalFillFacts({ snapshot, ledger, branch, head }) {
    const expected = expectedFillFacts(
        ledger,
        branch,
        head,
        snapshot.collectionId,
    );
    for (const [name, actual, facts] of [
        [
            FILL_STORAGE_PROPERTY.Executions,
            snapshot.fillExecutions,
            expected.executions,
        ],
        [FILL_STORAGE_PROPERTY.Items, snapshot.fillItems, expected.items],
        [
            FILL_STORAGE_PROPERTY.Attributions,
            snapshot.fillAttributions,
            expected.attributions,
        ],
    ])
        property(name, () => {
            assert.ok(
                Array.isArray(actual),
                `Read-only observation must include ${name}`,
            );
            assert.deepEqual(
                [...actual].sort(factOrder),
                facts.sort(factOrder),
                "Every stored fill header, protocol item and collection attribution must match the canonical external fulfillment, without missing, duplicate or orphan facts",
            );
        });
}

/** Exact sale representation for this fixture's single fulfilled token.
 * Non-sale feed entries and pagination are outside this assertion's scope.
 */
export function assertCanonicalSaleActivity({
    response,
    ledger,
    branch,
    head,
    collectionId,
    tokenId,
}) {
    const facts = expectedFillFacts(ledger, branch, head, collectionId);
    let evidence;
    property(FILL_HTTP_PROPERTY, () => {
        const fills = facts.attributions.filter(
            (fill) => fill.token_id === tokenId,
        );
        assert.equal(
            fills.length,
            1,
            "The HTTP sale assertion requires one actual canonical fulfillment for the requested token",
        );
        const fill = fills[0];
        const execution = facts.executions.find(
            (row) => row.id === fill.execution_id,
        );
        const nft = facts.items.find(
            (row) =>
                row.execution_id === fill.execution_id &&
                row.item_index === fill.item_index,
        );
        const expected = {
            kind: ACTIVITY_KIND.Sale,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            sourceKind: ACTIVITY_SOURCE_KIND.Onchain,
            sourceName: fill.kind,
            contract: fill.contract_address,
            tokenId: fill.token_id,
            orderId: fill.order_id,
            blockNumber: fill.block_number,
            occurredAt: fill.block_timestamp,
            txHash: fill.tx_hash,
            logIndex: fill.log_index,
            maker: fill.maker,
            taker: fill.taker,
            from: fill.maker,
            to: nft.recipient,
            side: fill.order_side,
            amount: fill.amount,
            price: execution.total_price,
            currency: execution.currency,
        };
        assert.equal(response.token.tokenId, tokenId);
        assert.ok(
            Array.isArray(response.activities.items),
            "HTTP sale observation must include explicit activity rows",
        );
        const sales = response.activities.items.filter(
            (row) => row.kind === ACTIVITY_KIND.Sale,
        );
        assert.equal(
            sales.length,
            1,
            "The token feed must contain exactly the canonical fixture sale, without duplicates or unrelated sales",
        );
        const actual = Object.fromEntries(
            Object.keys(expected).map((key) => [key, sales[0][key]]),
        );
        assert.deepEqual(
            actual,
            expected,
            "HTTP sale identity and NFT-leg economics must match the independent external fulfillment",
        );
        assert.equal(sales[0].payload?.executionId, execution.id);
        evidence = { tokenId, sale: expected, executionId: execution.id };
    });
    return evidence;
}
