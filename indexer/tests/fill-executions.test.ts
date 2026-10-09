import { FINALIZED_SYNC_CHECK_POLICY } from "./helpers/chain-fixture.js";
import { beforeAll, beforeEach, expect, it } from "vitest";
import {
    decodeAbiParameters,
    encodeAbiParameters,
    parseAbiParameters,
    zeroAddress,
} from "viem";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import {
    FILL_PRICE_EXCLUSION,
    FILL_PRICE_BASIS,
    summarizeFillPayment,
    FILL_ITEM_SIDE,
    FILL_ITEM_TYPE,
} from "@artgod/shared/market-data/fills";
import { ACTIVITY_KIND } from "../src/domain/activities.js";
import { DOMAIN_SYNC_PROJECTION } from "../src/domain/domain-jobs.js";
import { SqliteActivityDomain } from "../src/infra/domain/activities.js";
import { decodeSeaportFills } from "../src/application/fills/seaport.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import type { FillEvent } from "../src/domain/onchain.js";
import { readTxDump, toEnhancedTransaction } from "./helpers/tx-dumps.js";
import { emptyOnChainData } from "./helpers/ownership-fixture.js";
import { commitRollbackFixture } from "./helpers/rollback-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { SqlitePriceHistoryRead } from "../../backend/src/infra/collections/sqlite-price-history-read.js";
import { buildRealizedPriceHistory } from "../../backend/src/domain/realized-price-history.js";
import {
    PRICE_HISTORY_BUCKET,
    PRICE_HISTORY_RANGE,
    PRICE_HISTORY_CURRENCY_SYMBOL,
} from "@artgod/shared/types/price-history";

const BUNDLE_FIXTURE =
    "0xf2581f8779cb451f662ea3bbc5f6051121c68e3ed653270505cee26315a4e478.json";
const CONTRACT = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const OTHER = "0x1111111111111111111111111111111111111111" as const;
// Deliberately assert the event's serialization at the protocol wire boundary.
const EVENT_DATA = parseAbiParameters(
    "bytes32 orderHash, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration",
);
async function bundle() {
    return toEnhancedTransaction(
        await readTxDump(import.meta.url, "fill-txs", BUNDLE_FIXTURE),
    );
}

it("retains untracked bundle items before collection attribution", async () => {
    const tx = await bundle();
    const original = decodeSeaportFills(tx, new Set([CONTRACT]));
    expect(original).toHaveLength(2);
    expect(summarizeFillPayment(original[0]!.execution.items).nftQuantity).toBe(
        "2",
    );
    const log = tx.receiptLogs.find(
        (candidate) => candidate.logIndex === original[0]!.logIndex,
    )!;
    const [hash, recipient, offer, consideration] = decodeAbiParameters(
        EVENT_DATA,
        log.data,
    );
    log.data = encodeAbiParameters(EVENT_DATA, [
        hash,
        recipient,
        offer.map((item, i) => (i === 1 ? { ...item, token: OTHER } : item)),
        consideration,
    ]);
    const fills = decodeSeaportFills(tx, new Set([CONTRACT]));
    expect(fills).toHaveLength(1);
    expect(
        fills[0]!.execution.items
            .filter((i) => i.itemType >= 2)
            .map((i) => i.contract),
    ).toEqual([CONTRACT, OTHER]);
    expect(summarizeFillPayment(fills[0]!.execution.items).nftQuantity).toBe(
        "2",
    );
});

it("retains swap and mixed payment facts without fabricating prices", async () => {
    for (const shape of ["swap", "mixed"] as const) {
        const tx = await bundle();
        const original = decodeSeaportFills(tx, new Set([CONTRACT]));
        const log = tx.receiptLogs.find(
            (l) => l.logIndex === original[0]!.logIndex,
        )!;
        const [hash, recipient, offer, consideration] = decodeAbiParameters(
            EVENT_DATA,
            log.data,
        );
        const extra = {
            ...consideration[0]!,
            itemType: shape === "swap" ? 2 : 1,
            token: OTHER,
            identifier: 7n,
            amount: 1n,
        };
        log.data = encodeAbiParameters(EVENT_DATA, [
            hash,
            recipient,
            offer,
            [...consideration, extra],
        ]);
        const fills = decodeSeaportFills(tx, new Set([CONTRACT]));
        expect(fills).toHaveLength(2);
        expect(fills[0]!.price).toBeUndefined();
        expect(summarizeFillPayment(fills[0]!.execution.items).exclusion).toBe(
            shape === "swap"
                ? FILL_PRICE_EXCLUSION.Swap
                : FILL_PRICE_EXCLUSION.MixedPayment,
        );
    }
});

