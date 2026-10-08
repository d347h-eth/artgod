import { beforeAll, describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import {
    FILL_KIND,
    fillExecutionIdentity,
} from "@artgod/shared/market-data/fills";
import { COLLECTION_TOKEN_SCOPE_KIND } from "@artgod/shared/collections/token-scope";
import {
    PRICE_HISTORY_BUCKET,
    PRICE_HISTORY_CURRENCY_SYMBOL,
    PRICE_HISTORY_RANGE,
} from "@artgod/shared/types/price-history";
import { SqlitePriceHistoryRead } from "../../backend/src/infra/collections/sqlite-price-history-read.js";
import { buildRealizedPriceHistory } from "../../backend/src/domain/realized-price-history.js";
import { syncRange } from "../src/application/sync.js";
import { ACTIVITY_KIND } from "../src/domain/activities.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import { DOMAIN_SYNC_PROJECTION } from "../src/domain/domain-jobs.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteActivityDomain } from "../src/infra/domain/activities.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import type { Hex, RpcBlock } from "../src/ports/rpc.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { createTxDumpRpc } from "./helpers/tx-dumps.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    readWyvernTransaction,
    WYVERN_FIXTURE,
    WYVERN_FIXTURE_CONTRACT,
    WYVERN_FIXTURE_WETH,
} from "./helpers/wyvern.js";
import expectedSales from "./fixtures/fill-txs/wyvern/expected-sales.json" with { type: "json" };

// API buyer can name the router. Expected participants use the receipt's NFT
// transfer endpoints and matched-call settlement currency; expected unit prices
// retain the API comparison.

describe("Wyvern historical sale projection", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        db.prepare(
            "DELETE FROM collections WHERE chain_id=1 AND slug='terraforms'",
        ).run();
        db.prepare(
            "INSERT INTO collections (collection_id, chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply) VALUES (17, 1, 'terraforms', ?, ?, ?, ?, '0', 10000)",
        ).run(
            WYVERN_FIXTURE_CONTRACT,
            COLLECTION_STANDARD.Erc721,
            COLLECTION_STATUS.Live,
            COLLECTION_TOKEN_SCOPE_KIND.TokenRange,
        );
    });

    it.each(Object.values(WYVERN_FIXTURE))(
        "persists and projects %s once across repeated backfills",
        async (hash) => {
            const tx = await readWyvernTransaction(import.meta.url, hash);
            const block: RpcBlock = {
                number: tx.blockNumber,
                hash: tx.blockHash as Hex,
                parentHash: `0x${"00".repeat(32)}`,
                timestamp: 1_700_000_000,
                transactions: [hash],
            };
            const rpc = createTxDumpRpc(tx, block);
            const registry = new SqliteCollectionRegistry();
            const collections = registry.listCollectionsForSync(1, "backfill");
            const storage = new SqliteStorage();
            const activities = new SqliteActivityDomain([
                zeroAddress,
                WYVERN_FIXTURE_WETH,
            ]);
            const expected = expectedSales.filter((sale) => sale.hash === hash);
            const executions = new Map(
                expected.map((sale) => [sale.logIndex, sale]),
            );
            expect(expected.length).toBeGreaterThan(0);

            for (let attempt = 0; attempt < 2; attempt++) {
                const data = await syncRange(rpc, 1, collections, registry, {
                    fromBlock: block.number,
                    toBlock: block.number,
                });
                expect(data.collectionScoped.fillEvents).toHaveLength(
                    expected.length,
                );
                storage.persistSyncResult({
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
                    sourceJobId: "wyvern-sale-regression",
                    sourceKind: "test",
                });

                expect(
                    db
                        .prepare(
                            `SELECT f.token_id, f.log_index, f.amount, f.kind, e.total_price, e.currency, e.nft_quantity, e.price_exclusion
                FROM fills f JOIN fill_executions e ON e.id=f.execution_id
                WHERE f.tx_hash=? ORDER BY f.log_index,f.item_index`,
                        )
                        .all(hash),
                ).toEqual(
                    expected.map((sale) => ({
                        token_id: sale.tokenId,
                        log_index: sale.logIndex,
                        amount: "1",
                        kind: FILL_KIND.Wyvern,
                        total_price: sale.grossPrice,
                        currency: sale.currency,
                        nft_quantity: sale.nftQuantity,
                        price_exclusion: null,
                    })),
                );
                expect(
                    db
                        .prepare(
                            "SELECT COUNT(*) AS n FROM fill_executions WHERE tx_hash=?",
                        )
                        .get(hash),
                ).toEqual({ n: executions.size });
                // The bundle has two attributions but only one shared header/item set.
                const itemCount = [...executions.values()].reduce(
                    (n, sale) => n + Number(sale.nftQuantity) + 1,
                    0,
                );
                expect(
                    db
                        .prepare(
                            "SELECT COUNT(*) AS n FROM fill_execution_items i JOIN fill_executions e ON e.id=i.execution_id WHERE e.tx_hash=?",
                        )
                        .get(hash),
                ).toEqual({ n: itemCount });
                expect(
                    db
                        .prepare(
                            "SELECT token_id,log_index,amount,price,currency,from_address,to_address FROM activities WHERE tx_hash=? AND kind=? ORDER BY log_index,token_id+0",
                        )
                        .all(hash, ACTIVITY_KIND.Sale),
                ).toEqual(
                    expected.map((sale) => ({
                        token_id: sale.tokenId,
                        log_index: sale.logIndex,
                        amount: "1",
                        price: sale.unitPrice,
                        currency: sale.currency,
                        from_address: sale.seller,
                        to_address: sale.buyer,
                    })),
                );

                const reader = new SqlitePriceHistoryRead([
                    {
                        address: zeroAddress,
                        symbol: PRICE_HISTORY_CURRENCY_SYMBOL.Eth,
                    },
                    {
                        address: WYVERN_FIXTURE_WETH,
                        symbol: PRICE_HISTORY_CURRENCY_SYMBOL.Weth,
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
                expect(observed).toHaveLength(expected.length);
                for (const sale of expected) {
                    expect(
                        observed.find(
                            (item) =>
                                item.tokenId === sale.tokenId &&
                                item.executionId ===
                                    fillExecutionIdentity(
                                        1,
                                        FILL_KIND.Wyvern,
                                        hash,
                                        sale.logIndex,
                                    ),
                        ),
                    ).toMatchObject({
                        unitPrice: {
                            numeratorWei: sale.grossPrice,
                            denominator: sale.nftQuantity,
                        },
                        quantity: "1",
                        attributedPriceWei: sale.unitPrice,
                        currencyAddress: sale.currency,
                        currencySymbol:
                            sale.currency === zeroAddress
                                ? PRICE_HISTORY_CURRENCY_SYMBOL.Eth
                                : PRICE_HISTORY_CURRENCY_SYMBOL.Weth,
                        seller: sale.seller,
                        buyer: sale.buyer,
                    });
                }
            }
        },
    );
});
