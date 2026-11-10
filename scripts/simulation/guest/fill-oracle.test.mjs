import assert from "node:assert/strict";
import test from "node:test";
import { createBaselineLedger } from "../world/ledger.mjs";
import {
    assertCanonicalFillFacts,
    assertCanonicalSaleActivity,
    FILL_HTTP_PROPERTY,
    FILL_STORAGE_PROPERTY,
} from "./fill-oracle.mjs";
import { baselineFillFacts } from "./fixtures/fill-facts.mjs";
import {
    ACTIVITY_KIND,
    ACTIVITY_SCOPE_KIND,
    ACTIVITY_SOURCE_KIND,
} from "../../../shared/types/activity-feed.ts";

const ledger = createBaselineLedger({ epochSeconds: 1_000_000 });
const check = (snapshot, branch = "A", head = 107) =>
    assertCanonicalFillFacts({ snapshot, ledger, branch, head });

function saleResponse() {
    const facts = baselineFillFacts(ledger);
    const fill = facts.fillAttributions[0],
        execution = facts.fillExecutions[0];
    return {
        token: { tokenId: "1" },
        activities: {
            items: [
                {
                    kind: ACTIVITY_KIND.Sale,
                    scopeKind: ACTIVITY_SCOPE_KIND.Token,
                    sourceKind: ACTIVITY_SOURCE_KIND.Onchain,
                    sourceName: fill.kind,
                    contract: fill.contract_address,
                    tokenId: "1",
                    orderId: fill.order_id,
                    blockNumber: fill.block_number,
                    occurredAt: fill.block_timestamp,
                    txHash: fill.tx_hash,
                    logIndex: fill.log_index,
                    maker: ledger.addresses.seller,
                    taker: ledger.addresses.buyer,
                    from: ledger.addresses.seller,
                    to: ledger.addresses.buyer,
                    side: fill.order_side,
                    amount: "1",
                    price: "1000000000000000000",
                    currency: ledger.addresses.weth,
                    payload: { executionId: execution.id },
                },
            ],
        },
    };
}
const checkSale = (response, branch = "A") =>
    assertCanonicalSaleActivity({
        response,
        ledger,
        branch,
        head: 104,
        collectionId: 42,
        tokenId: "1",
    });

test("the A104 HTTP sale exposes its exact canonical fulfillment identity and NFT-leg economics", () => {
    const response = saleResponse();
    response.activities.items.push({ kind: ACTIVITY_KIND.ListingCreated });
    const evidence = checkSale(response);
    assert.equal(
        evidence.sale.txHash,
        ledger.blockAt("A", 104).transactions[0],
    );
    assert.equal(evidence.sale.price, "1000000000000000000");
    assert.equal(evidence.sale.amount, "1");
});

test("correct SQL fill facts cannot bless a wrong HTTP sale identity, participants or economics", () => {
    for (const change of [
        { tokenId: "2" },
        { orderId: ledger.orders.bid.orderHash },
        { blockNumber: 103 },
        { txHash: `0x${"f".repeat(64)}` },
        { logIndex: 0 },
        { contract: ledger.addresses.seaport },
        { occurredAt: ledger.blockAt("A", 104).timestamp - 1 },
        { maker: ledger.addresses.buyer },
        { taker: ledger.addresses.seller },
        { from: ledger.addresses.buyer },
        { to: ledger.addresses.seller },
        { amount: "2" },
        { price: "999" },
        { currency: ledger.addresses.nft },
        { sourceKind: ACTIVITY_SOURCE_KIND.Offchain },
        { payload: { executionId: "unrelated-execution" } },
    ]) {
        const snapshot = baselineFillFacts(ledger);
        check(snapshot, "A", 104);
        const response = saleResponse();
        Object.assign(response.activities.items[0], change);
        assert.throws(() => checkSale(response), {
            property: FILL_HTTP_PROPERTY,
        });
        check(snapshot, "A", 104);
    }
});

test("missing, duplicate or unrelated HTTP sales cannot satisfy the canonical A104 witness", () => {
    for (const mutate of [
        (response) => {
            response.activities.items = [];
        },
        (response) => {
            response.activities.items.push({ ...response.activities.items[0] });
        },
        (response) => {
            response.activities.items = [
                { kind: ACTIVITY_KIND.Sale, tokenId: "2" },
            ];
        },
        (response) => {
            response.token.tokenId = "2";
        },
    ]) {
        const response = saleResponse();
        mutate(response);
        assert.throws(() => checkSale(response), {
            property: FILL_HTTP_PROPERTY,
        });
    }
});

test("an HTTP sale cannot invent a fulfillment on the recovered B branch", () => {
    check(baselineFillFacts(ledger, { branch: "B" }), "B", 104);
    assert.throws(() => checkSale(saleResponse(), "B"), {
        property: FILL_HTTP_PROPERTY,
    });
});

test("the canonical A sale retains its exact execution, raw items and collection attribution", () => {
    const snapshot = baselineFillFacts(ledger);
    check(snapshot);
    snapshot.fillItems.reverse();
    check(snapshot);
});

