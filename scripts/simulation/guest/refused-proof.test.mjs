import assert from "node:assert/strict";
import test from "node:test";
import { verifyRefusedProof } from "./refused-proof.mjs";
import { createBaselineLedger } from "../world/ledger.mjs";
import { ZERO_ADDRESS } from "../world/wire.mjs";
import { COLLECTION_STANDARD } from "../../../shared/types/browse.ts";
import { baselineFillFacts } from "./fixtures/fill-facts.mjs";
import { FILL_STORAGE_PROPERTY } from "./fill-oracle.mjs";
import { REORG_RECOVERY_PHASE } from "../../../indexer/src/domain/reorg-recovery.ts";

// Oracle guards only. Actual acquisition/proof/refusal requires the authored VM.
function fixture({
    deleteHistory = false,
    appendAnchorHeader = false,
    headerFault,
    fillFault,
} = {}) {
    const ledger = createBaselineLedger({ epochSeconds: 1_000_000 });
    const header = (number) => ({
        block_number: number,
        block_hash: ledger.blockAt("A", number).hash,
        parent_hash: ledger.blockAt("A", number).parentHash,
    });
    const transfer = (number, tokenId, from, to) => {
        const block = ledger.blockAt("A", number);
        return {
            chain_id: ledger.chainId,
            collection_id: 42,
            contract_address: ledger.addresses.nft,
            from_address: from,
            to_address: to,
            token_id: tokenId,
            amount: "1",
            block_number: number,
            block_hash: block.hash,
            block_timestamp: block.timestamp,
            tx_hash: block.logs[0].transactionHash,
            log_index: 0,
            kind: COLLECTION_STANDARD.Erc721,
        };
    };
    const before = {
        ...baselineFillFacts(ledger, { branch: "A", head: 108 }),
        revision: 0,
        recovery: [],
        canonicalChecks: [],
        pendingDemand: [],
        unfinishedMaker: [],
        pendingOutbox: [],
        owners: [
            { token_id: "1", owner: ledger.addresses.buyer, amount: "1" },
            { token_id: "2", owner: ledger.addresses.seller, amount: "1" },
        ],
        transfers: [
            transfer(101, "1", ZERO_ADDRESS, ledger.addresses.seller),
            transfer(102, "2", ZERO_ADDRESS, ledger.addresses.seller),
            transfer(104, "1", ledger.addresses.seller, ledger.addresses.buyer),
        ],
        activities: [{ kind: "transfer", block_number: 101, token_id: "1" }],
        coverage: Array.from({ length: 8 }, (_, i) => ({
            block_number: 101 + i,
        })),
        headers: Array.from({ length: 8 }, (_, i) => header(101 + i)),
    };
    const after = structuredClone(before);
    if (fillFault) after[fillFault] = [];
    if (appendAnchorHeader) after.headers.unshift(header(100));
    if (headerFault === "hash") after.headers[1].block_hash = "B:102";
    if (headerFault === "parent") after.headers[1].parent_hash = "B:101";
    if (headerFault === "delete") after.headers.splice(1, 1);
    if (deleteHistory) after.activities = [];
    // This reproduces the observed framework counterexample: independently
    // queued legitimate A projection commits after acquisition/proof settles.
    after.activities.push({ kind: "sale", block_number: 104, token_id: "1" });
    after.recovery.push({
        phase: REORG_RECOVERY_PHASE.AwaitingAncestor,
        checked_block: 107,
        last_error: "No verified common ancestor",
        retry_at: Date.now() + 60_000,
    });
    let switched = false;
    const world = {
        trace: [],
        setPhase() {},
        advanceHead() {},
        switchBranch() {
            switched = true;
            this.trace = [104, 105, 106, 107].map((blockNumber) => ({
                type: "read",
                phase: "refusal-requested-b",
                method: "eth_getBlockByNumber",
                blockNumber,
                view: { branch: "B" },
            }));
        },
    };
    return {
        world,
        ledger,
        observe: () => (switched ? after : before),
        reorgDepth: 3,
        async closeSources() {},
        async eventually(predicate, label) {
            assert.equal(await predicate(), true, label);
        },
    };
}

test("refused ancestry preserves retained facts while legitimate old-branch history may finish", async () => {
    const result = await verifyRefusedProof(fixture());
    assert.equal(result.endpoint, "awaiting-verified-ancestor");
    assert.equal(
        result.after.activities.length,
        result.before.activities.length + 1,
    );
    assert.equal(result.after.revision, result.before.revision);
});

test("additional history never hides deletion of an already retained fact", async () => {
    await assert.rejects(
        verifyRefusedProof(fixture({ deleteHistory: true })),
        /cannot delete retained history/,
    );
});

test("late legitimate acquisition of the anchor header does not imply retained header replacement", async () => {
    const result = await verifyRefusedProof(
        fixture({ appendAnchorHeader: true }),
    );
    assert.equal(result.after.headers.length, result.before.headers.length + 1);
    assert.equal(result.after.headers[0].block_number, 100);
});

test("new headers never excuse mutation or deletion of a previously verified hash or parent", async () => {
    for (const headerFault of ["hash", "parent", "delete"])
        await assert.rejects(
            verifyRefusedProof(
                fixture({ appendAnchorHeader: true, headerFault }),
            ),
            /retained fork headers/,
        );
});

test("unproved ancestry cannot delete retained fill executions, items or collection attributions", async () => {
    for (const [fillFault, property] of [
        ["fillExecutions", FILL_STORAGE_PROPERTY.Executions],
        ["fillItems", FILL_STORAGE_PROPERTY.Items],
        ["fillAttributions", FILL_STORAGE_PROPERTY.Attributions],
    ])
        await assert.rejects(verifyRefusedProof(fixture({ fillFault })), {
            property,
        });
});
