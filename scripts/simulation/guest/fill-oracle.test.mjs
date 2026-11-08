import assert from "node:assert/strict";
import test from "node:test";
import { createBaselineLedger } from "../world/ledger.mjs";
import {
    assertCanonicalFillFacts,
    FILL_STORAGE_PROPERTY,
} from "./fill-oracle.mjs";
import { baselineFillFacts } from "./fixtures/fill-facts.mjs";

const ledger = createBaselineLedger({ epochSeconds: 1_000_000 });
const check = (snapshot, branch = "A", head = 107) =>
    assertCanonicalFillFacts({ snapshot, ledger, branch, head });

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
