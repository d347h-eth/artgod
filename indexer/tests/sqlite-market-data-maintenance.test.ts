import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { statSync } from "node:fs";
import { getProjectRoot } from "@artgod/shared/utils/paths";
import { relative } from "node:path";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    CompactMarketData,
    MARKET_DATA_COMPACTION_SKIP_REASON,
} from "../src/application/storage/compact-market-data.js";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SqliteCurrentAsks } from "@artgod/shared/database/current-asks";
import { ACTIVITY_KIND, ACTIVITY_SOURCE_KIND } from "@artgod/shared/types";
import {
    MARKET_DATA_RECOVERY_STAGE as STAGE,
    MARKET_DATA_STORAGE_POLICY as POLICY,
} from "@artgod/shared/market-data/storage-policy";
import { MaintainMarketData } from "../src/application/storage/maintain-market-data.js";
import { SqliteMarketDataMaintenance } from "../src/infra/storage/sqlite-market-data-maintenance.js";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SIDE,
    type OrderStatus,
} from "../src/domain/orders.js";
import type { OrderUpsertPayload } from "../src/domain/order-jobs.js";
import {
    orderRetirementReason,
    ORDER_RETIREMENT_REASON,
} from "../src/domain/order-retention.js";
import { SqliteActivityDomain } from "../src/infra/domain/activities.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { MARKET_ORDER_CLEANUP_QUERIES } from "../src/infra/storage/sqlite-market-order-queries.js";
import { ACTIVITY_SCOPE_KIND } from "@artgod/shared/types";

