import { BOOK_VIEW, type BookObservation } from "../src/domain/orderbook.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    SqliteActivitiesReadModel,
    SqliteCollectionsReadModel,
} from "@artgod/shared/read-models";
import {
    ACTIVITY_KIND,
    ACTIVITY_SOURCE_KIND,
    ACTIVITY_SCOPE_KIND,
    ACTIVITY_FEED_FILTER_KIND,
    LISTING_HISTORY_POLICY,
} from "@artgod/shared/types";
import { TOKEN_BROWSER_STATUS } from "@artgod/shared/types/browse";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import { currentAskIdSql } from "@artgod/shared/database/current-asks";
import { SqliteDailyListingPrices } from "../src/infra/storage/sqlite-daily-listing-prices.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteActivityDomain } from "../src/infra/domain/activities.js";
import { SqliteMarketDataMaintenance } from "../src/infra/storage/sqlite-market-data-maintenance.js";
import { MaintainMarketData } from "../src/application/storage/maintain-market-data.js";
import { ORDER_STATUS, ORDER_SOURCE_STATUS } from "../src/domain/orders.js";
import { SqliteOrderSourceStateStore } from "../src/infra/offchain/sqlite-order-source-state.js";
import { OFFCHAIN_ORDER_SOURCE } from "../src/domain/offchain-jobs.js";

const ETH = "0x0000000000000000000000000000000000000000";
const WETH = "0x0000000000000000000000000000000000000001";
const SELLER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const CONTRACT = "0x3333333333333333333333333333333333333333";
const FIRST = 1_800_057_610; // Ten seconds after a UTC day boundary.

