import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { BLUR_BETH_ADDRESS, FILL_KIND } from "@artgod/shared/market-data/fills";
import { ORDER_SIDE } from "@artgod/shared/market-data/orders";
import { SqliteChainsReadModel } from "@artgod/shared/read-models/chains";
import { SqliteCollectionsReadModel } from "@artgod/shared/read-models/collections";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import {
    PRICE_HISTORY_BUCKET as BUCKET,
    PRICE_HISTORY_RANGE as RANGE,
    PRICE_HISTORY_LIMITS,
    PRICE_HISTORY_CURRENCY_SYMBOL,
    REALIZED_SALE_ACTION,
    priceBucketStart,
} from "@artgod/shared/types/price-history";
import {
    COLLECTION_API_ROUTE_TEMPLATE,
    buildPriceHistoryPath,
} from "@artgod/shared/http/collection-routes";
import { SqlitePriceHistoryRead } from "./sqlite-price-history-read.js";
import { CachedPriceHistoryRead } from "./cached-price-history-read.js";
import { MemoryQueryCache } from "../cache/memory.js";
import {
    GetPriceHistoryUseCase,
    type PriceHistoryReadPort,
} from "../../application/use-cases/collections/get-price-history.js";
import { GetPriceHistoryHttpAdapter } from "../../http/handlers/collections/get-price-history.js";

const ETH = "0x0000000000000000000000000000000000000000";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const CURRENCIES = [ETH, WETH, BLUR_BETH_ADDRESS];
const TIME = Date.UTC(2026, 0, 1) / 1000;
let collectionId: number;
let collectionRef: string;
let useCase: GetPriceHistoryUseCase;
let reader: SqlitePriceHistoryRead;
let serial = 0;
beforeAll(async () => {
    const root = resolveProjectPath("tmp/price-history-tests");
    mkdirSync(root, { recursive: true });
    setDbPath(join(mkdtempSync(join(root, "run-")), "fixture.sqlite"));
    await createMigrationRunner().runMigrations();
    // The migration installs the canonical collection preset.
    collectionId = (
        db.prepare("SELECT collection_id FROM collections LIMIT 1").get() as {
            collection_id: number;
        }
    ).collection_id;
    collectionRef = (
        db
            .prepare("SELECT slug FROM collections WHERE collection_id = ?")
            .get(collectionId) as { slug: string }
    ).slug;
    reader = new SqlitePriceHistoryRead([
        { address: ETH, symbol: PRICE_HISTORY_CURRENCY_SYMBOL.Eth },
        { address: WETH, symbol: PRICE_HISTORY_CURRENCY_SYMBOL.Weth },
        {
            address: BLUR_BETH_ADDRESS,
            symbol: PRICE_HISTORY_CURRENCY_SYMBOL.Beth,
        },
    ]);
    useCase = new GetPriceHistoryUseCase(
        1,
        new SqliteChainsReadModel(),
        new SqliteCollectionsReadModel([ETH, WETH]),
        reader,
        () => TIME + 5 * 86400,
    );
});
beforeEach(() => {
    db.exec("DELETE FROM fills");
    serial = 0;
});

function fill(
    overrides: Partial<{
        token: string;
        collection: number;
        chain: number;
        timestamp: number;
        block: number;
        log: number;
        price: string;
        currency: string;
        amount: string;
        count: string | null;
        kind: string;
        tx: string;
        side: string | null;
        maker: string | null;
        taker: string | null;
    }> = {},
) {
    const n = ++serial;
    const value = {
        token: "1",
        collection: collectionId,
        chain: 1,
        timestamp: TIME,
        block: 100,
        log: n,
        price: "1000000000000000001",
        currency: ETH,
        amount: "1",
        count: "1",
        kind: FILL_KIND.Seaport,
        tx: "0x" + n,
        side: ORDER_SIDE.Sell,
        maker: "0x" + "11".repeat(20),
        taker: "0x" + "22".repeat(20),
        ...overrides,
    };
    db.prepare(
        `INSERT INTO fills(chain_id,collection_id,kind,contract_address,token_id,amount,price,currency,block_number,block_hash,block_timestamp,tx_hash,log_index,price_nft_count,order_side,maker,taker)
        VALUES (@chain,@collection,@kind,'contract',@token,@amount,@price,@currency,@block,'hash',@timestamp,@tx,@log,@count,@side,@maker,@taker)`,
    ).run(value);
}
const input = () => ({
    chainRef: "1",
    collectionRef,
    bucket: BUCKET.Day,
    range: RANGE.All,
});