const NOW = 1_800_000_000;
describe("in-place SQLite market-data recovery", () => {
    loadTestEnv();
    let path: string;
    let storage: SqliteMarketDataMaintenance;
    beforeEach(async () => {
        path = await createTempDbPath();
        setDbPath(path);
        await createMigrationRunner().runMigrations();
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind) VALUES (99,1,'fixture','0xcollection','erc721','ready','contract_all_tokens')",
        ).run();
        storage = new SqliteMarketDataMaintenance(db);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        db.raw.close();
    });

    function activity(id: number, kind: string, source: string, at = NOW - 10) {
        db.prepare(
            "INSERT INTO activities(id,chain_id,collection_id,scope_kind,kind,contract_address,token_id,occurred_at,source_kind,source_name,order_id,maker,currency,dedupe_key) VALUES (?,1,99,'token',?,'0xcollection','1',?,?,'fixture',?,'maker','ETH',?)",
        ).run(id, kind, at, source, `order-${id}`, `event-${id}`);
    }
    function order(
        id: string,
        until: number | null,
        status: OrderStatus = ORDER_STATUS.Fillable,
    ) {
        db.prepare(
            "INSERT INTO orders(id,chain_id,collection_id,kind,maker,contract_address,valid_until,fillability_status,source_status,updated_at,seaport_data_json) VALUES (?,1,99,'seaport','maker','0xcollection',?,?,?,datetime(?,'unixepoch'),?)",
        ).run(
            id,
            until,
            status,
            ORDER_SOURCE_STATUS.Active,
            NOW - 7200,
            JSON.stringify({ protocolAddress: "0xProtocol" }),
        );
    }
    const recover = () =>
        new MaintainMarketData(storage, { nowSeconds: () => NOW }).recover();

    it("observes the real WAL when the DB configuration is workspace-relative", async () => {
        setDbPath(relative(getProjectRoot(), path));
        const observer = new SqliteMarketDataMaintenance(db);
        db.raw.pragma("wal_autocheckpoint=0");
        activity(1, ACTIVITY_KIND.Sale, ACTIVITY_SOURCE_KIND.Onchain);
        const expected = statSync(`${db.raw.name}-wal`).size;
        expect(expected).toBeGreaterThan(0);
        expect(db.raw.name).toBe(path);
        expect(await observer.observeWal()).toMatchObject({
            walBytes: expected,
        });
    });

    it("rolls back an interrupted online delete batch and retries it through the shared boundary", async () => {
        await recover();
        order("expired", NOW - 1);
        const prepare = db.raw.prepare.bind(db.raw);
        let attempts = 0;
        vi.spyOn(db.raw, "prepare").mockImplementation((sql: string) => {
            const statement = prepare(sql);
            if (sql === "DELETE FROM orders WHERE id=?") {
                const run = statement.run.bind(statement);
                statement.run = (...values: unknown[]) => {
                    const result = run(...values);
                    if (++attempts === 1)
                        throw new Database.SqliteError(
                            "fixture busy",
                            "SQLITE_BUSY",
                        );
                    return result;
                };
            }
            return statement;
        });
        expect(storage.maintainBatch(NOW)).toBe(1);
        expect(attempts).toBe(2);
        expect(db.prepare("SELECT id FROM orders").all()).toEqual([]);
    });

    it("drains expired cancellation records even with no orders, and takes no writer lock when idle", async () => {
        await recover();
        const insert = db.prepare(
            "INSERT INTO market_order_retirements(chain_id,collection_id,order_id,expires_at,retired_at,reason) VALUES (1,99,?,?,?,?)",
        );
        db.writeTransaction(() => {
            for (let i = 0; i < 1600; i++)
                insert.run(
                    String(i),
                    NOW - 1,
                    NOW - 100,
                    ORDER_RETIREMENT_REASON.SourceCancelled,
                );
        })();
        let processed = 0;
        for (let i = 0; i < 10; i++) {
            const n = storage.maintainBatch(NOW);
            processed += n;
            if (!n) break;
        }
        expect(processed).toBe(1600);
        expect(
            db
                .prepare("SELECT COUNT(*) AS n FROM market_order_retirements")
                .get(),
        ).toEqual({ n: 0 });
        const writer = vi.spyOn(db.raw, "transaction");
        expect(storage.maintainBatch(NOW)).toBe(0);
        expect(writer).not.toHaveBeenCalled();
        writer.mockRestore();
    });

    it("preserves order expiry and the observation cutoff when cleaning inactive orders", async () => {
        await recover();
        order("inactive-soon-expired", NOW + 600);
        order("inactive-replay-ended", NOW + POLICY.utcDaySeconds);
        const change = db.prepare(
            "UPDATE orders SET source_status=?,observed_at=? WHERE id=?",
        );
        change.run(
            ORDER_SOURCE_STATUS.Inactive,
            NOW - POLICY.unknownOrderLifetimeSeconds / 2,
            "inactive-soon-expired",
        );
        change.run(
            ORDER_SOURCE_STATUS.Inactive,
            NOW - POLICY.unknownOrderLifetimeSeconds,
            "inactive-replay-ended",
        );
        expect(storage.maintainBatch(NOW)).toBe(2);
        expect(
            db
                .prepare(
                    "SELECT order_id,valid_until,retired_at,expires_at FROM market_order_retirements",
                )
                .all(),
        ).toEqual([
            {
                order_id: "inactive-soon-expired",
                valid_until: NOW + 600,
                retired_at: NOW - POLICY.unknownOrderLifetimeSeconds / 2,
                expires_at: NOW + 600,
            },
        ]);
        expect(storage.maintainBatch(NOW + 600)).toBe(1);
        expect(
            db
                .prepare("SELECT COUNT(*) AS n FROM market_order_retirements")
                .get(),
        ).toEqual({ n: 0 });
    });

    it("does not run online cleanup on a completed startup, and WAL observation runs no SQL", async () => {
        await recover();
        const cleanup = vi.spyOn(storage, "maintainBatch");
        await recover();
        expect(cleanup).not.toHaveBeenCalled();
        const prepare = vi.spyOn(db.raw, "prepare");
        const pragma = vi.spyOn(db.raw, "pragma");
        expect(await storage.observeWal()).toMatchObject({ walBytes: 0 });
        expect(prepare).not.toHaveBeenCalled();
        expect(pragma).not.toHaveBeenCalled();
        prepare.mockRestore();
        pragma.mockRestore();
        cleanup.mockRestore();
    });

    it("uses indexed due-work selection and ordered maker pagination", async () => {
        await recover();
        for (const query of MARKET_ORDER_CLEANUP_QUERIES) {
            const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all({
                now: NOW,
                terminalBefore: NOW - 3600,
                inactiveBefore: NOW - 3600,
                unknownBefore: NOW - 86400,
                limit: 500,
            }) as { detail: string }[];
            expect(
                plan.some((row) =>
                    row.detail.startsWith("SEARCH orders USING INDEX"),
                ),
            ).toBe(true);
            expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(
                false,
            );
        }
        const domain = new SqliteOrdersDomain("0xweth", async () => ({
            status: ORDER_STATUS.Fillable,
            reason: "fixture",
        }));
        for (const name of [
            "selectMakerSeaportOrders",
            "selectMakerWethBuyOrders",
            "selectMakerSellOrdersForToken",
            "selectMakerSellOrdersForCollection",
        ]) {
            const query = (
                domain as unknown as Record<string, { source: string }>
            )[name]!.source;
            const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all({
                chainId: 1,
                collectionId: 99,
                tokenId: "1",
                maker: "maker",
                currency: "0xweth",
                nowSeconds: NOW,
                afterId: "",
                batchLimit: 500,
                sourceStatus: ORDER_SOURCE_STATUS.Active,
                fillableStatus: ORDER_STATUS.Fillable,
                noBalanceStatus: ORDER_STATUS.NoBalance,
                noApprovalStatus: ORDER_STATUS.NoApproval,
            }) as { detail: string }[];
            expect(
                plan.some((row) => row.detail.includes("TEMP B-TREE")),
                name,
            ).toBe(false);
            expect(
                plan.some((row) => row.detail.includes("id>?")),
                name,
            ).toBe(true);
        }
    });

    it("keeps OpenSea cancellations through an unrelated chain rollback, including after cleanup", async () => {
        order("source-cancelled", NOW + 3600);
        order("retired-source-cancelled", NOW + 3600);
        db.prepare("UPDATE orders SET source_status=?").run(
            ORDER_SOURCE_STATUS.Cancelled,
        );
        await recover();
        expect(
            db.prepare("SELECT reason FROM market_order_retirements").all(),
        ).toEqual([
            { reason: ORDER_RETIREMENT_REASON.SourceCancelled },
            { reason: ORDER_RETIREMENT_REASON.SourceCancelled },
        ]);
        order("source-still-retained", NOW + 3600);
        db.prepare(
            "UPDATE orders SET source_status=? WHERE id='source-still-retained'",
        ).run(ORDER_SOURCE_STATUS.Cancelled);
        new SqliteStorage().rollbackFromBlock(1, 999999);
        expect(db.prepare("SELECT id FROM orders").all()).toEqual([
            { id: "source-still-retained" },
        ]);
        expect(
            db
                .prepare("SELECT COUNT(*) AS n FROM market_order_retirements")
                .get(),
        ).toEqual({ n: 2 });
    });

    describe.each(["cancel", "fill"])(
        "source cancellation alongside chain %s",
        (chainReason) => {
            it.each([
                {
                    scenario: "source cancellation follows the chain event",
                    sourceFirst: false,
                    retireFirst: false,
                    fromBlock: 999999,
                },
                {
                    scenario:
                        "source cancellation precedes the rolled-back chain event",
                    sourceFirst: true,
                    retireFirst: false,
                    fromBlock: 100,
                },
                {
                    scenario:
                        "source cancellation follows retirement of the chain event",
                    sourceFirst: false,
                    retireFirst: true,
                    fromBlock: 999999,
                },
            ])(
                "preserves cancellation when $scenario",
                async ({ sourceFirst, retireFirst, fromBlock }) => {
                    await recover();
                    db.prepare(
                        "UPDATE collections SET bootstrap_anchor_block=0 WHERE chain_id=1 AND collection_id=99",
                    ).run();
                    let now = NOW;
                    const domain = new SqliteOrdersDomain(
                        "0xweth",
                        async () => {
                            throw new Error("No validation expected");
                        },
                        undefined,
                        () => now,
                    );
                    db.prepare(
                        "INSERT INTO tokens(chain_id,collection_id,contract_address,token_id) VALUES (1,99,'0xcollection','1')",
                    ).run();
                    const payload: OrderUpsertPayload = {
                        chainId: 1,
                        collectionId: 99,
                        orderId: "source-and-chain-cancelled",
                        kind: "seaport",
                        side: ORDER_SIDE.Sell,
                        source: "opensea",
                        rawSourceKind: "stream",
                        validateAfterUpsert: true,
                        maker: "maker",
                        contract: "0xcollection",
                        tokenId: "1",
                        sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
                        price: "10",
                        currency: "ETH",
                        validUntil: NOW + 2 * POLICY.utcDaySeconds,
                        observedAt: now,
                        sourceStatus: ORDER_SOURCE_STATUS.Active,
                    };
                    const currentAsks = new SqliteCurrentAsks(db.raw, ["eth"]);
                    await domain.handleOrderUpsert(payload);
                    expect(
                        currentAsks.forSeller(1, 99, "1", "maker", now)?.id,
                    ).toBe(payload.orderId);

                    const cancelAtSource = () =>
                        domain.handleOrderUpdateById({
                            chainId: 1,
                            collectionId: 99,
                            orderId: payload.orderId,
                            reason: "cancel",
                            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                            observedAt: now,
                        });
                    // Align SQLite's wall-clock timestamps with this fixture's clock.
                    const ageOrder = () =>
                        db
                            .prepare(
                                "UPDATE orders SET updated_at=datetime(?,'unixepoch') WHERE id=?",
                            )
                            .run(
                                now - POLICY.orderReorgGraceSeconds - 1,
                                payload.orderId,
                            );

                    if (sourceFirst) await cancelAtSource();
                    await domain.handleOrderUpdateById({
                        chainId: 1,
                        orderId: payload.orderId,
                        reason: chainReason,
                        blockNumber: 100,
                    });
                    expect(
                        db
                            .prepare(
                                "SELECT fillability_status,block_number FROM orders",
                            )
                            .get(),
                    ).toEqual({
                        fillability_status:
                            chainReason === "cancel"
                                ? ORDER_STATUS.Cancelled
                                : ORDER_STATUS.Filled,
                        block_number: 100,
                    });
                    const expiry =
                        payload.validUntil! + POLICY.orderReorgGraceSeconds;
                    if (retireFirst) {
                        ageOrder();
                        expect(storage.maintainBatch(now)).toBe(1);
                        expect(
                            db
                                .prepare(
                                    "SELECT reason,expires_at FROM market_order_retirements",
                                )
                                .get(),
                        ).toEqual({
                            reason: ORDER_RETIREMENT_REASON.Terminal,
                            expires_at: expiry,
                        });
                    }
                    now += 1;
                    if (!sourceFirst) await cancelAtSource();

                    new SqliteStorage().rollbackFromBlock(1, fromBlock);
                    expect(
                        await domain.handleOrderUpsert(payload),
                    ).toMatchObject({
                        changed: false,
                        validationNeeded: false,
                    });
                    expect(
                        currentAsks.forSeller(1, 99, "1", "maker", now),
                    ).toBeUndefined();

                    // The normal online cleanup still releases the cancelled payload.
                    if (!retireFirst) {
                        ageOrder();
                        expect(storage.maintainBatch(now)).toBe(1);
                    }
                    expect(db.prepare("SELECT id FROM orders").all()).toEqual(
                        [],
                    );
                    expect(
                        db
                            .prepare(
                                "SELECT reason,expires_at FROM market_order_retirements",
                            )
                            .get(),
                    ).toEqual({
                        reason: ORDER_RETIREMENT_REASON.SourceCancelled,
                        expires_at: expiry,
                    });
                    // Neither duplicate cancellation nor weaker source evidence may
                    // downgrade this marker or shorten its known validity deadline.
                    await cancelAtSource();
                    await domain.handleOrderUpdateById({
                        chainId: 1,
                        collectionId: 99,
                        orderId: payload.orderId,
                        reason: "fill",
                        sourceStatus: ORDER_SOURCE_STATUS.Filled,
                        observedAt: now + 1,
                    });
                    new SqliteStorage().rollbackFromBlock(1, 100);
                    expect(
                        db
                            .prepare(
                                "SELECT reason,expires_at FROM market_order_retirements",
                            )
                            .get(),
                    ).toEqual({
                        reason: ORDER_RETIREMENT_REASON.SourceCancelled,
                        expires_at: expiry,
                    });
                    expect(
                        await domain.handleOrderUpsert(payload),
                    ).toMatchObject({
                        changed: false,
                        validationNeeded: false,
                    });
                    expect(
                        currentAsks.forSeller(1, 99, "1", "maker", now),
                    ).toBeUndefined();
                },
            );
        },
    );

    it("invalidates only the reorganized chain's negative market cache when terminal block attribution is unknown", () => {
        order("terminal", NOW + 3600, ORDER_STATUS.Cancelled);
        order("live", NOW + 3600);
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind) VALUES (100,2,'other','0xother','erc721','ready','contract_all_tokens')",
        ).run();
        db.prepare(
            "INSERT INTO orders(id,chain_id,collection_id,kind,maker,contract_address,fillability_status,source_status) VALUES ('other',2,100,'seaport','maker','0xother',?,?)",
        ).run(ORDER_STATUS.Cancelled, ORDER_SOURCE_STATUS.Active);
        db.prepare(
            "INSERT INTO market_order_retirements(chain_id,collection_id,order_id,expires_at,retired_at,reason) VALUES (1,99,'retired',?,?,?), (2,100,'other-retired',?,?,?)",
        ).run(
            NOW + 3600,
            NOW,
            ORDER_RETIREMENT_REASON.Terminal,
            NOW + 3600,
            NOW,
            ORDER_RETIREMENT_REASON.Terminal,
        );
        new SqliteStorage().rollbackFromBlock(1, 100);
        expect(db.prepare("SELECT id FROM orders ORDER BY id").all()).toEqual([
            { id: "live" },
            { id: "other" },
        ]);
        expect(
            db.prepare("SELECT order_id FROM market_order_retirements").all(),
        ).toEqual([{ order_id: "other-retired" }]);
    });

    it("preserves valuable rows and user settings while removing receipts, obsolete history and expired payloads", async () => {
        activity(1, ACTIVITY_KIND.BidCreated, ACTIVITY_SOURCE_KIND.Offchain);
        activity(
            2,
            ACTIVITY_KIND.ListingCancelled,
            ACTIVITY_SOURCE_KIND.Offchain,
        );
        activity(
            3,
            ACTIVITY_KIND.ListingCreated,
            ACTIVITY_SOURCE_KIND.Offchain,
            NOW - POLICY.utcDaySeconds,
        );
        activity(
            4,
            ACTIVITY_KIND.ListingCreated,
            ACTIVITY_SOURCE_KIND.Offchain,
        );
        activity(
            5,
            ACTIVITY_KIND.Sale,
            ACTIVITY_SOURCE_KIND.Onchain,
            NOW - 10_000_000,
        );
        activity(
            6,
            ACTIVITY_KIND.Transfer,
            ACTIVITY_SOURCE_KIND.Onchain,
            NOW - 10_000_000,
        );
        activity(
            7,
            ACTIVITY_KIND.Custom,
            ACTIVITY_SOURCE_KIND.Extension,
            NOW - 10_000_000,
        );
        order("expired", NOW - 1);
        order("live", NOW + 3600);
        order("balance-can-recover", NOW + 3600, ORDER_STATUS.NoBalance);
        order("terminal", NOW + 3600, ORDER_STATUS.Cancelled);
        db.prepare(
            "INSERT INTO app_settings(key,value) VALUES ('preserve','exact-value')",
        ).run();
        await recover();
        expect(
            db.prepare("SELECT id FROM activities ORDER BY id").all(),
        ).toEqual([5, 6, 7].map((id) => ({ id })));
        expect(db.prepare("SELECT id FROM orders ORDER BY id").all()).toEqual([
            { id: "balance-can-recover" },
            { id: "live" },
        ]);
        expect(
            db
                .prepare("SELECT protocol_address FROM orders WHERE id='live'")
                .get(),
        ).toEqual({ protocol_address: "0xprotocol" });
        expect(
            db.prepare("SELECT order_id FROM market_order_retirements").all(),
        ).toEqual([{ order_id: "terminal" }]);
        expect(
            db
                .prepare(
                    "SELECT name FROM sqlite_schema WHERE name='activity_sources'",
                )
                .get(),
        ).toBeUndefined();
        expect(
            db
                .prepare("SELECT value FROM app_settings WHERE key='preserve'")
                .get(),
        ).toEqual({ value: "exact-value" });
        expect(db.raw.pragma("quick_check", { simple: true })).toBe("ok");
        const before = db.prepare("SELECT * FROM activities").all();
        await recover();
        expect(db.prepare("SELECT * FROM activities").all()).toEqual(before);
    });

    it("resumes a committed batch after closing the connection; swap and cursor are atomic", async () => {
        db.raw.transaction(() => {
            for (let id = 1; id <= POLICY.maintenanceBatchRows + 1; id++)
                activity(
                    id,
                    ACTIVITY_KIND.BidCreated,
                    ACTIVITY_SOURCE_KIND.Offchain,
                );
        })();
        storage.recoverBatch(NOW); // Reset any pre-revision shadow image.
        storage.recoverBatch(NOW);
        expect(storage.inspect().cursor).toBe(POLICY.maintenanceBatchRows);
        setDbPath(path);
        storage = new SqliteMarketDataMaintenance(db);
        await recover();
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM activities").get(),
        ).toEqual({ n: 0 });
        expect(storage.inspect().stage).toBe(STAGE.Complete);
        db.raw
            .prepare(
                "INSERT INTO activities(chain_id,collection_id,scope_kind,kind,contract_address,occurred_at,source_kind,source_name,dedupe_key) VALUES (1,99,'collection',?,'0xcollection',?,?, 'fixture','after-empty-rebuild')",
            )
            .run(ACTIVITY_KIND.Sale, NOW, ACTIVITY_SOURCE_KIND.Onchain);
        expect(db.prepare("SELECT id FROM activities").get()).toEqual({
            id: POLICY.maintenanceBatchRows + 2,
        });
        expect(
            db
                .prepare(
                    "SELECT name FROM sqlite_schema WHERE name='activities_daily_listing_idx'",
                )
                .get(),
        ).toEqual({ name: "activities_daily_listing_idx" });
    });

    it("can rebuild a schema whose extension indexes are already partial", async () => {
        activity(1, ACTIVITY_KIND.Custom, ACTIVITY_SOURCE_KIND.Extension);
        await recover();
        db.prepare(
            "UPDATE market_data_recovery SET stage=?,cursor=0 WHERE singleton=1",
        ).run(STAGE.Activities);
        await recover();
        expect(db.prepare("SELECT id FROM activities").all()).toEqual([
            { id: 1 },
        ]);
        expect(db.raw.pragma("quick_check", { simple: true })).toBe("ok");
    });

    it("cancels before another batch and does not turn progress into a renewed deadline", async () => {
        const abort = new AbortController();
        abort.abort();
        await expect(
            new MaintainMarketData(storage).recover(abort.signal),
        ).rejects.toThrow();
        let elapsed = 0;
        await expect(
            new MaintainMarketData(storage, {
                monotonicNow: () => (elapsed += POLICY.recoveryBudgetMs),
            }).recover(),
        ).rejects.toThrow("deadline");
        expect(storage.inspect().stage).toBe(STAGE.ListingReset);
    });

    it("preserves permanent daily history while expiring orders during uninterrupted operation", async () => {
        await recover();
        await listing(NOW - 100);
        const before = db.prepare("SELECT * FROM activities").all();
        order("expired", NOW - 1);
        storage.maintainBatch(NOW + 365 * POLICY.utcDaySeconds);
        expect(db.prepare("SELECT * FROM activities").all()).toEqual(before);
        expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({
            n: 0,
        });
    });

    async function listing(at: number, tokenId = "1", now = NOW) {
        await new SqliteActivityDomain(
            ["0x0000000000000000000000000000000000000000"],
            () => now,
        ).handleActivityUpsert({
            chainId: 1,
            collectionId: 99,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            kind: ACTIVITY_KIND.ListingCreated,
            contract: "0xcollection",
            tokenId,
            occurredAt: at,
            sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
            sourceName: "fixture",
            sourceEventKey: `event-${at}`,
            orderId: `order-${at}`,
            maker: "maker",
        });
    }

    it("rolls a failed table swap back together with its recovery cursor", async () => {
        activity(1, ACTIVITY_KIND.BidCreated, ACTIVITY_SOURCE_KIND.Offchain);
        storage.recoverBatch(NOW);
        storage.recoverBatch(NOW);
        db.raw.exec(
            `CREATE TRIGGER fail_recovery_swap BEFORE UPDATE ON market_data_recovery WHEN NEW.stage='${STAGE.Orders}' BEGIN SELECT RAISE(ABORT,'injected cutover failure'); END`,
        );
        expect(() => storage.recoverBatch(NOW)).toThrow(
            "injected cutover failure",
        );
        expect(storage.inspect()).toMatchObject({
            stage: STAGE.Activities,
            cursor: 1,
        });
        expect(db.prepare("SELECT id FROM activities").all()).toEqual([
            { id: 1 },
        ]);
        db.raw.exec("DROP TRIGGER fail_recovery_swap");
        await recover();
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM activities").get(),
        ).toEqual({ n: 0 });
    });

    it("refuses an under-resourced batch without advancing or mutating protected data", () => {
        activity(1, ACTIVITY_KIND.Sale, ACTIVITY_SOURCE_KIND.Onchain);
        const constrained = new SqliteMarketDataMaintenance(
            db,
            () => POLICY.recoveryMinFreeBytes - 1,
        );
        expect(() => constrained.recoverBatch(NOW)).toThrow("disk space");
        expect(constrained.inspect()).toMatchObject({
            stage: STAGE.ListingReset,
            cursor: 0,
        });
        expect(db.prepare("SELECT id FROM activities").all()).toEqual([
            { id: 1 },
        ]);
    });

    it("allows a recovery batch at the free-space floor", () => {
        const atFloor = new SqliteMarketDataMaintenance(
            db,
            () => POLICY.recoveryMinFreeBytes,
        );
        expect(() => atFloor.recoverBatch(NOW)).not.toThrow();
    });

    it("reports a pinned WAL snapshot and requires that reader to close before startup succeeds", async () => {
        await recover();
        const Database = db.raw.constructor as new (
            path: string,
        ) => typeof db.raw;
        const reader = new Database(path);
        db.raw.pragma("busy_timeout=1");
        try {
            reader.exec("BEGIN");
            reader.prepare("SELECT COUNT(*) FROM activities").get();
            activity(1, ACTIVITY_KIND.Sale, ACTIVITY_SOURCE_KIND.Onchain);
            expect((await storage.observeWal()).walBytes).toBeGreaterThan(0);
            await expect(recover()).rejects.toThrow("checkpoint");
            reader.exec("ROLLBACK");
            await recover();
            expect((await storage.observeWal()).walBytes).toBe(0);
        } finally {
            reader.close();
        }
    });

    it("preserves artifacts and synthetic retirement records through startup and runtime order cleanup", async () => {
        db.raw.exec(
            "INSERT INTO tokens(chain_id,collection_id,contract_address,token_id) VALUES (1,99,'0xcollection','1');" +
                "INSERT INTO token_extension_artifacts(chain_id,collection_id,contract_address,token_id,extension_key,artifact_ref,html_content) VALUES (1,99,'0xcollection','1','fixture','forever','exact artifact bytes');" +
                "INSERT INTO collection_extension_synthetic_token_retirements(chain_id,collection_id,contract_address,token_id,extension_key) VALUES (1,99,'0xcollection','fixture-unminted-1','fixture');",
        );
        const selectArtifacts = db.prepare(
            "SELECT * FROM token_extension_artifacts",
        );
        const selectRetirements = db.prepare(
            "SELECT * FROM collection_extension_synthetic_token_retirements",
        );
        const artifacts = selectArtifacts.all();
        const retirements = selectRetirements.all();
        order("expired", NOW - 1);
        db.raw.exec("UPDATE orders SET token_id='1'");
        await recover();
        expect(db.prepare("SELECT id FROM orders").all()).toEqual([]);
        expect(selectArtifacts.all()).toEqual(artifacts);
        expect(selectRetirements.all()).toEqual(retirements);
        order("later-expired", NOW - 1);
        db.raw.exec("UPDATE orders SET token_id='1'");
        storage.maintainBatch(NOW);
        expect(db.prepare("SELECT id FROM orders").all()).toEqual([]);
        expect(selectArtifacts.all()).toEqual(artifacts);
        expect(selectRetirements.all()).toEqual(retirements);
    });

    it("does not rewrite a database for a small amount of reclaimable space", async () => {
        await recover();
        db.raw.exec(
            "CREATE TABLE compaction_fixture (payload BLOB);" +
                "INSERT INTO compaction_fixture VALUES (zeroblob(1048576));" +
                "DROP TABLE compaction_fixture;",
        );
        const reclaimable =
            Number(db.raw.pragma("freelist_count", { simple: true })) *
            Number(db.raw.pragma("page_size", { simple: true }));
        expect(reclaimable).toBeGreaterThan(0);
        expect(reclaimable).toBeLessThan(POLICY.compactionMinReclaimBytes);
        const exec = vi.spyOn(db.raw, "exec");
        try {
            expect(new CompactMarketData(storage).execute()).toMatchObject({
                compacted: false,
                reason: MARKET_DATA_COMPACTION_SKIP_REASON.LittleReclaimableSpace,
                reclaimedBytes: 0,
            });
            expect(exec).not.toHaveBeenCalledWith("VACUUM");
            expect(
                db
                    .prepare("SELECT attempted FROM market_data_compaction")
                    .get(),
            ).toEqual({ attempted: 0 });
        } finally {
            exec.mockRestore();
        }
    });

    it("does not retry an interrupted automatic compaction on every launch", async () => {
        await recover();
        db.raw.exec("UPDATE market_data_compaction SET attempted=1");
        expect(new CompactMarketData(storage).execute()).toMatchObject({
            compacted: false,
            reason: MARKET_DATA_COMPACTION_SKIP_REASON.AlreadyAttempted,
            reclaimedBytes: 0,
        });
    });

    it("keeps every active day's row over a year of spam and does not invent rows on idle days", async () => {
        await recover();
        for (let day = 0; day < 400; day++) {
            const at = NOW + day * POLICY.utcDaySeconds;
            await listing(at, "1", at + 100);
            await listing(at + 10, "1", at + 100);
            storage.maintainBatch(at + 100);
        }
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM activities").get(),
        ).toEqual({ n: 400 });
        const before = db
            .prepare("SELECT id,occurred_at FROM activities ORDER BY id")
            .all();
        storage.maintainBatch(NOW + 800 * POLICY.utcDaySeconds);
        await recover();
        expect(
            db
                .prepare("SELECT id,occurred_at FROM activities ORDER BY id")
                .all(),
        ).toEqual(before);
    });

    it("preserves new-model daily identities and timestamps through a later shadow rebuild", async () => {
        await recover();
        for (let i = 0; i <= POLICY.maintenanceBatchRows; i++)
            await listing(NOW - 10, String(i));
        const before = db.prepare("SELECT * FROM activities ORDER BY id").all();
        db.prepare(
            "UPDATE market_data_recovery SET stage=?,cursor=0 WHERE singleton=1",
        ).run(STAGE.Activities);
        storage.recoverBatch(NOW);
        expect(storage.inspect().cursor).toBe(POLICY.maintenanceBatchRows);
        setDbPath(path);
        storage = new SqliteMarketDataMaintenance(db);
        await recover();
        expect(
            db.prepare("SELECT * FROM activities ORDER BY id").all(),
        ).toEqual(before);
        await listing(NOW, "0");
        expect(
            db.prepare("SELECT * FROM activities ORDER BY id").all(),
        ).toEqual(before);
        expect(db.raw.pragma("quick_check", { simple: true })).toBe("ok");
    });

    it("discards an interrupted legacy shadow before resetting listing history, without losing current orders", async () => {
        db.raw.exec(
            "CREATE TABLE market_rebuild_activities AS SELECT * FROM activities; CREATE TABLE market_rebuild_orders AS SELECT * FROM orders",
        );
        db.raw.transaction(() => {
            for (let id = 1; id <= POLICY.maintenanceBatchRows + 1; id++)
                activity(
                    id,
                    ACTIVITY_KIND.ListingCreated,
                    ACTIVITY_SOURCE_KIND.Offchain,
                );
            for (let id = 0; id < 1_001; id++) order(`live-${id}`, NOW + 3600);
        })();
        db.raw.exec(
            "INSERT INTO market_rebuild_activities SELECT * FROM activities",
        );
        storage.recoverBatch(NOW);
        expect(storage.inspect()).toMatchObject({
            stage: STAGE.Activities,
            cursor: 0,
        });
        expect(
            db
                .prepare(
                    "SELECT name FROM sqlite_schema WHERE name LIKE 'market_rebuild_%'",
                )
                .all(),
        ).toEqual([]);
        await recover();
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM activities").get(),
        ).toEqual({ n: 0 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({
            n: 1_001,
        });
    });
});

