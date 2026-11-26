import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { zeroAddress } from "viem";
import { db, setDbPath } from "@artgod/shared/database";
import { SqliteCurrentAsks } from "@artgod/shared/database/current-asks";
import { getSettingDefault } from "@artgod/shared/config/generated-settings-defaults";
import { createMigrationRunner } from "@artgod/shared/migrations";
import type { BookMarket } from "../src/domain/orderbook.js";
import {
    reconcileVvvBook,
    scheduleVvvBooks,
} from "../src/application/offchain/vvv-reconcile.js";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { SqliteOrderSourceStateStore } from "../src/infra/offchain/sqlite-order-source-state.js";
import { VvvBrowserBookReader } from "../src/infra/offchain/vvv-browser.js";
import { VVV_MARKET } from "../src/infra/offchain/vvv-markets.js";
import {
    BULK_ORDER_OBSERVED_AT,
    capturedBulkOrder,
} from "../tests/fixtures/seaport-bulk-order.js";
import captured from "../tests/fixtures/vvv-cash-book.json" with { type: "json" };

it("fetches a shared VVV book once, routes two ranges and keeps an unrelated contract independent", async () => {
    const bulk = capturedBulkOrder();
    const second = {
        ...VVV_MARKET,
        reference: "second",
        contract: bulk.contract,
    };
    const books = new Map<string, unknown>([
        [VVV_MARKET.reference, captured],
        [
            second.reference,
            {
                chainId: second.chainId,
                contract: second.contract,
                orders: [
                    {
                        hash: bulk.id,
                        offerer: bulk.maker,
                        fillable: true,
                        status: "active",
                        order: {
                            parameters: bulk.seaportData,
                            signature: bulk.seaportData!.signature,
                        },
                    },
                ],
            },
        ],
    ]);
    const gets: string[] = [];
    const dir = await mkdtemp(
        fileURLToPath(new URL("../../tmp/bound-markets-", import.meta.url)),
    );
    setDbPath(dir + "/books.sqlite");
    const server = createServer((request, response) => {
        const [, market, resource] = request.url!.split("/");
        if (
            !market ||
            !books.has(market) ||
            !["reader", "book"].includes(resource!)
        ) {
            response.writeHead(404).end();
            return;
        }
        gets.push(request.url!);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
            JSON.stringify(resource === "reader" ? [] : books.get(market)),
        );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Missing fixture port");
    const origin = "http://127.0.0.1:" + address.port;
    const reader = new VvvBrowserBookReader(
        [VVV_MARKET, second].map((market) => ({
            market,
            readerUrl: origin + "/" + market.reference + "/reader",
            bookUrl: origin + "/" + market.reference + "/book",
        })),
    );
    try {
        await createMigrationRunner().runMigrations();
        const weth = getSettingDefault("WETH_ADDRESS");
        const store = new SqliteOrderSourceStateStore(
            weth,
            () => BULK_ORDER_OBSERVED_AT * 1000,
        );
        const addLiveRange = (
            id: number,
            market: BookMarket,
            start: number,
        ) => {
            db.prepare(
                "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind,scope_start_token_id,scope_total_supply) VALUES(?,1,?,?,'erc721','live','token_range',?,30000)",
            ).run(id, "range-" + id, market.contract, String(start));
        };
        addLiveRange(51, VVV_MARKET, 0);
        addLiveRange(52, VVV_MARKET, 30000);
        addLiveRange(53, second, 0);
        const publish = vi.fn(async () => {});
        const schedule = (collectionId?: number) =>
            scheduleVvvBooks(
                store,
                { publish },
                VVV_MARKET.chainId,
                [VVV_MARKET, second],
                { collectionId, now: BULK_ORDER_OBSERVED_AT * 1000 },
            );
        const due = () =>
            store.due(VVV_MARKET.venue, 1, Number.MAX_SAFE_INTEGER);
        // Startup recovers already-live ranges with no bootstrap notification.
        expect(due()).toEqual([]);
        await schedule();
        expect(publish).toHaveBeenCalledTimes(2);
        expect(due()).toHaveLength(2);
        const shared = store.due(
            VVV_MARKET.venue,
            1,
            Number.MAX_SAFE_INTEGER,
            51,
        )[0]!.feedId;
        expect(
            store.due(VVV_MARKET.venue, 1, Number.MAX_SAFE_INTEGER, 52)[0]!
                .feedId,
        ).toBe(shared);
        for (const job of due()) await reconcileVvvBook(store, reader, 1, job);
        await schedule(51);
        await schedule();
        expect(publish).toHaveBeenCalledTimes(2);
        expect(gets.filter((url) => url.endsWith("/book"))).toEqual([
            "/" + VVV_MARKET.reference + "/book",
            "/second/book",
        ]);
        const members = () =>
            db
                .prepare(
                    "SELECT collection_id,settlement_id FROM orderbook_members WHERE present=1 ORDER BY collection_id",
                )
                .all();
        expect(members()).toMatchObject([
            {
                collection_id: 51,
                settlement_id: expect.stringContaining(
                    captured.orders[0]!.hash,
                ),
            },
            {
                collection_id: 52,
                settlement_id: expect.stringContaining(
                    captured.orders[1]!.hash,
                ),
            },
            {
                collection_id: 53,
                settlement_id: expect.stringContaining(bulk.id),
            },
        ]);
        const ownAsk = () =>
            new SqliteCurrentAsks(db.raw, [zeroAddress, weth]).forSeller(
                1,
                53,
                bulk.tokenId!,
                bulk.maker,
                BULK_ORDER_OBSERVED_AT,
            )?.price;
        expect(ownAsk()).toBe(bulk.price);
        const sharedJob = due().find((job) => job.feedId === shared)!;
        books.set(VVV_MARKET.reference, {
            ...captured,
            contract: second.contract,
        });
        await expect(
            reconcileVvvBook(store, reader, 1, sharedJob),
        ).rejects.toThrow("identity");
        expect(members()).toHaveLength(3);
        books.set(VVV_MARKET.reference, { ...captured, orders: [] });
        await reconcileVvvBook(store, reader, 1, sharedJob);
        expect(members()).toMatchObject([{ collection_id: 53 }]);
        expect(ownAsk()).toBe(bulk.price);
        db.prepare(
            "UPDATE collections SET status=? WHERE collection_id=51",
        ).run(COLLECTION_STATUS.Paused);
        await schedule(51);
        expect(
            store.due(VVV_MARKET.venue, 1, Number.MAX_SAFE_INTEGER, 51),
        ).toEqual([]);
        expect(
            store.due(VVV_MARKET.venue, 1, Number.MAX_SAFE_INTEGER, 52),
        ).toHaveLength(1);
        const queuedBeforePause = store.due(
            second.venue,
            1,
            Number.MAX_SAFE_INTEGER,
            53,
        )[0]!;
        db.prepare(
            "UPDATE collections SET status=? WHERE collection_id=53",
        ).run(COLLECTION_STATUS.Paused);
        const before = gets.length;
        await reconcileVvvBook(store, reader, 1, queuedBeforePause);
        expect(gets).toHaveLength(before);
    } finally {
        await reader.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.raw.close();
    }
}, 35_000);