test("a clean B recovery has no executions, protocol children or collection attributions", () => {
    check(baselineFillFacts(ledger, { branch: "B", head: 107 }), "B");
});

test("retaining an orphan execution after B recovery cannot pass", () => {
    const snapshot = baselineFillFacts(ledger, { branch: "B" });
    snapshot.fillExecutions = baselineFillFacts(ledger).fillExecutions;
    assert.throws(() => check(snapshot, "B"), {
        property: FILL_STORAGE_PROPERTY.Executions,
    });
});

test("orphan protocol items cannot hide behind a missing parent execution", () => {
    const snapshot = baselineFillFacts(ledger, { branch: "B" });
    snapshot.fillItems = baselineFillFacts(ledger).fillItems;
    assert.throws(() => check(snapshot, "B"), {
        property: FILL_STORAGE_PROPERTY.Items,
    });
});

test("orphan collection attributions cannot hide behind missing parent and item rows", () => {
    const snapshot = baselineFillFacts(ledger, { branch: "B" });
    snapshot.fillAttributions = baselineFillFacts(ledger).fillAttributions;
    assert.throws(() => check(snapshot, "B"), {
        property: FILL_STORAGE_PROPERTY.Attributions,
    });
});

test("canonical execution identity, provenance and monetary facts cannot be mutated or omitted", () => {
    for (const mutate of [
        (rows) => {
            rows.length = 0;
        },
        (rows) => {
            rows.push({ ...rows[0] });
        },
        (rows) => {
            rows[0].id += "-wrong";
        },
        (rows) => {
            rows[0].protocol_address = ledger.addresses.buyer;
        },
        (rows) => {
            rows[0].block_hash = ledger.blockAt("B", 104).hash;
        },
        (rows) => {
            rows[0].total_price = "999";
        },
        (rows) => {
            rows[0].currency = ledger.addresses.nft;
        },
        (rows) => {
            rows[0].nft_quantity = "2";
        },
        (rows) => {
            rows[0].price_exclusion = "unexpected-exclusion";
        },
    ]) {
        const snapshot = baselineFillFacts(ledger);
        mutate(snapshot.fillExecutions);
        assert.throws(() => check(snapshot), {
            property: FILL_STORAGE_PROPERTY.Executions,
        });
    }
});

test("all protocol items retain their raw side, recipient, amount and quantity prefix", () => {
    for (const mutate of [
        (rows) => {
            rows.pop();
        },
        (rows) => {
            rows.push({ ...rows[0] });
        },
        (rows) => {
            rows[0].recipient = ledger.addresses.seller;
        },
        (rows) => {
            rows[1].amount = "999";
        },
        (rows) => {
            rows[1].unit_offset = "0";
        },
        (rows) => {
            rows[1].side = rows[0].side;
        },
        (rows) => {
            rows[0].execution_id += "-orphan";
        },
    ]) {
        const snapshot = baselineFillFacts(ledger);
        mutate(snapshot.fillItems);
        assert.throws(() => check(snapshot), {
            property: FILL_STORAGE_PROPERTY.Items,
        });
    }
});

test("canonical collection attributions cannot move to another collection, token, item or order", () => {
    for (const mutate of [
        (rows) => {
            rows.length = 0;
        },
        (rows) => {
            rows.push({ ...rows[0] });
        },
        (rows) => {
            rows[0].collection_id++;
        },
        (rows) => {
            rows[0].token_id = "2";
        },
        (rows) => {
            rows[0].item_index = 1;
        },
        (rows) => {
            rows[0].order_id = ledger.orders.bid.orderHash;
        },
        (rows) => {
            rows[0].maker = ledger.addresses.buyer;
        },
        (rows) => {
            rows[0].amount = "2";
        },
        (rows) => {
            rows[0].block_hash = ledger.blockAt("B", 104).hash;
        },
    ]) {
        const snapshot = baselineFillFacts(ledger);
        mutate(snapshot.fillAttributions);
        assert.throws(() => check(snapshot), {
            property: FILL_STORAGE_PROPERTY.Attributions,
        });
    }
});

test("a transfer without protocol fulfillment never becomes an invented sale", () => {
    const transferOnly = createBaselineLedger({
        epochSeconds: 1_000_000,
        transferOnly: true,
    });
    assertCanonicalFillFacts({
        snapshot: baselineFillFacts(transferOnly),
        ledger: transferOnly,
        branch: "A",
        head: 107,
    });
});

test("the authored fill fixture rejects an unsupported extra execution shape", () => {
    const fixture = createBaselineLedger({ epochSeconds: 1_000_000 });
    fixture.orders.listing.tokenId = "2";
    assert.throws(
        () =>
            assertCanonicalFillFacts({
                snapshot: baselineFillFacts(ledger),
                ledger: fixture,
                branch: "A",
                head: 107,
            }),
        { property: FILL_STORAGE_PROPERTY.Fixture },
    );
});
