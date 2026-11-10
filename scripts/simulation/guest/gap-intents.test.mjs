import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { db, setDbPath } from "../../../shared/database/db.ts";
import { MigrationRunner } from "../../../shared/database/migrations.ts";
import {
    COLLECTION_STANDARD,
    COLLECTION_STATUS,
} from "../../../shared/types/browse.ts";
import { COLLECTION_TOKEN_SCOPE_KIND } from "../../../shared/collections/token-scope.ts";
import { createArtifactRunDirectory } from "../artifacts.mjs";
import {
    observeGapRepairIntents,
    inspectGapRepairIntents,
    assertGapRepairIntentsSettled,
    GAP_INTENT_PROPERTY,
    GAP_INTENT_DEFERRED,
} from "./gap-intents.mjs";

const intent = () => ({
    chain_id: 1,
    collection_id: 42,
    anchor_block: 100,
    cursor_block: 100,
    pending_job_id: "retained-gap",
    pending_from_block: 101,
    pending_to_block: 104,
    retry_at: 1_000,
    collection_status: COLLECTION_STATUS.Live,
    current_anchor_block: 100,
});
const inspect = (rows, options = {}) =>
    inspectGapRepairIntents({
        rows,
        head: 107,
        reorgDepth: 3,
        now: 1_000,
        ...options,
    });

test("empty queues and covered blocks cannot hide a due SQLite repair intent", () => {
    // Neither queue length nor already-covered blocks discharges this separate
    // persisted obligation. The worker may reconcile it locally without RPC.
    const state = {
        retainedMessages: 0,
        coverage: [101, 102, 103, 104],
        rows: [intent()],
    };
    const pending = inspect(state.rows);
    assert.equal(pending.eligibleUpperBound, 104);
    assert.equal(pending.due.length, 1);
    assert.throws(
        () => assertGapRepairIntentsSettled(pending),
        (error) => error.property === GAP_INTENT_PROPERTY,
    );
    const retired = inspect([
        {
            ...intent(),
            pending_job_id: null,
            pending_from_block: null,
            pending_to_block: null,
            retry_at: null,
        },
    ]);
    assertGapRepairIntentsSettled(retired);
    assert.equal(retired.idle.length, 1);
});

test("the exact maturity and retry boundaries become due while deferred work remains explicit", () => {
    for (const [change, reason] of [
        [
            { collection_status: COLLECTION_STATUS.Paused },
            GAP_INTENT_DEFERRED.Inactive,
        ],
        [{ current_anchor_block: 101 }, GAP_INTENT_DEFERRED.AnchorChanged],
        [{ pending_to_block: 105 }, GAP_INTENT_DEFERRED.Immature],
        [{ retry_at: 1_001 }, GAP_INTENT_DEFERRED.Retry],
    ]) {
        const result = inspect([{ ...intent(), ...change }]);
        assertGapRepairIntentsSettled(result);
        assert.deepEqual(
            result.deferred.map((entry) => entry.reason),
            [reason],
        );
        assert.deepEqual(result.deferred[0].intent, { ...intent(), ...change });
    }
    assert.equal(inspect([intent()]).due.length, 1);
    const retry = { ...intent(), retry_at: 1_001 };
    assert.equal(inspect([retry], { now: 1_001 }).due.length, 1);
    const immature = { ...intent(), pending_to_block: 105 };
    assert.equal(inspect([immature], { head: 108 }).due.length, 1);
});

test("missing observations and partial or malformed pending records cannot silently qualify", () => {
    assert.throws(() => inspect(undefined));
    for (const change of [
        { pending_job_id: undefined },
        { pending_from_block: undefined },
        { pending_to_block: "104" },
        { retry_at: null },
        { pending_job_id: null },
        { collection_status: undefined },
        { current_anchor_block: undefined },
        { current_anchor_block: "100" },
        { current_anchor_block: -1 },
        { cursor_block: undefined },
    ])
        assert.throws(() => inspect([{ ...intent(), ...change }]));
});

test("the raw observer reads migrated intent fields and scopes the tested collection", async () => {
    const directory = await createArtifactRunDirectory(
        fileURLToPath(
            new URL(
                "../../../tmp/simulation-gap-intent-tests/",
                import.meta.url,
            ),
        ),
        "observation-",
    );
    const filename = path.join(directory, "artgod.sqlite");
    setDbPath(filename);
    try {
        await new MigrationRunner(
            fileURLToPath(
                new URL("../../../database/migrations/", import.meta.url),
            ),
        ).runMigrations();
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind,bootstrap_anchor_block) VALUES(42,1,'gap-test','0x1111111111111111111111111111111111111111',?,?,?,100)",
        ).run(
            COLLECTION_STANDARD.Erc721,
            COLLECTION_STATUS.Live,
            COLLECTION_TOKEN_SCOPE_KIND.AllContractTokens,
        );
        db.prepare(
            "INSERT INTO collection_sync_gap_scans(chain_id,collection_id,anchor_block,cursor_block,pending_job_id,pending_from_block,pending_to_block,retry_at) VALUES(1,42,100,100,'retained-gap',101,104,1000)",
        ).run();
        assert.deepEqual(observeGapRepairIntents(db.raw, 1, 42), [intent()]);
        assert.deepEqual(observeGapRepairIntents(db.raw, 2, 42), []);
        assert.deepEqual(observeGapRepairIntents(db.raw, 1, 43), []);
        assert.equal(
            inspect(observeGapRepairIntents(db.raw, 1, 42)).due.length,
            1,
        );
    } finally {
        db.raw.close();
        setDbPath(filename);
    }
});
