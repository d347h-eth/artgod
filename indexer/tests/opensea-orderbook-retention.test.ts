import {
    buildCollectionSchema,
    generateMerkleRoot,
} from "../src/application/token-sets/utils.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { commitRollbackFixture } from "./helpers/rollback-fixture.js";
import { ORDER_STATUS } from "@artgod/shared/market-data/orders";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { zeroAddress } from "viem";
import Database from "better-sqlite3";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { getSettingDefault } from "@artgod/shared/config/generated-settings-defaults";
import {
    ORDERBOOK_VENUE,
    ORDER_SIDE,
    ORDER_SOURCE_SCOPE_KIND,
} from "@artgod/shared/market-data/orders";
import { SqliteCurrentAsks } from "@artgod/shared/database/current-asks";
import { SqliteOrderSourceStateStore } from "../src/infra/offchain/sqlite-order-source-state.js";
import {
    BOOK_VIEW,
    BOOK_CHANGE,
    type BookFeed,
    type BookObservation,
    type BookCoverage,
} from "../src/domain/orderbook.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("publishing a scoped orderbook", () => {
    loadTestEnv();
    const weth = getSettingDefault("WETH_ADDRESS");
    const os: BookFeed = {
        chainId: 1,
        contract: "0xcollection",
        venue: ORDERBOOK_VENUE.OpenSea,
        reference: "fixture",
        view: BOOK_VIEW.Public,
    };
    const vvv: BookFeed = { ...os, venue: ORDERBOOK_VENUE.Vvv };
    let now: number,
        store: SqliteOrderSourceStateStore,
        asks: SqliteCurrentAsks,
        database: string;
    const seller = "maker";
    function ask(
        feed: BookFeed,
        id: string,
        price: string,
        options: Partial<BookObservation> = {},
    ): BookObservation {
        return {
            nativeId: id,
            placement: feed,
            settlementId: id,
            status: "active",
            fillable: true,
            audience: null,
            sourceTime: 1,
            fees: null,
            proceeds: null,
            order: {
                orderId: id,
                kind: "seaport",
                side: ORDER_SIDE.Sell,
                maker: seller,
                contract: feed.contract,
                tokenId: "0",
                sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
                price,
                currency: zeroAddress,
            },
            ...options,
        };
    }
    function publish(
        feed: BookFeed,
        records: BookObservation[],
        coverage: BookCoverage = { kind: "snapshot" },
    ) {
        const run = store.begin(feed, coverage, ++now);
        try {
            for (const record of records) run.record(record);
            return run.publish();
        } finally {
            run.close();
        }
    }
    function best() {
        return asks.forSeller(1, 99, "0", seller, Math.floor(now / 1000))
            ?.price;
    }
    const changes = (generation: number) =>
        db
            .prepare(
                "SELECT native_id,change FROM orderbook_changes WHERE generation=? ORDER BY native_id",
            )
            .all(generation);
    beforeEach(async () => {
        database = await createTempDbPath();
        setDbPath(database);
        await createMigrationRunner().runMigrations();
        now = 1_800_000_000_000;
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind,opensea_slug,opensea_status) VALUES (99,1,'fixture',?,'erc721','live','contract_all_tokens',?,'ready')",
        ).run(os.contract, os.reference);
        store = new SqliteOrderSourceStateStore(weth, () => now);
        asks = new SqliteCurrentAsks(db.raw, [zeroAddress, weth]);
        store.bind(os, 99);
        store.bind(vvv, 99);
    });
    afterEach(() => db.raw.close());

    it("retains a cheaper ask at its accepted time on failure and switches on a valid empty read", () => {
        publish(vvv, [ask(vvv, "a", "80")]);
        const accepted = now;
        publish(os, [ask(os, "b", "100")]);
        const failed = store.begin(vvv, { kind: "snapshot" }, ++now);
        failed.record(ask(vvv, "x", "1"));
        failed.fail("failed last page");
        expect(best()).toBe("80");
        expect(
            db
                .prepare(
                    "SELECT last_success_ms,last_error FROM orderbook_feeds WHERE venue=?",
                )
                .get(vvv.venue),
        ).toEqual({
            last_success_ms: accepted,
            last_error: "failed last page",
        });
        publish(vvv, []);
        expect(best()).toBe("100");
        publish(vvv, [ask(vvv, "a", "80")]);
        expect(best()).toBe("80");
    });

    it("compares membership and availability at equal sizes and source times", () => {
        publish(vvv, [ask(vvv, "a", "1"), ask(vvv, "b", "2")]);
        publish(vvv, [
            ask(vvv, "b", "2", { fillable: false }),
            ask(vvv, "c", "3"),
        ]);
        expect(changes(2)).toEqual([
            { native_id: "a", change: BOOK_CHANGE.Removal },
            { native_id: "b", change: BOOK_CHANGE.Change },
            { native_id: "c", change: BOOK_CHANGE.Addition },
        ]);
        expect(best()).toBe("3");
        publish(vvv, [
            ask(vvv, "b", "2", { fillable: false }),
            ask(vvv, "c", "3", { sourceTime: 5 }),
        ]);
        expect(changes(3)).toEqual([]);
    });

    it("keeps independent placements and suppresses a stale relay after authoritative withdrawal", () => {
        publish(vvv, [ask(vvv, "signed", "80")]);
        publish(os, [ask(vvv, "signed", "80")]);
        expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({
            n: 1,
        });
        publish(vvv, []);
        publish(os, [ask(vvv, "signed", "80")]);
        expect(best()).toBeUndefined();
        publish(os, [ask(os, "signed", "100")]);
        expect(best()).toBe("100");
    });

    it("treats search, fixed windows and sequence gaps according to their coverage", () => {
        const scoped = (view: string) => {
            const feed = { ...vvv, view };
            store.bind(feed, 99);
            return feed;
        };
        const window = scoped("top-one"),
            search = scoped("search"),
            seq = scoped("events");
        publish(vvv, [ask(vvv, "shared", "80")]);
        publish(window, [ask(vvv, "shared", "80")], { kind: "window" });
        publish(window, [], { kind: "window" });
        expect(best()).toBe("80");
        publish(search, [ask(vvv, "match", "50")], { kind: "sighting" });
        publish(search, [], { kind: "sighting" });
        expect(best()).toBe("50");
        publish(seq, [], { kind: "sequence", position: 3, baseline: true });
        expect(() =>
            publish(seq, [ask(vvv, "event", "40")], {
                kind: "sequence",
                position: 5,
            }),
        ).toThrow("sequence gap");
        expect(best()).toBe("50");
        publish(seq, [ask(vvv, "event", "40")], {
            kind: "sequence",
            position: 4,
        });
        publish(seq, [ask(vvv, "event", "10")], {
            kind: "sequence",
            position: 4,
        });
        expect(best()).toBe("40");
        // Replay the held position after its predecessor, then resume from
        // an authoritative baseline when the missing events are unavailable.
        publish(seq, [ask(vvv, "event", "30")], {
            kind: "sequence",
            position: 5,
        });
        expect(best()).toBe("30");
        publish(seq, [], { kind: "sequence", position: 10, baseline: true });
        expect(best()).toBe("50");
    });

    it("protects a newer stream observation while a REST traversal is staged", () => {
        const stream = { ...os, view: BOOK_VIEW.Stream };
        store.bind(stream, 99);
        publish(os, [ask(os, "old", "50")]);
        const read = store.begin(os, { kind: "snapshot" }, ++now);
        publish(stream, [ask(os, "during", "10")], { kind: "sighting" });
        read.publish();
        expect(best()).toBe("10");
        publish(os, []);
        expect(best()).toBeUndefined();
        expect(store.acceptsStream(stream, now - 1)).toBe(false);
    });

    it("rejects an interrupted, overtaken or rebound staging run", () => {
        const interrupted = store.begin(vvv);
        interrupted.record(ask(vvv, "lost", "1"));
        interrupted.close();
        const late = store.begin(vvv);
        late.record(ask(vvv, "late", "2"));
        publish(vvv, [ask(vvv, "live", "3")]);
        expect(() => late.publish()).toThrow("generation or binding");
        late.close();
        const purged = store.begin(vvv);
        purged.record(ask(vvv, "purged", "1"));
        db.prepare("DELETE FROM collections WHERE collection_id=99").run();
        expect(() => purged.publish()).toThrow("binding");
        purged.close();
        expect(store.hasBindings(vvv.venue, 1)).toBe(false);
    });

    it("routes one read over two local ranges and drops a detached binding without changing another collection", () => {
        db.exec(
            "UPDATE collections SET token_scope_kind='token_range',scope_start_token_id='0',scope_total_supply=500 WHERE collection_id=99",
        );
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind,scope_start_token_id,scope_total_supply,opensea_slug,opensea_status) VALUES(100,1,'high',?,'erc721','live','token_range','500',500,?,'ready')",
        ).run(os.contract, os.reference);
        store.bind(vvv, 100);
        store.bind(os, 100);
        const other: BookFeed = {
            ...vvv,
            reference: "other",
            contract: "0xother",
        };
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind) VALUES(101,1,'other',?,'erc721','live','contract_all_tokens')",
        ).run(other.contract);
        store.bind(other, 101);
        expect(store.due(vvv.venue, 1, now)).toHaveLength(2);
        const top = ask(vvv, "high", "90");
        top.order!.tokenId = "700";
        publish(other, [ask(other, "unrelated", "5")]);
        publish(vvv, [top, ask(vvv, "low", "80")]);
        expect(
            db.prepare("SELECT id,collection_id FROM orders ORDER BY id").all(),
        ).toEqual([
            { id: "high", collection_id: 100 },
            { id: "low", collection_id: 99 },
            { id: "unrelated", collection_id: 101 },
        ]);
        const scopedRead = store.begin(vvv);
        db.prepare(
            "UPDATE collections SET scope_start_token_id='1' WHERE collection_id=99",
        ).run();
        expect(best()).toBeUndefined();
        expect(
            asks.forSeller(1, 100, "700", seller, Math.floor(now / 1000))
                ?.price,
        ).toBe("90");
        expect(() => scopedRead.publish()).toThrow("binding");
        scopedRead.close();
        const inFlight = store.begin(vvv);
        store.unbind(vvv, 100);
        expect(() => inFlight.publish()).toThrow("binding");
        inFlight.close();
        expect(
            db
                .prepare(
                    "SELECT id FROM orders WHERE source_status='active' ORDER BY id",
                )
                .all(),
        ).toEqual([{ id: "low" }, { id: "unrelated" }]);
    });

    it("links a single contract-wide bid to both bound ranges and preserves the surviving scope", () => {
        db.exec(
            "UPDATE collections SET token_scope_kind='token_range',scope_start_token_id='0',scope_total_supply=500 WHERE collection_id=99",
        );
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind,scope_start_token_id,scope_total_supply,opensea_slug,opensea_status) VALUES(100,1,'upper',?,'erc721','live','token_range','500',500,?,'ready')",
        ).run(os.contract, os.reference);
        store.bind(os, 100);
        const token = db.prepare(
            "INSERT INTO nft_balances(chain_id,collection_id,contract_address,token_id,owner,amount,last_block_number,last_block_hash,last_block_timestamp,last_tx_hash,last_log_index) VALUES(1,?,?,?,'holder','1',1,'block',1,'tx',0)",
        );
        token.run(99, os.contract, "1");
        token.run(100, os.contract, "700");
        const broad = (id: string, root: string) => {
            const record = ask(os, id, "100", { proceeds: "95", fees: "5" });
            record.order = {
                ...record.order!,
                side: ORDER_SIDE.Buy,
                tokenId: null,
                currency: weth,
                sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Collection,
                sourceSchema: buildCollectionSchema(os.contract),
                sourceCriteriaRoot: root,
            };
            return record;
        };
        publish(os, [
            broad("wildcard", "0x0"),
            broad("criterion", generateMerkleRoot(["700"])),
        ]);
        expect(
            db
                .prepare(
                    "SELECT native_id,collection_id FROM orderbook_offer_scopes ORDER BY native_id,collection_id",
                )
                .all(),
        ).toEqual([
            { native_id: "criterion", collection_id: 100 },
            { native_id: "wildcard", collection_id: 99 },
            { native_id: "wildcard", collection_id: 100 },
        ]);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM orders WHERE source_status='active'",
                )
                .get(),
        ).toEqual({ n: 2 });
        // A job in the upper range controls the same OpenSea publication.
        publish(os, [
            broad("wildcard", "0x0"),
            broad("criterion", generateMerkleRoot(["700"])),
            broad("controlled", "0x0"),
        ]);
        db.exec(
            "INSERT INTO trading_jobs(job_id,bot_kind,chain_id,collection_id,status,target_kind) VALUES('upper-bot','bidding',1,100,'paused','collection')",
        );
        db.prepare(
            "INSERT INTO trading_bidding_order_cancellations(order_id,job_id,chain_id,collection_id,maker,requested_at,completed_at) VALUES('controlled','upper-bot',1,100,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
        ).run(seller);
        expect(
            db
                .prepare(
                    "SELECT source_status FROM orders WHERE id='controlled'",
                )
                .get(),
        ).toEqual({ source_status: "inactive" });
        store.unbind(os, 99);
        expect(
            db
                .prepare(
                    "SELECT id,collection_id,source_status FROM orders WHERE source_status='active' ORDER BY id",
                )
                .all(),
        ).toEqual([
            { id: "criterion", collection_id: 100, source_status: "active" },
            { id: "wildcard", collection_id: 100, source_status: "active" },
        ]);
    });

    it("applies a completed OpenSea cancellation to its controlled placement immediately", () => {
        function bid(feed: BookFeed, net: string) {
            const record = ask(feed, "same-hash", "100");
            Object.assign(record.order!, {
                side: ORDER_SIDE.Buy,
                currency: weth,
            });
            record.proceeds = net;
            record.fees = (100n - BigInt(net)).toString();
            record.nativeId = feed.venue + "-native";
            return record;
        }
        publish(os, [bid(os, "98")]);
        publish(vvv, [bid(vvv, "95")]);
        const visible = () =>
            db
                .prepare(
                    "SELECT source,seller_proceeds,winning_native_id FROM orders WHERE source_status='active'",
                )
                .all();
        expect(visible()).toEqual([
            {
                source: os.venue,
                seller_proceeds: "98",
                winning_native_id: os.venue + "-native",
            },
        ]);
        db.exec(
            "INSERT INTO trading_jobs(job_id,bot_kind,chain_id,collection_id,status,target_kind) VALUES('bot','bidding',1,99,'paused','collection')",
        );
        db.prepare(
            "INSERT INTO trading_bidding_order_cancellations(order_id,job_id,chain_id,collection_id,maker,requested_at) VALUES('same-hash','bot',1,99,?,CURRENT_TIMESTAMP)",
        ).run(seller);
        expect(visible()).toEqual([
            {
                source: os.venue,
                seller_proceeds: "98",
                winning_native_id: os.venue + "-native",
            },
        ]);
        db.exec(
            "UPDATE trading_bidding_order_cancellations SET completed_at=CURRENT_TIMESTAMP",
        );
        expect(visible()).toEqual([
            {
                source: vvv.venue,
                seller_proceeds: "95",
                winning_native_id: vvv.venue + "-native",
            },
        ]);
        publish(os, [bid(os, "98")]);
        expect(visible()).toEqual([
            {
                source: vvv.venue,
                seller_proceeds: "95",
                winning_native_id: vvv.venue + "-native",
            },
        ]);
    });

    it("invalidates orphaned cancellation and partial-fill proofs and keeps both venue placements", () => {
        publish(vvv, [ask(vvv, "signed", "80")]);
        publish(os, [ask(os, "signed", "80")]);
        db.prepare(
            "UPDATE orders SET block_number=12,remaining_quantity='2',fillability_status=? WHERE id='signed'",
        ).run(ORDER_STATUS.Cancelled);
        commitRollbackFixture({
            storage: new SqliteStorage(),
            chainId: 1,
            fromBlock: 12,
            owners: [],
        });
        expect(
            db
                .prepare(
                    "SELECT remaining_quantity,fillability_status,source_status FROM orders WHERE id='signed'",
                )
                .get(),
        ).toEqual({
            remaining_quantity: null,
            fillability_status: ORDER_STATUS.Invalid,
            source_status: "active",
        });
        expect(
            db
                .prepare(
                    "SELECT pending,minimum_block FROM order_validation_demand WHERE order_id='signed'",
                )
                .get(),
        ).toEqual({ pending: 1, minimum_block: null });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM orderbook_members WHERE settlement_id='signed' AND present=1",
                )
                .get(),
        ).toEqual({ n: 2 });
    });

    it("keeps another reader on the preceding generation and rolls back the price with the book", () => {
        publish(vvv, [ask(vvv, "old", "80")]);
        const reader = new Database(database, { readonly: true });
        try {
            reader.exec("BEGIN");
            const current = reader.prepare(
                "SELECT id FROM orders WHERE source_status='active' ORDER BY id",
            );
            expect(current.all()).toEqual([{ id: "old" }]);
            const staged = store.begin(vvv);
            staged.record(ask(vvv, "new", "90"));
            // Cross the production comparison batch boundary within one publication.
            for (let i = 0; i < 501; i++)
                staged.record(ask(vvv, "more-" + i, "100"));
            expect(best()).toBe("80");
            db.exec(
                "CREATE TEMP TRIGGER fail_book BEFORE UPDATE OF last_success_ms ON orderbook_feeds BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
            );
            expect(() => staged.publish()).toThrow("fixture failure");
            expect(best()).toBe("80");
            db.exec("DROP TRIGGER fail_book");
            staged.publish();
            expect(best()).toBe("90");
            expect(current.all()).toEqual([{ id: "old" }]);
            reader.exec("COMMIT");
            expect(current.all()).toHaveLength(502);
            expect(current.all()).toContainEqual({ id: "new" });
        } finally {
            reader.close();
        }
    });
});