it("excludes bundles, unknown legacy Seaport, quantities, malformed prices and other currencies/scopes", () => {
    CURRENCIES.forEach((currency) => fill({ currency }));
    fill({ kind: FILL_KIND.BlurV2, count: null });
    fill({ count: "2" }); // Including the case with an untracked sibling.
    fill({ count: null });
    fill({ count: "1", amount: "2" });
    fill({ currency: "0x1111111111111111111111111111111111111111" });
    fill({ collection: collectionId + 1 });
    fill({ chain: 2 });
    fill({ price: "NaN" });
    fill({ price: "-2" });
    const history = useCase.getPriceHistory(input());
    expect(history.sales).toHaveLength(4);
    expect(history.unit).toBe("ETH");
    expect(history.buckets[0]!.volume).toBe(4);
    expect(
        history.sales.map((sale) => [
            sale.currencyAddress,
            sale.currencySymbol,
        ]),
    ).toEqual([
        [ETH, PRICE_HISTORY_CURRENCY_SYMBOL.Eth],
        [WETH, PRICE_HISTORY_CURRENCY_SYMBOL.Weth],
        [BLUR_BETH_ADDRESS, PRICE_HISTORY_CURRENCY_SYMBOL.Beth],
        [ETH, PRICE_HISTORY_CURRENCY_SYMBOL.Eth],
    ]);
    expect(history.buckets[0]!.turnoverWei).toBe("4000000000000000004");
    expect(
        history.sales.every((sale) => sale.priceWei === "1000000000000000001"),
    ).toBe(true);
});

it("retains executed order actions and participants without guessing unknown sides", () => {
    const maker = "0x" + "11".repeat(20),
        taker = "0x" + "22".repeat(20);
    fill({ side: ORDER_SIDE.Sell });
    fill({ side: ORDER_SIDE.Buy });
    fill({ side: null });
    fill({ side: ORDER_SIDE.Buy, taker: null });
    fill({ side: "unsupported" });
    expect(
        useCase
            .getPriceHistory(input())
            .sales.map(({ action, seller, buyer }) => ({
                action,
                seller,
                buyer,
            })),
    ).toEqual([
        { action: REALIZED_SALE_ACTION.TakeAsk, seller: maker, buyer: taker },
        { action: REALIZED_SALE_ACTION.TakeOffer, seller: taker, buyer: maker },
        { action: null, seller: null, buyer: null },
        { action: REALIZED_SALE_ACTION.TakeOffer, seller: null, buyer: maker },
        { action: null, seller: null, buyer: null },
    ]);
});

it("sorts executions deterministically and aggregates exact OHLC/volume without filling gaps", () => {
    fill({ price: "1000000000000000003", log: 3 });
    fill({ price: "1000000000000000001", log: 1 });
    fill({ price: "1000000000000000004", log: 2 });
    fill({ timestamp: TIME + 2 * 86400, price: "7", token: "2" });
    const history = useCase.getPriceHistory(input());
    expect(history.buckets).toHaveLength(2);
    expect(history.buckets[0]).toEqual({
        timestamp: TIME,
        openWei: "1000000000000000001",
        highWei: "1000000000000000004",
        lowWei: "1000000000000000001",
        closeWei: "1000000000000000003",
        volume: 3,
        turnoverWei: "3000000000000000008",
    });
    expect(history.to - history.from).toBe(3 * 86400);
    expect(
        useCase.getPriceHistory({ ...input(), tokenId: "0002" }).sales,
    ).toHaveLength(1);
    expect(priceBucketStart(TIME, BUCKET.Week)).toBe(
        Date.UTC(2025, 11, 29) / 1000,
    );
});

