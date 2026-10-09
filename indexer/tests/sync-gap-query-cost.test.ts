import { beforeAll, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import { SYNC_GAP_POLICY } from "../src/application/sync-gap-scheduler.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

loadTestEnv();
const NOW = 4_000_000;
const NEWEST_BLOCK = 26_000_000;
const RETAINED_COLLECTIONS = 50_000;
const COVERED_BLOCKS = 400_000;
let newestId: number;
let coveredId: number;
let store: SqliteSyncGapStore;
let queries: string[];
const report: Record<string, unknown> = {};

beforeAll(async () => {
    setDbPath(await createTempDbPath());
    await createMigrationRunner().runMigrations();
    const collection = db.prepare(
        "INSERT INTO collections(chain_id,slug,address,standard,status,token_scope_kind,bootstrap_anchor_block) " +
            "VALUES(1,?,'0x1111111111111111111111111111111111111111',?,?,'contract_all_tokens',100)",
    );
    const progress = db.prepare(
        "INSERT INTO collection_sync_gap_scans(chain_id,collection_id,anchor_block,cursor_block,pending_job_id,pending_from_block,pending_to_block,retry_at,last_head_check_at) " +
            "VALUES(1,?,100,100,?,?,?,1000,?)",
    );
    const coverage = db.prepare(
        "INSERT INTO collection_sync_blocks(chain_id,collection_id,block_number) VALUES(1,?,?)",
    );
    db.writeTransaction(() => {
        for (let n = 0; n < RETAINED_COLLECTIONS; n++) {
            const id = Number(
                collection.run(
                    `pending-${n}`,
                    COLLECTION_STANDARD.Erc721,
                    COLLECTION_STATUS.Live,
                ).lastInsertRowid,
            );
            const to = n === RETAINED_COLLECTIONS - 1 ? NEWEST_BLOCK : 102;
            progress.run(id, `repair:${id}`, to - 1, to, NOW);
            newestId = id;
        }
        coveredId = Number(
            collection.run(
                "dense-coverage",
                COLLECTION_STANDARD.Erc721,
                COLLECTION_STATUS.Live,
            ).lastInsertRowid,
        );
        for (let block = 100; block < 100 + COVERED_BLOCKS; block++)
            if (block < 107 || block > 109) coverage.run(coveredId, block);
    })();
    db.exec("ANALYZE");
    const prepare = vi.spyOn(db, "prepare");
    store = new SqliteSyncGapStore();
    queries = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
}, 30_000);

it("uses ordered indexes and bounded reads even when the newest row follows 49,999 older rows", async () => {
    const input = {
        upperBound: NEWEST_BLOCK,
        chainId: 1,
        now: NOW,
        limit: SYNC_GAP_POLICY.CollectionsPerPass,
    };
    expect(
        store
            .listDueRepairsAtNewestPendingHeight(input)
            .map((repair) => repair.collectionId),
    ).toEqual([newestId]);
    const idleCheck = {
        chainId: 1,
        checkedBefore: NOW - SYNC_GAP_POLICY.HeadRecheckIntervalMs,
    };
    expect(store.hasHeadRechecksDue(idleCheck)).toBe(false);
    const headCheck = {
        chainId: 1,
        checkedBefore: NOW,
        headBlock: NEWEST_BLOCK,
        limit: input.limit,
        after: { collectionId: newestId - 16, lastHeadCheckAt: NOW },
    };
    expect(
        store
            .listHeadRechecksAfter(headCheck)
            .map((check) => check.collectionId),
    ).toEqual(Array.from({ length: 16 }, (_, n) => newestId - 15 + n));
    for (const sql of queries.filter((sql) =>
        sql.includes("FROM collection_sync_gap_scans s"),
    )) {
        const bindings: Record<string, number | string> = {
            chainId: 1,
            status: COLLECTION_STATUS.Live,
        };
        if (sql.includes("@upperBound")) bindings.upperBound = NEWEST_BLOCK;
        if (sql.includes("@toBlock")) bindings.toBlock = NEWEST_BLOCK;
        if (sql.includes("@now")) bindings.now = NOW;
        if (sql.includes("@limit")) bindings.limit = input.limit;
        if (sql.includes("@checkedBefore")) bindings.checkedBefore = NOW;
        if (sql.includes("@headBlock")) bindings.headBlock = NEWEST_BLOCK;
        if (sql.includes("@afterHeadCheckAt")) bindings.afterHeadCheckAt = NOW;
        if (sql.includes("@afterCollectionId"))
            bindings.afterCollectionId = headCheck.after.collectionId;
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(bindings) as {
            detail: string;
        }[];
        expect(
            plan.some((row) =>
                row.detail.includes("collection_sync_gap_scans_"),
            ),
            JSON.stringify({ sql, plan }),
        ).toBe(true);
        expect(
            plan.some((row) => row.detail.includes("TEMP B-TREE")),
            JSON.stringify({ sql, plan }),
        ).toBe(false);
    }
    report.selection = {
        workload: "recent_gap_queries",
        retainedCollections: RETAINED_COLLECTIONS,
        newestSelectionMs: measure(() =>
            store.listDueRepairsAtNewestPendingHeight(input),
        ),
        idleHeadCheckMs: measure(() => store.hasHeadRechecksDue(idleCheck)),
        headCheckSeekMs: measure(() => store.listHeadRechecksAfter(headCheck)),
    };
    await writeReport();
});

it("finds a deep newest hole across dense coverage without reading an array of that history", async () => {
    const window = { fromBlock: 100, toBlock: 100 + COVERED_BLOCKS - 1 };
    expect(store.findNewestGap(1, coveredId, window, 30)).toEqual({
        fromBlock: 107,
        toBlock: 109,
    });
    report.coverage = {
        workload: "dense_head_gap_check",
        spanBlocks: COVERED_BLOCKS,
        deepHoleMs: measure(
            () => store.findNewestGap(1, coveredId, window, 30),
            5,
        ),
    };
    await writeReport();
});

async function writeReport() {
    await writeFile(
        resolveProjectPath("tmp/recent-gap-query-cost.json"),
        JSON.stringify(report, null, 2) + "\n",
    );
}

function measure(operation: () => unknown, samples = 30) {
    const elapsed: number[] = [];
    for (let n = 0; n < samples; n++) {
        const started = performance.now();
        operation();
        elapsed.push(performance.now() - started);
    }
    elapsed.sort((a, b) => a - b);
    return { median: elapsed[Math.floor(samples / 2)], max: elapsed.at(-1) };
}