describe("order retention semantics", () => {
    const base = {
        validUntil: NOW + 1000,
        sourceStatus: ORDER_SOURCE_STATUS.Active,
        fillabilityStatus: ORDER_STATUS.NoApproval,
        lastObservedAt: NOW - 10000,
        lastChangedAt: NOW - 10000,
    };
    it("retains recoverable approval failures but expires by the canonical deadline", () => {
        expect(orderRetirementReason(base, NOW)).toBeNull();
        expect(orderRetirementReason({ ...base, validUntil: NOW }, NOW)).toBe(
            ORDER_RETIREMENT_REASON.Expired,
        );
    });
    it("gives terminal and inactive evidence a grace period", () => {
        expect(
            orderRetirementReason(
                {
                    ...base,
                    fillabilityStatus: ORDER_STATUS.Cancelled,
                    lastChangedAt: NOW,
                },
                NOW,
            ),
        ).toBeNull();
        expect(
            orderRetirementReason(
                { ...base, fillabilityStatus: ORDER_STATUS.Cancelled },
                NOW,
            ),
        ).toBe(ORDER_RETIREMENT_REASON.Terminal);
        expect(
            orderRetirementReason(
                { ...base, sourceStatus: ORDER_SOURCE_STATUS.Inactive },
                NOW,
            ),
        ).toBe(ORDER_RETIREMENT_REASON.Stale);
    });
});