it("uses half-open requested ranges and rejects unsafe allocations or invalid inputs", () => {
    fill({ timestamp: TIME - 100 * 86400 });
    fill({ timestamp: TIME });
    fill({ timestamp: TIME + 6 * 86400 });
    expect(
        useCase.getPriceHistory({ ...input(), range: RANGE.Month }).sales,
    ).toHaveLength(1);
    for (const change of [
        { bucket: "2m" },
        { range: "forever" },
        { tokenId: "-1" },
        { tokenId: (2n ** 256n).toString() },
    ]) {
        expect(() =>
            useCase.getPriceHistory({ ...input(), ...change }),
        ).toThrow(ReadModelBadRequestError);
    }
    fill({ timestamp: 1 });
    expect(
        useCase.getPriceHistory({ ...input(), bucket: BUCKET.Hour }).bucket,
    ).toBe(BUCKET.Day);
    const first = [
        ...reader.iterateSingleTokenSales({
            chainId: 1,
            collectionId,
            from: 0,
            to: TIME + 1,
            limit: 1,
        }),
    ][0]!;
    const overflowing: PriceHistoryReadPort = {
        *iterateSingleTokenSales() {
            for (let i = 0; i <= PRICE_HISTORY_LIMITS.fills; i++) yield first;
        },
    };
    const bounded = new GetPriceHistoryUseCase(
        1,
        new SqliteChainsReadModel(),
        new SqliteCollectionsReadModel(CURRENCIES),
        overflowing,
    );
    expect(() => bounded.getPriceHistory(input())).toThrow(
        /shorter price history range/,
    );
});

it("maps HTTP scope and query through the use case and SQLite adapter", async () => {
    fill({ token: "7", currency: WETH });
    fill({ token: "8" });
    const app = Fastify();
    const adapter = new GetPriceHistoryHttpAdapter(useCase);
    app.get(COLLECTION_API_ROUTE_TEMPLATE.PriceHistory, adapter.handle);
    app.setErrorHandler((error, _request, reply) =>
        reply.code(error instanceof ReadModelBadRequestError ? 400 : 500).send({
            message: error instanceof Error ? error.message : "Unknown error",
        }),
    );
    try {
        const response = await app.inject(
            buildPriceHistoryPath("ethereum", collectionRef, {
                bucket: BUCKET.Hour,
                range: RANGE.All,
                tokenId: "7",
            }),
        );
        expect(response.statusCode).toBe(200);
        expect(
            response
                .json()
                .sales.map((sale: { tokenId: string }) => sale.tokenId),
        ).toEqual(["7"]);
        expect(response.json().bucketSeconds).toBe(86400);
        expect(response.json().sales[0]).toMatchObject({
            currencyAddress: WETH,
            currencySymbol: PRICE_HISTORY_CURRENCY_SYMBOL.Weth,
            priceWei: "1000000000000000001",
            action: REALIZED_SALE_ACTION.TakeAsk,
        });
        const invalid = await app.inject(
            buildPriceHistoryPath("1", collectionRef, {
                bucket: BUCKET.Day,
                range: RANGE.All,
                tokenId: "oops",
            }),
        );
        expect(invalid.statusCode).toBe(400);
    } finally {
        await app.close();
    }
});