it("keeps repeated NFT identifiers as distinct raw item identities", async () => {
    const tx = await bundle();
    const original = decodeSeaportFills(tx, new Set([CONTRACT]));
    const log = tx.receiptLogs.find(
        (l) => l.logIndex === original[0]!.logIndex,
    )!;
    const [hash, recipient, offer, consideration] = decodeAbiParameters(
        EVENT_DATA,
        log.data,
    );
    log.data = encodeAbiParameters(EVENT_DATA, [
        hash,
        recipient,
        offer.map((item) => ({
            ...item,
            itemType: 3,
            identifier: offer[0]!.identifier,
        })),
        consideration,
    ]);
    const fills = decodeSeaportFills(tx, new Set([CONTRACT]));
    expect(fills).toHaveLength(2);
    expect(new Set(fills.map((f) => f.tokenId)).size).toBe(1);
    expect(fills.map((f) => f.executionItemIndex)).toEqual([0, 1]);
});

beforeAll(async () => {
    const root = resolveProjectPath("tmp/fill-executions");
    mkdirSync(root, { recursive: true });
    setDbPath(join(mkdtempSync(join(root, "run-")), "fixture.sqlite"));
    await createMigrationRunner().runMigrations();
});
beforeEach(() => db.exec("DELETE FROM fill_executions; DELETE FROM blocks"));

async function attributedBundle(): Promise<FillEvent[]> {
    return decodeSeaportFills(await bundle(), new Set([CONTRACT])).map((f) => ({
        ...f,
        collectionId: 1,
        blockNumber: 1,
        blockHash: syncBlockFixture(1).hash,
    }));
}
function persist(fills: FillEvent[]) {
    const storage = new SqliteStorage();
    const data = emptyOnChainData();
    data.collectionScoped.fillEvents = fills;
    storage.persistSyncResult({
        canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
        checkpoint: storage.captureSyncCheckpoint(1),
        blocks: [syncBlockFixture(1)],
        data,
        collections: [],
    });
    return storage;
}

it("writes complete execution context atomically and idempotently, and rolls it all back", async () => {
    const fills = await attributedBundle();
    const storage = persist(fills);
    persist(fills);
    expect(
        db.prepare("SELECT COUNT(*) AS n FROM fill_executions").get(),
    ).toEqual({ n: 1 });
    expect(
        db.prepare("SELECT COUNT(*) AS n FROM fill_execution_items").get(),
    ).toEqual({ n: fills[0]!.execution.items.length });
    expect(db.prepare("SELECT COUNT(*) AS n FROM fills").get()).toEqual({
        n: 2,
    });
    expect(
        db
            .prepare(
                "SELECT amount,unit_offset FROM fill_execution_items WHERE item_type>=2 ORDER BY item_index",
            )
            .all(),
    ).toEqual([
        { amount: "1", unit_offset: "0" },
        { amount: "1", unit_offset: "1" },
    ]);
    commitRollbackFixture({ storage, chainId: 1, fromBlock: 1, owners: [] });
    for (const table of ["fill_executions", "fill_execution_items", "fills"])
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({
            n: 0,
        });
});

it("rejects contradictory item attribution and immutable execution replays without partial writes", async () => {
    const fills = await attributedBundle();
    expect(() => persist([{ ...fills[0]!, tokenId: "999" }])).toThrow(
        "contradicts",
    );
    expect(
        db.prepare("SELECT COUNT(*) AS n FROM fill_executions").get(),
    ).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM blocks").get()).toEqual({
        n: 0,
    });
    persist(fills);
    const altered = {
        ...fills[0]!,
        execution: {
            ...fills[0]!.execution,
            items: fills[0]!.execution.items.map((item, index) =>
                index === 1 ? { ...item, recipient: OTHER } : item,
            ),
        },
    };
    expect(() => persist([altered])).toThrow("Conflicting immutable");
    expect(db.prepare("SELECT COUNT(*) AS n FROM fills").get()).toEqual({
        n: 2,
    });
    expect(() =>
        persist([
            {
                ...fills[0]!,
                execution: {
                    ...fills[0]!.execution,
                    protocolAddress: OTHER,
                },
            },
        ]),
    ).toThrow("Conflicting immutable");
});

it("compares normalized execution facts independently of object property order", async () => {
    const fills = await attributedBundle();
    const execution = {
        items: fills[0]!.execution.items.map(
            ({
                recipient,
                amount,
                identifier,
                contract,
                itemType,
                side,
                index,
            }) => ({
                recipient,
                amount,
                identifier,
                contract,
                itemType,
                side,
                index,
            }),
        ),
        protocolAddress: fills[0]!.execution.protocolAddress,
    };
    // Distinct but equal contexts can occur both in one write and across replays.
    persist([{ ...fills[0]!, execution }, fills[1]!]);
    persist(fills);
    expect(db.prepare("SELECT COUNT(*) AS n FROM fills").get()).toEqual({
        n: 2,
    });
});

