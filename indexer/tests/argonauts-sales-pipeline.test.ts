import { FINALIZED_SYNC_CHECK_POLICY } from "./helpers/chain-fixture.js";
import { beforeAll, describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { BLUR_BETH_ADDRESS } from "@artgod/shared/market-data/fills";
import {
    PRICE_HISTORY_CURRENCY_SYMBOL,
    PRICE_HISTORY_BUCKET,
    PRICE_HISTORY_RANGE,
} from "@artgod/shared/types/price-history";
import { SqlitePriceHistoryRead } from "../../backend/src/infra/collections/sqlite-price-history-read.js";
import { buildRealizedPriceHistory } from "../../backend/src/domain/realized-price-history.js";
import { COLLECTION_TOKEN_SCOPE_KIND } from "@artgod/shared/collections/token-scope";
import { syncRange } from "../src/application/sync.js";
import { ACTIVITY_KIND } from "../src/domain/activities.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import { DOMAIN_SYNC_PROJECTION } from "../src/domain/domain-jobs.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteActivityDomain } from "../src/infra/domain/activities.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import type { Hex, RpcBlock } from "../src/ports/rpc.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    createTxDumpRpc,
    readTxDump,
    toEnhancedTransaction,
} from "./helpers/tx-dumps.js";

const CONTRACT = "0x387c41b0b2f1128de44db1bcf8baad085f26392c";
const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