it("reads 50,000 sales across five years in index order without a temporary sort", () => {
    const count = 50_000;
    const start = TIME - 5 * 365 * 86400;
    db.writeTransaction(() => {
        // Insert backwards to ensure row/insertion order cannot pass this check.
        for (let i = count - 1; i >= 0; i--)
            fill({
                token: String(i % 100),
                timestamp: start + Math.floor((i * (TIME - start)) / count),
                block: i + 1,
                log: i % 10,
                price: String(10n ** 18n + BigInt(i)),
            });
    })();
    const prepare = vi.spyOn(db, "prepare");
    const started = performance.now();
    const history = useCase.getPriceHistory(input());
    const elapsedMs = performance.now() - started;
    const token = useCase.getPriceHistory({ ...input(), tokenId: "7" });
    const queries = prepare.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql.includes("price_nft_count"));
    prepare.mockRestore();
    expect(history.sales).toHaveLength(count);
    expect(history.buckets).toHaveLength(5 * 365);
    expect(
        history.buckets.reduce((sum, bucket) => sum + bucket.volume, 0),
    ).toBe(count);
    expect(
        history.sales.every(
            (sale, i) => sale.priceWei === String(10n ** 18n + BigInt(i)),
        ),
    ).toBe(true);
    expect(token.sales).toHaveLength(500);
    for (const [i, query] of queries.entries()) {
        const args = [
            1,
            collectionId,
            0,
            TIME + 5 * 86400 + 1,
            ...(i ? ["7"] : []),
            FILL_KIND.BlurV2,
            ...CURRENCIES,
            PRICE_HISTORY_LIMITS.fills + 1,
        ];
        const plan = db.prepare("EXPLAIN QUERY PLAN " + query).all(...args) as {
            detail: string;
        }[];
        expect(plan.map((row) => row.detail).join(" ")).toContain(
            i ? "fills_collection_token_idx" : "fills_collection_time_idx",
        );
        expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(
            false,
        );
    }
    expect(queries).toHaveLength(2);
    console.info(
        `Five-year fixture: ${count} fills, ${elapsedMs.toFixed(1)} ms read/aggregate, ${(JSON.stringify(history).length / 1024 / 1024).toFixed(1)} MiB JSON`,
    );
});

it("shares a bounded public snapshot across ranges and observes correction, deletion and new fills after expiry", () => {
    vi.useFakeTimers();
    const source = vi.spyOn(reader, "iterateSingleTokenSales");
    try {
        fill({ token: "1" });
        fill({ token: "2", timestamp: TIME - 100 * 86400 });
        const cached = new CachedPriceHistoryRead(
            reader,
            new MemoryQueryCache({ maxEntries: 1 }),
            30_000,
        );
        const request = {
            chainId: 1,
            collectionId,
            from: 0,
            to: TIME + 1,
            limit: PRICE_HISTORY_LIMITS.fills + 1,
        };
        const all = Array.from(cached.iterateSingleTokenSales(request));
        expect(all.map((sale) => sale.tokenId)).toEqual(["2", "1"]);
        expect(
            Array.from(
                cached.iterateSingleTokenSales({
                    ...request,
                    from: TIME,
                    tokenId: "1",
                }),
            ),
        ).toEqual([all[1]]);
        expect(source).toHaveBeenCalledTimes(1);
        db.prepare("DELETE FROM fills WHERE token_id = ?").run("2");
        db.prepare(
            "UPDATE fills SET price_nft_count = ? WHERE token_id = ?",
        ).run("2", "1");
        fill({ token: "3", price: "77" });
        expect(Array.from(cached.iterateSingleTokenSales(request))).toEqual(
            all,
        );
        vi.advanceTimersByTime(30_000);
        const refreshed = Array.from(cached.iterateSingleTokenSales(request));
        expect(refreshed.map((sale) => [sale.tokenId, sale.priceWei])).toEqual([
            ["3", "77"],
        ]);
        expect(source).toHaveBeenCalledTimes(2);
        expect(
            Array.from(
                cached.iterateSingleTokenSales({
                    ...request,
                    collectionId: collectionId + 1,
                }),
            ),
        ).toEqual([]);
        expect(source).toHaveBeenCalledTimes(3);
    } finally {
        source.mockRestore();
        vi.useRealTimers();
    }
});

it("does not cache an oversized collection or truncate a bounded token read", () => {
    fill();
    const request = {
        chainId: 1,
        collectionId,
        from: 0,
        to: TIME + 1,
        limit: PRICE_HISTORY_LIMITS.fills + 1,
        tokenId: "1",
    };
    const first = Array.from(reader.iterateSingleTokenSales(request))[0]!;
    const source: PriceHistoryReadPort = {
        *iterateSingleTokenSales(input) {
            if (input.tokenId) {
                yield first;
                return;
            }
            for (let i = 0; i <= PRICE_HISTORY_LIMITS.fills; i++) yield first;
        },
    };
    const cache = new MemoryQueryCache({ maxEntries: 1 });
    const set = vi.spyOn(cache, "set");
    const cached = new CachedPriceHistoryRead(source, cache, 30_000);
    expect(Array.from(cached.iterateSingleTokenSales(request))).toEqual([
        first,
    ]);
    expect(set).not.toHaveBeenCalled();
});