describe("permanent daily listings and current asks", () => {
    loadTestEnv();
    let now: number;
    let storage: SqliteMarketDataMaintenance;
    let feed: SqliteActivitiesReadModel;
    let domain: SqliteActivityDomain;
    let prices: SqliteDailyListingPrices;
    let orders: SqliteOrdersDomain;
    beforeEach(async () => {
        now = FIRST + 100;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(now * 1000);
        const path = await createTempDbPath();
        setDbPath(path);
        await createMigrationRunner().runMigrations();
        storage = new SqliteMarketDataMaintenance(db);
        await new MaintainMarketData(storage, {
            nowSeconds: () => now,
        }).recover();
        db.exec("DELETE FROM collections");
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind) VALUES (1,1,'daily',?,'erc721','live','contract_all_tokens')",
        ).run(CONTRACT);
        db.prepare(
            "INSERT INTO tokens(chain_id,collection_id,contract_address,token_id) VALUES (1,1,?,'1'),(1,1,?,'2')",
        ).run(CONTRACT, CONTRACT);
        domain = new SqliteActivityDomain([ETH, WETH], () => now);
        feed = new SqliteActivitiesReadModel();
        prices = new SqliteDailyListingPrices(db, [ETH, WETH]);
        orders = new SqliteOrdersDomain(
            WETH,
            async () => ({ status: ORDER_STATUS.Fillable, reason: "fixture" }),
            undefined,
            () => now,
        );
    });
    afterEach(() => {
        vi.restoreAllMocks();
        db.raw.close();
        vi.useRealTimers();
    });

    function order(
        id: string,
        price: string,
        options: {
            maker?: string;
            token?: string;
            until?: number;
            from?: number;
            currency?: string;
        } = {},
    ) {
        db.prepare(
            "INSERT INTO orders(id,chain_id,collection_id,kind,maker,contract_address,token_id,source_scope_kind,side,price,currency,quantity,fillability_status,source_status,valid_from,valid_until) VALUES (?,1,1,'seaport',?, ?,?,'token','sell',?,?,'1',?,?,?,?)",
        ).run(
            id,
            options.maker ?? SELLER,
            CONTRACT,
            options.token ?? "1",
            price,
            options.currency ?? ETH,
            ORDER_STATUS.Fillable,
            ORDER_SOURCE_STATUS.Active,
            options.from ?? FIRST - 100,
            options.until ?? now + 3600,
        );
    }
    const list = () =>
        feed.listCollectionActivities({
            chainId: 1,
            collectionId: 1,
            kind: ACTIVITY_FEED_FILTER_KIND.Listings,
            limit: 100,
        });
    const event = (
        id: string,
        at = FIRST,
        maker = SELLER,
        token = "1",
        currency = ETH,
        price = "999999",
    ) =>
        domain.handleActivityUpsert({
            chainId: 1,
            collectionId: 1,
            scopeKind: ACTIVITY_SCOPE_KIND.Token,
            kind: ACTIVITY_KIND.ListingCreated,
            contract: CONTRACT,
            tokenId: token,
            maker,
            side: "sell",
            orderId: id,
            occurredAt: at,
            sourceKind: ACTIVITY_SOURCE_KIND.Offchain,
            sourceName: "opensea",
            sourceEventKey: id,
            price,
            currency,
        });

    it("stores one row per seller/token/day, not per order or currency; duplicates are no-op writes", async () => {
        order("stable", "20");
        await event("a");
        await event("b", FIRST + 10, SELLER, "1", WETH);
        await event("c", FIRST + 20, OTHER);
        await event("d", FIRST + 30, SELLER, "2");
        const before = db.raw.prepare("SELECT total_changes() AS n").get();
        for (let i = 0; i < 1_000; i++) await event(`spam-${i}`, FIRST + 50);
        expect(db.raw.prepare("SELECT total_changes() AS n").get()).toEqual(
            before,
        );
        expect(list().items).toHaveLength(3);
        expect(
            list().items.find((r) => r.tokenId === "1" && r.maker === SELLER)
                ?.occurredAt,
        ).toBe(FIRST);
        expect(list().listingHistory).toEqual(LISTING_HISTORY_POLICY);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM activities WHERE price IS NULL OR payload_json IS NOT NULL",
                )
                .get(),
        ).toEqual({ n: 0 });
    });

    it("uses the current best seller ask, not the first price, last event or cheapest other seller", async () => {
        order("old", "100");
        order("cheaper", "20", { currency: WETH });
        order("other", "1", { maker: OTHER });
        await event("old");
        await event("other", FIRST + 10, OTHER);
        const first = list().items.find((r) => r.maker === SELLER)!;
        expect(first).toMatchObject({
            occurredAt: FIRST,
            price: "20",
            currency: WETH,
            orderId: "cheaper",
        });
        await orders.handleOrderUpdateById({
            chainId: 1,
            collectionId: 1,
            orderId: "cheaper",
            reason: "cancel",
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
            observedAt: now,
        });
        expect(list().items.find((r) => r.maker === SELLER)).toMatchObject({
            id: first.id,
            occurredAt: FIRST,
            price: "100",
            orderId: "old",
        });
        db.prepare("UPDATE orders SET fillability_status=? WHERE id='old'").run(
            ORDER_STATUS.NoApproval,
        );
        prices.refreshSeller(
            { chain_id: 1, collection_id: 1, token_id: "1", maker: SELLER },
            now,
        );
        expect(list().items.find((r) => r.maker === SELLER)).toMatchObject({
            id: first.id,
            occurredAt: FIRST,
            price: "100",
            currency: ETH,
            orderId: "old",
        });
        db.prepare("UPDATE orders SET fillability_status=? WHERE id='old'").run(
            ORDER_STATUS.Fillable,
        );
        expect(list().items.find((r) => r.maker === SELLER)?.price).toBe("100");
    });

    it("re-reads prices after a reconciliation committed before the maintenance writer lock", async () => {
        order("cheap", "10");
        order("remaining", "20");
        await event("cheap");
        const write = db.writeTransaction.bind(db);
        vi.spyOn(db, "writeTransaction").mockImplementationOnce((operation) => {
            // An independent reconcile can commit after candidate selection.
            // Both observations deliberately have the same timestamp.
            write(() => {
                db.prepare(
                    "UPDATE orders SET source_status=? WHERE id='cheap'",
                ).run(ORDER_SOURCE_STATUS.Inactive);
                prices.refreshSeller(
                    {
                        chain_id: 1,
                        collection_id: 1,
                        token_id: "1",
                        maker: SELLER,
                    },
                    now,
                );
            })();
            expect(list().items[0]?.price).toBe("20");
            return write(operation);
        });
        prices.refreshBatch(now);
        expect(list().items[0]?.price).toBe("20");
    });

    it("holds the writer lock while reading best asks and retries the complete price batch", async () => {
        order("ask", "10");
        await event("ask");
        db.prepare("UPDATE orders SET price='20' WHERE id='ask'").run();
        const competitor = new Database(db.raw.name, { timeout: 0 });
        const best = prices.bestAsk.bind(prices);
        const read = vi
            .spyOn(prices, "bestAsk")
            .mockImplementation((seller, at) => {
                expect(db.raw.inTransaction).toBe(true);
                expect(() =>
                    competitor
                        .prepare("UPDATE orders SET price='30' WHERE id='ask'")
                        .run(),
                ).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
                return best(seller, at);
            });
        const record = prices.recordPrice.bind(prices);
        const writes = vi
            .spyOn(prices, "recordPrice")
            .mockImplementationOnce((observation) => {
                record(observation);
                // Deliberately inject the driver's error vocabulary after a write.
                throw new Database.SqliteError("fixture busy", "SQLITE_BUSY");
            });
        try {
            prices.refreshBatch(now);
            expect(writes).toHaveBeenCalledTimes(2);
            expect(read).toHaveBeenCalledTimes(2);
            expect(list().items[0]?.price).toBe("20");
        } finally {
            competitor.close();
        }
    });

    it("excludes expiry at the exact second, future starts, unsupported currencies and invalid prices without waiting for cleanup", async () => {
        order("boundary", "1", { until: now });
        order("future", "2", { from: now + 1 });
        order("unsupported", "3", { currency: "usdc" });
        order("bad", "-1");
        order("best", "0004");
        order("larger", "10");
        await event("best");
        expect(list().items[0]).toMatchObject({
            price: "0004",
            orderId: "best",
        });
        now++;
        prices.refreshBatch(now);
        expect(list().items[0]).toMatchObject({
            price: "2",
            orderId: "future",
        });
    });

    it("keeps rows forever across idle expiry, maintenance, restart and a later relisting", async () => {
        order("gone", "10", { until: now + 1 });
        await event("gone");
        const pinned = list().items[0]!;
        now += 180 * POLICY.utcDaySeconds;
        while (storage.maintainBatch(now)) {
            /* drain finite bounded passes */
        }
        await new MaintainMarketData(storage, {
            nowSeconds: () => now,
        }).recover();
        expect(list().items[0]).toMatchObject({
            id: pinned.id,
            occurredAt: FIRST,
            price: "10",
        });
        expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({
            n: 0,
        });
        order("return", "30");
        expect(list().items).toHaveLength(1); // REST/current orders alone do not invent a new day's event.
        await event("return", now);
        expect(list().items).toHaveLength(2);
        expect(list().items.map((r) => r.price)).toEqual(["30", "10"]);
        expect(list().items[1]).toMatchObject({
            id: pinned.id,
            occurredAt: FIRST,
        });
    });

    it("corrects late earlier events only downward and keeps one daily identity through cancellation/relisting", async () => {
        await event("later", FIRST + 50);
        const id = list().items[0]!.id;
        await event("earlier", FIRST);
        await event("repeat", FIRST + 80);
        expect(list().items).toHaveLength(1);
        expect(list().items[0]).toMatchObject({ id, occurredAt: FIRST });
    });

    it("retains the latest historical observation regardless of delivery order, including unchanged prices", async () => {
        now = FIRST + 2 * POLICY.utcDaySeconds;
        const observations = [
            { at: FIRST, price: "10" },
            { at: FIRST + 10, price: "20" },
            { at: FIRST + 20, price: "10" },
        ];
        for (const sequence of [
            [0, 2, 1],
            [0, 1, 2],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ]) {
            db.prepare("DELETE FROM activities").run();
            for (const index of sequence) {
                const observation = observations[index]!;
                await event(
                    String(index),
                    observation.at,
                    SELLER,
                    "1",
                    ETH,
                    observation.price,
                );
            }
            expect(list().items[0]).toMatchObject({
                occurredAt: FIRST,
                price: "10",
            });
            expect(
                db.prepare("SELECT listing_price_at FROM activities").get(),
            ).toEqual({ listing_price_at: FIRST + 20 });
            const before = db.prepare("SELECT total_changes() AS n").get();
            await event("duplicate", FIRST + 20, SELLER, "1", ETH, "10");
            expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(
                before,
            );
        }
    });

    it("remembers a newer unchanged current-price observation before the day becomes historical", async () => {
        order("unchanged", "10");
        await event("first");
        now += 100;
        prices.refreshOrder(1, "unchanged", now);
        const observedAt = now;
        now += POLICY.utcDaySeconds;
        await event("delayed", observedAt - 1, SELLER, "1", ETH, "20");
        expect(list().items[0]).toMatchObject({
            occurredAt: FIRST,
            price: "10",
        });
        expect(
            db.prepare("SELECT listing_price_at FROM activities").get(),
        ).toEqual({ listing_price_at: observedAt });
    });

    function sellerBook() {
        const feed = {
            chainId: 1,
            venue: OFFCHAIN_ORDER_SOURCE.OpenSea,
            reference: "daily",
            contract: CONTRACT,
            view: BOOK_VIEW.Public,
        };
        db.prepare(
            "UPDATE collections SET opensea_slug=?,opensea_status='ready' WHERE collection_id=1",
        ).run(feed.reference);
        const books = new SqliteOrderSourceStateStore(WETH, () => now * 1000);
        books.bind(feed, 1);
        function listing(id: string, price: string): BookObservation {
            return {
                nativeId: id,
                placement: feed,
                settlementId: id,
                status: ORDER_SOURCE_STATUS.Active,
                fillable: true,
                audience: null,
                sourceTime: null,
                fees: null,
                proceeds: null,
                order: {
                    orderId: id,
                    kind: "seaport",
                    maker: SELLER,
                    contract: CONTRACT,
                    tokenId: "1",
                    sourceScopeKind: "token",
                    side: "sell",
                    price,
                    currency: ETH,
                    quantity: "1",
                },
            };
        }
        return { feed, books, listing };
    }

    it.each(["expiry", "midnight"])(
        "rechecks daily history when publication crosses %s",
        async (boundary) => {
            if (boundary === "midnight") now = FIRST - 11;
            vi.setSystemTime(now * 1000);
            const { feed, books, listing } = sellerBook();
            const soon = listing("soon", "20");
            soon.order!.validUntil = now + 1;
            const survivor = listing("survivor", "30");
            const prior = books.begin(feed);
            for (const item of [listing("cheapest", "10"), soon, survivor])
                prior.record(item);
            prior.publish();
            await event("cheapest", now);
            const pinned = list().items[0]!;
            expect(pinned.price).toBe("10");

            const refresh = SqliteDailyListingPrices.prototype.refreshSeller;
            vi.spyOn(
                SqliteDailyListingPrices.prototype,
                "refreshSeller",
            ).mockImplementationOnce(function (seller, at) {
                refresh.call(this, seller, at);
                now++;
                vi.setSystemTime(now * 1000);
            });
            const replacement = books.begin(feed);
            replacement.record(soon);
            replacement.record(survivor);
            expect(replacement.publish().deactivatedOrders).toBe(1);
            expect(list().items).toMatchObject([
                { id: pinned.id, price: boundary === "midnight" ? "10" : "30" },
            ]);
            expect(
                db.prepare("SELECT generation FROM orderbook_feeds").get(),
            ).toEqual({ generation: 2 });
        },
    );

    it("reaches the last affected seller across a full batch of prices for one token", async () => {
        const { feed, books, listing } = sellerBook();
        const sellerCount = POLICY.maintenanceBatchRows + 1;
        const maker = (index: number) =>
            "0x" + index.toString(16).padStart(40, "0");
        await event("last-seller", now, maker(sellerCount), "1", ETH, "99");
        const book = books.begin(feed);
        for (let i = 1; i <= sellerCount; i++) {
            const record = listing("listing-" + i, "20");
            record.order!.maker = maker(i);
            book.record(record);
        }
        expect(book.publish().activeOrders).toBe(sellerCount);
        expect(list().items).toMatchObject([
            { maker: maker(sellerCount), price: "20" },
        ]);
    });

    it("rolls back the whole publication if a second ask expires during the price retry", async () => {
        const { feed, books, listing } = sellerBook();
        const prior = books.begin(feed);
        prior.record(listing("old", "10"));
        prior.publish();
        await event("old", now);
        const replacement = books.begin(feed);
        for (const [id, price, lifetime] of [
            ["first", "20", 1],
            ["second", "30", 2],
            ["last", "40", 60],
        ] as const) {
            const row = listing(id, price);
            row.order!.validUntil = now + lifetime;
            replacement.record(row);
        }
        const refresh = SqliteDailyListingPrices.prototype.refreshSeller;
        const advancing = vi
            .spyOn(SqliteDailyListingPrices.prototype, "refreshSeller")
            .mockImplementation(function (seller, at) {
                refresh.call(this, seller, at);
                now++;
                vi.setSystemTime(now * 1000);
            });
        expect(() => replacement.publish()).toThrow(
            "Listing price validity changed",
        );
        expect(
            db.prepare("SELECT generation FROM orderbook_feeds").get(),
        ).toEqual({ generation: 1 });
        expect(list().items[0]?.price).toBe("10");
        advancing.mockRestore();
        expect(replacement.publish().deactivatedOrders).toBe(1);
        expect(list().items[0]?.price).toBe("40");
    });

    it("refreshes a seller price when REST marks the cheaper ask absent, before midnight freezes the row", async () => {
        now = FIRST - 10 + POLICY.utcDaySeconds - 1;
        vi.setSystemTime(now * 1000);
        const { feed, books, listing } = sellerBook();
        const prior = books.begin(feed);
        prior.record(listing("cheaper", "10"));
        prior.record(listing("remaining", "20"));
        prior.publish();
        await event("cheaper", now - 500);
        const pinned = list().items[0]!;
        const observation = books.begin(feed);
        observation.record(listing("remaining", "20"));
        expect(observation.publish().deactivatedOrders).toBe(1);
        expect(list().items[0]).toMatchObject({
            id: pinned.id,
            occurredAt: pinned.occurredAt,
            price: "20",
        });
        for (const [cheap, expensive] of [
            ["first", "last"],
            ["last", "first"],
        ] as const) {
            const pair = books.begin(feed);
            pair.record(listing(cheap, "10"));
            pair.record(listing(expensive, "20"));
            pair.publish();
            expect(list().items[0]).toMatchObject({
                id: pinned.id,
                price: "10",
            });
            books.begin(feed).publish();
            expect(list().items[0]).toMatchObject({
                id: pinned.id,
                price: "10",
            });
        }
        const restored = books.begin(feed);
        restored.record(listing("remaining", "20"));
        restored.publish();
        now++;
        prices.refreshBatch(now);
        expect(list().items[0]).toMatchObject({ id: pinned.id, price: "20" });
    });

    it("uses identical daily rows for token, maker-filtered and unfiltered activity APIs", async () => {
        await event("one");
        await event("two", FIRST + 10);
        order("live", "8");
        for (const page of [
            feed.listTokenActivities({
                chainId: 1,
                collectionId: 1,
                tokenId: "1",
                limit: 100,
            }),
            feed.listCollectionActivities({
                chainId: 1,
                collectionId: 1,
                maker: SELLER,
                limit: 100,
            }),
            feed.listCollectionActivities({
                chainId: 1,
                collectionId: 1,
                limit: 100,
            }),
        ])
            expect(page.items).toEqual(list().items);
    });

    it("serves the card grid from current best asks across sellers with the same expiry rules", () => {
        order("seller", "20");
        order("other", "10", { maker: OTHER });
        order("expired", "1", { until: now });
        const cards = new SqliteCollectionsReadModel([ETH, WETH]);
        const page = cards.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: TOKEN_BROWSER_STATUS.Listed,
            limit: 100,
        });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({
            tokenId: "1",
            listingPrice: "10",
        });
    });

    it("selects a price-ordered seller index without sorting or grouping order history", () => {
        const sql = currentAskIdSql({
            chain: "?",
            collection: "?",
            token: "?",
            maker: "?",
            currencyCount: 2,
        });
        const plan = db.raw
            .prepare("EXPLAIN QUERY PLAN " + sql)
            .all(1, 1, "1", SELLER, ETH, WETH, now, now) as {
            detail: string;
        }[];
        expect(
            plan.some((r) =>
                r.detail.includes("orders_current_seller_ask_idx"),
            ),
        ).toBe(true);
        expect(plan.some((r) => /TEMP B-TREE|SCAN orders/.test(r.detail))).toBe(
            false,
        );
    });

    it("keeps multiple current asks and bids beyond the old history budget while spam produces one row", async () => {
        db.raw.transaction(() => {
            for (let i = 0; i < 10_001; i++)
                order(`live-${i}`, String(100 + i));
            order("passive-bid", "90");
            db.prepare(
                "UPDATE orders SET side='buy' WHERE id='passive-bid'",
            ).run();
        })();
        await event("live-0");
        await event("live-10000", FIRST + 10);
        while (storage.maintainBatch(now)) {
            /* bounded online batches */
        }
        expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({
            n: 10_002,
        });
        expect(list().items).toHaveLength(1);
        expect(list().items[0]).toMatchObject({
            price: "100",
            orderId: "live-0",
            occurredAt: FIRST,
        });
        // Inspect the actual card-grid query, not a simplified stand-in: only
        // the winning ask per token should require a canonical order-table read.
        const prepare = db.raw.prepare.bind(db.raw);
        const plans: string[] = [];
        const spy = vi
            .spyOn(db.raw, "prepare")
            .mockImplementation((sql: string) => {
                const statement = prepare(sql);
                if (sql.includes("SELECT ask.id")) {
                    const all = statement.all.bind(statement);
                    statement.all = (...bindings: unknown[]) => {
                        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
                            ...bindings,
                        ) as { detail: string }[];
                        plans.push(...plan.map((row) => row.detail));
                        return all(...bindings);
                    };
                }
                return statement;
            });
        try {
            const cards = new SqliteCollectionsReadModel([
                ETH,
                WETH,
            ]).listCollectionTokens({
                chainId: 1,
                collectionId: 1,
                tokenStatus: TOKEN_BROWSER_STATUS.Listed,
                limit: 100,
            });
            expect(cards.items).toHaveLength(1);
            expect(cards.items[0]?.listingPrice).toBe("100");
            expect(
                plans.some((detail) =>
                    detail.includes("orders_current_token_ask_idx"),
                ),
            ).toBe(true);
            expect(
                plans.some((detail) => /SCAN (o|ask)(\s|$)/.test(detail)),
            ).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });

    it("keeps pagination stable across current-price updates and splits the UTC midnight boundary", async () => {
        await event("yesterday", FIRST - 11);
        await event("today", FIRST);
        const params = {
            chainId: 1,
            collectionId: 1,
            kind: ACTIVITY_FEED_FILTER_KIND.Listings,
            limit: 1,
        };
        const firstPage = feed.listCollectionActivities(params);
        expect(firstPage.totalItems).toBe(2);
        expect(firstPage.items[0]?.occurredAt).toBe(FIRST);
        order("current", "42");
        await event("spam", FIRST + 50);
        const next = feed.listCollectionActivities({
            ...params,
            cursor: firstPage.nextCursor!,
        });
        expect(next.items[0]).toMatchObject({
            occurredAt: FIRST - 11,
            price: "999999",
        });
        // Null prevCursor on page two means the first page (omit the cursor).
        expect(next.rangeStart).toBe(2);
        const previous = feed.listCollectionActivities({
            ...params,
            cursor: next.prevCursor ?? undefined,
        });
        expect(previous.items[0]).toMatchObject({
            id: firstPage.items[0]!.id,
            occurredAt: FIRST,
            price: "42",
        });
        expect(previous.totalItems).toBe(2);
    });
});
