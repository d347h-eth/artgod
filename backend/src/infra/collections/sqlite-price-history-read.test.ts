import { beforeAll, beforeEach, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { BLUR_BETH_ADDRESS, FILL_KIND } from "@artgod/shared/market-data/fills";
import { SqliteChainsReadModel } from "@artgod/shared/read-models/chains";
import { SqliteCollectionsReadModel } from "@artgod/shared/read-models/collections";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import {
    PRICE_HISTORY_BUCKET as BUCKET,
    PRICE_HISTORY_RANGE as RANGE,
    PRICE_HISTORY_LIMITS,
    PRICE_HISTORY_ROUTE,
    buildPriceHistoryPath,
    priceBucketStart,
} from "@artgod/shared/types/price-history";
import { SqlitePriceHistoryRead } from "./sqlite-price-history-read.js";
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
    reader = new SqlitePriceHistoryRead(CURRENCIES);
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
        ...overrides,
    };
    db.prepare(
        `INSERT INTO fills(chain_id,collection_id,kind,contract_address,token_id,amount,price,currency,block_number,block_hash,block_timestamp,tx_hash,log_index,price_nft_count)
        VALUES (@chain,@collection,@kind,'contract',@token,@amount,@price,@currency,@block,'hash',@timestamp,@tx,@log,@count)`,
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
    expect(JSON.stringify(history)).not.toMatch(/currency|WETH|BETH|c02aaa/i);
    expect(
        history.sales.every((sale) => sale.priceWei === "1000000000000000001"),
    ).toBe(true);
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
    expect(() =>
        useCase.getPriceHistory({ ...input(), bucket: BUCKET.Hour }),
    ).toThrow(/larger time bucket/);
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
    fill({ token: "7" });
    fill({ token: "8" });
    const app = Fastify();
    const adapter = new GetPriceHistoryHttpAdapter(useCase);
    app.get(PRICE_HISTORY_ROUTE, adapter.handle);
    app.setErrorHandler((error, _request, reply) =>
        reply
            .code(error instanceof ReadModelBadRequestError ? 400 : 500)
            .send({
                message:
                    error instanceof Error ? error.message : "Unknown error",
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
        expect(response.json().bucketSeconds).toBe(3600);
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