describe("Argonauts historical sale projection", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        db.prepare(
            "INSERT INTO collections (collection_id, chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply) VALUES (17, 1, 'argonauts', ?, ?, ?, ?, '1', 10000)",
        ).run(
            CONTRACT,
            COLLECTION_STANDARD.Erc721,
            COLLECTION_STATUS.Live,
            COLLECTION_TOKEN_SCOPE_KIND.TokenRange,
        );
    });

    it.each([
        {
            hash: "0x47f2bf2e7e65802e83a8a21d198f8b1599d264f2d062ea727329eb7d15eb0cfb",
            currency: zeroAddress,
            sales: [
                {
                    token_id: "3109",
                    log_index: 97,
                    price: "13000000000000000000",
                },
            ],
        },
        {
            hash: "0x2e6abf2f9665fe405715588d5635cf532bad7dee85ec94995d690149b5aa3c1e",
            currency: zeroAddress,
            sales: [
                {
                    token_id: "2362",
                    log_index: 476,
                    price: "600000000000000000",
                },
            ],
        },
        {
            hash: "0x83d35199e322fe088d1f3f6fc882fd895b7cdc8a7889d026ea7b6a5c3e9a9c9e",
            currency: WETH_ADDRESS,
            sales: [
                {
                    token_id: "2959",
                    log_index: 990,
                    price: "1350000000000000064",
                },
            ],
        },
        {
            hash: "0x14be04e98cbe409dc602ca208c8d3c5fefeff89892ff776042c6b540be68a7bd",
            currency: zeroAddress,
            sales: [
                {
                    token_id: "1102",
                    log_index: 302,
                    price: "859999000000000000",
                },
                {
                    token_id: "1156",
                    log_index: 306,
                    price: "859999000000000000",
                },
                {
                    token_id: "9377",
                    log_index: 307,
                    price: "859980000000000000",
                },
            ],
        },
        {
            hash: "0xbe27fe81487e69e1bbb49701f13317469929e3eb2b1165533cf3cdbae51313b1",
            currency: zeroAddress,
            sales: [
                {
                    token_id: "2970",
                    log_index: 802,
                    price: "163999000000000000",
                },
                {
                    token_id: "5435",
                    log_index: 803,
                    price: "164000000000000000",
                },
                {
                    token_id: "7033",
                    log_index: 804,
                    price: "163999000000000000",
                },
            ],
        },
        {
            hash: "0x8a952b2c66632fafd81766f953608b4504621ab39162c45db9ae6a1e57fc90e2",
            currency: zeroAddress,
            sales: [
                { token_id: "116", log_index: 32, price: "250000000000000000" },
            ],
        },
        {
            // Two independently accepted pool offers retain their BETH currency.
            hash: "0x3e2bfdccd1a7deb319ed4d5ffeb9e927b955e464bdf6a6fdd0a94259b0016ee4",
            currency: BLUR_BETH_ADDRESS,
            sales: [
                {
                    token_id: "8626",
                    log_index: 215,
                    price: "200000000000000000",
                },
                {
                    token_id: "1044",
                    log_index: 216,
                    price: "190000000000000000",
                },
            ],
        },
        {
            // OpenSea also reports a seller-to-self mirror for this same transfer.
            hash: "0x0ea81d2f14a1bf9673610042e056bcb23012742e50a3b743e435055238d83a6a",
            currency: WETH_ADDRESS,
            sales: [
                {
                    token_id: "3350",
                    log_index: 492,
                    price: "631000000000000000",
                },
            ],
        },
    ])(
        "persists and projects $hash once across repeated backfills",
        async ({ hash, currency, sales }) => {
            const tx = toEnhancedTransaction(
                await readTxDump(
                    import.meta.url,
                    "fill-txs/argonauts",
                    hash + ".json",
                ),
            );
            const block: RpcBlock = {
                number: tx.blockNumber,
                hash: tx.blockHash as Hex,
                parentHash: `0x${"00".repeat(32)}`,
                timestamp: 1_700_000_000,
                transactions: [hash as Hex],
            };
            const rpc = createTxDumpRpc(tx, block);
            const registry = new SqliteCollectionRegistry();
            const collections = registry.listCollectionsForSync(1, "backfill");
            const storage = new SqliteStorage();
            const activities = new SqliteActivityDomain([
                zeroAddress,
                WETH_ADDRESS,
                BLUR_BETH_ADDRESS,
            ]);
            for (let attempt = 0; attempt < 2; attempt++) {
                const data = await syncRange(rpc, 1, collections, registry, {
                    fromBlock: block.number,
                    toBlock: block.number,
                });
                expect(data.collectionScoped.fillEvents).toHaveLength(
                    sales.length,
                );
                storage.persistSyncResult({
                    canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
                    checkpoint: storage.captureSyncCheckpoint(1),
                    blocks: [block],
                    data,
                    collections,
                });
                await activities.handleDomainSync({
                    chainId: 1,
                    collectionId: 17,
                    fromBlock: block.number,
                    toBlock: block.number,
                    mode: "backfill",
                    projection: DOMAIN_SYNC_PROJECTION.FactsOnly,
                    sourceJobId: "argonauts-sale-regression",
                    sourceKind: "test",
                });
                const expected = sales.map((sale) => ({
                    ...sale,
                    chain_id: 1,
                    collection_id: 17,
                    currency,
                    amount: "1",
                }));
                const fills = db
                    .prepare(
                        `SELECT f.chain_id, f.collection_id, f.token_id, f.log_index, f.amount,
                            e.total_price AS price, e.currency
                         FROM fills f JOIN fill_executions e ON e.id=f.execution_id
                         WHERE f.tx_hash=? ORDER BY f.log_index`,
                    )
                    .all(hash);
                expect(fills).toEqual(expected);
                expect(
                    db
                        .prepare(
                            "SELECT log_index, nft_quantity, price_exclusion FROM fill_executions WHERE tx_hash=? ORDER BY log_index",
                        )
                        .all(hash),
                ).toEqual(
                    sales.map((sale) => ({
                        log_index: sale.log_index,
                        nft_quantity: "1",
                        price_exclusion: null,
                    })),
                );
                // Every raw protocol item survives ingestion, including the
                // forwarding leg, while fills attribute the sold NFT only once.
                const rawItems = db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM fill_execution_items i JOIN fill_executions e ON e.id=i.execution_id WHERE e.tx_hash=?",
                    )
                    .get(hash) as { n: number };
                expect(rawItems.n).toBe(
                    data.collectionScoped.fillEvents.reduce(
                        (n, fill) => n + fill.execution.items.length,
                        0,
                    ),
                );
                const reader = new SqlitePriceHistoryRead([
                    {
                        address: zeroAddress,
                        symbol: PRICE_HISTORY_CURRENCY_SYMBOL.Eth,
                    },
                    {
                        address: WETH_ADDRESS,
                        symbol: PRICE_HISTORY_CURRENCY_SYMBOL.Weth,
                    },
                    {
                        address: BLUR_BETH_ADDRESS,
                        symbol: PRICE_HISTORY_CURRENCY_SYMBOL.Beth,
                    },
                ]);
                const history = buildRealizedPriceHistory(
                    reader.iterateObservations({
                        chainId: 1,
                        collectionId: 17,
                        from: block.timestamp,
                        to: block.timestamp + 1,
                        limit: 100,
                    }),
                    {
                        bucket: PRICE_HISTORY_BUCKET.Day,
                        range: PRICE_HISTORY_RANGE.All,
                    },
                    block.timestamp + 1,
                );
                const observed = history.sales.filter(
                    (sale) => sale.txHash === hash,
                );
                expect(observed.map((sale) => sale.currencySymbol)).toEqual(
                    sales.map(() =>
                        currency === BLUR_BETH_ADDRESS
                            ? PRICE_HISTORY_CURRENCY_SYMBOL.Beth
                            : currency === WETH_ADDRESS
                              ? PRICE_HISTORY_CURRENCY_SYMBOL.Weth
                              : PRICE_HISTORY_CURRENCY_SYMBOL.Eth,
                    ),
                );
                expect(
                    observed.map((sale) => ({
                        token_id: sale.tokenId,
                        price: sale.unitPrice.numeratorWei,
                        quantity: sale.quantity,
                        denominator: sale.unitPrice.denominator,
                        currency: sale.currencyAddress,
                        attributedPrice: sale.attributedPriceWei,
                    })),
                ).toEqual(
                    sales.map((sale) => ({
                        token_id: sale.token_id,
                        price: sale.price,
                        quantity: "1",
                        denominator: "1",
                        currency,
                        attributedPrice: sale.price,
                    })),
                );
                const projected = db
                    .prepare(
                        "SELECT chain_id, collection_id, token_id, log_index, amount, price, currency FROM activities WHERE tx_hash = ? AND kind = ? ORDER BY log_index",
                    )
                    .all(hash, ACTIVITY_KIND.Sale);
                expect(projected).toEqual(expected);
                const sourceFacts = db
                    .prepare(
                        "SELECT order_id, maker, taker, order_side AS side FROM fills WHERE tx_hash = ? ORDER BY log_index",
                    )
                    .all(hash);
                const projectedFacts = db
                    .prepare(
                        "SELECT order_id, maker, taker, side FROM activities WHERE tx_hash = ? AND kind = ? ORDER BY log_index",
                    )
                    .all(hash, ACTIVITY_KIND.Sale);
                expect(projectedFacts).toEqual(sourceFacts);
            }
        },
    );
});