it("feeds real decoded bundle facts through storage into exact chart observations", async () => {
    persist(await attributedBundle());
    const reader = new SqlitePriceHistoryRead([
        {
            address: "0x0000000000000000000000000000000000000000",
            symbol: PRICE_HISTORY_CURRENCY_SYMBOL.Eth,
        },
    ]);
    const request = {
        chainId: 1,
        collectionId: 1,
        from: 0,
        to: 1000000,
        limit: 10,
    };
    const history = buildRealizedPriceHistory(
        reader.iterateObservations(request),
        { bucket: PRICE_HISTORY_BUCKET.Day, range: PRICE_HISTORY_RANGE.All },
        request.to,
    );
    expect(history.sales.map((sale) => sale.tokenId)).toEqual(["8314", "1546"]);
    for (const sale of history.sales)
        expect(sale).toMatchObject({
            unitPrice: { numeratorWei: "100000000000", denominator: "2" },
            attributedPriceWei: "50000000000",
            priceBasis: FILL_PRICE_BASIS.BundleAverage,
        });
    expect(history.buckets[0]).toMatchObject({
        volume: "2",
        turnoverWei: "100000000000",
    });
    expect([
        ...reader.iterateObservations({ ...request, tokenId: "1546" }),
    ]).toEqual([history.sales[1]]);
});

it.each([false, true])(
    "prices forwarded bundles once through storage, activities and filtered history (untracked quantity: %s)",
    async (withUntracked) => {
        db.prepare("DELETE FROM activities WHERE kind=?").run(
            ACTIVITY_KIND.Sale,
        );
        const tx = await bundle();
        const original = decodeSeaportFills(tx, new Set([CONTRACT]));
        const log = tx.receiptLogs.find(
            (l) => l.logIndex === original[0]!.logIndex,
        )!;
        const [hash, recipient, offer, consideration] = decodeAbiParameters(
            EVENT_DATA,
            log.data,
        );
        const nfts = withUntracked
            ? [
                  ...offer,
                  {
                      ...offer[0]!,
                      token: OTHER,
                      itemType: FILL_ITEM_TYPE.Erc1155,
                      amount: 2n,
                  },
              ]
            : offer;
        log.data = encodeAbiParameters(EVENT_DATA, [
            hash,
            recipient,
            nfts,
            [
                ...consideration.map((item, index) => ({
                    ...item,
                    amount: index === 0 ? 7n : 0n,
                })),
                ...nfts.map((item) => ({ ...item, recipient })),
            ],
        ]);
        const fills = decodeSeaportFills(tx, new Set([CONTRACT])).map(
            (fill) => ({
                ...fill,
                collectionId: 1,
                blockNumber: 1,
                blockHash: syncBlockFixture(1).hash,
            }),
        );
        expect(fills).toHaveLength(2);
        persist(fills);
        persist(fills);
        expect(db.prepare("SELECT COUNT(*) AS n FROM fills").get()).toEqual({
            n: 2,
        });
        const units = withUntracked ? "4" : "2";
        expect(
            db
                .prepare(
                    "SELECT total_price, nft_quantity, price_exclusion FROM fill_executions",
                )
                .get(),
        ).toEqual({
            total_price: "7",
            nft_quantity: units,
            price_exclusion: null,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM fill_execution_items WHERE item_type>=?",
                )
                .get(FILL_ITEM_TYPE.Erc721),
        ).toEqual({
            n: nfts.length * 2,
        });
        expect(
            db
                .prepare(
                    `SELECT i.side FROM fills f JOIN fill_execution_items i
            ON i.execution_id=f.execution_id AND i.item_index=f.item_index`,
                )
                .all(),
        ).toEqual([
            { side: FILL_ITEM_SIDE.Offer },
            { side: FILL_ITEM_SIDE.Offer },
        ]);
        const activities = new SqliteActivityDomain([zeroAddress]);
        for (let attempt = 0; attempt < 2; attempt++)
            await activities.handleDomainSync({
                chainId: 1,
                collectionId: 1,
                fromBlock: 1,
                toBlock: 1,
                mode: "backfill",
                projection: DOMAIN_SYNC_PROJECTION.FactsOnly,
                sourceJobId: "forwarded-bundle-regression",
                sourceKind: "test",
            });
        const reader = new SqlitePriceHistoryRead([
            { address: zeroAddress, symbol: PRICE_HISTORY_CURRENCY_SYMBOL.Eth },
        ]);
        const request = {
            chainId: 1,
            collectionId: 1,
            from: 0,
            to: 1000000,
            limit: 10,
        };
        const history = buildRealizedPriceHistory(
            reader.iterateObservations(request),
            {
                bucket: PRICE_HISTORY_BUCKET.Day,
                range: PRICE_HISTORY_RANGE.All,
            },
            request.to,
        );
        expect(history.sales).toHaveLength(2);
        const prices = withUntracked ? ["2", "2"] : ["4", "3"];
        expect(history.sales.map((sale) => sale.attributedPriceWei)).toEqual(
            prices,
        );
        expect(history.sales.map((sale) => sale.unitPrice)).toEqual([
            { numeratorWei: "7", denominator: units },
            { numeratorWei: "7", denominator: units },
        ]);
        expect(history.buckets[0]).toMatchObject({
            volume: "2",
            turnoverWei: withUntracked ? "4" : "7",
        });
        expect([
            ...reader.iterateObservations({ ...request, tokenId: "1546" }),
        ]).toEqual([history.sales[1]]);
        expect(
            db
                .prepare(
                    "SELECT price FROM activities WHERE kind=? ORDER BY id",
                )
                .all(ACTIVITY_KIND.Sale),
        ).toEqual(prices.map((price) => ({ price })));
    },
);
