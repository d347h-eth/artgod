import {
    copyFile,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress } from "viem";
import { db, setDbPath } from "@artgod/shared/database";
import { MigrationRunner } from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { ACTIVITY_KIND, ACTIVITY_SOURCE_KIND } from "@artgod/shared/types";
import {
    FILL_KIND,
    FILL_PRICE_BASIS,
    summarizeFillPayment,
} from "@artgod/shared/market-data/fills";
import { PRICE_HISTORY_CURRENCY_SYMBOL } from "@artgod/shared/types/price-history";
import { createBackfillSyncHandler } from "../src/application/backfill-sync-handler.js";
import {
    BACKFILL_EXECUTION_MODE,
    BackfillExecutionGate,
} from "../src/application/backfill-execution.js";
import { buildManualHistoricalBackfillJobs } from "../src/application/manual-backfill-trigger.js";
import { decodeSeaportFills } from "../src/application/fills/seaport.js";
import {
    DOMAIN_JOB_KIND,
    type DomainSyncPayload,
} from "../src/domain/domain-jobs.js";
import type {
    EnhancedTransaction,
    NftTransferEvent,
} from "../src/domain/onchain.js";
import { ORDER_SIDE, ORDER_STATUS } from "../src/domain/orders.js";
import type { Hex, RpcProviderPort } from "../src/ports/rpc.js";
import type { QueuePort } from "../src/ports/queue.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteActivityDomain } from "../src/infra/domain/activities.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { SqliteMarketDataMaintenance } from "../src/infra/storage/sqlite-market-data-maintenance.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import { SqliteReorgRecoveries } from "../src/infra/storage/sqlite-reorg-recoveries.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import { SqlitePriceHistoryRead } from "../../backend/src/infra/collections/sqlite-price-history-read.js";
import { insertCollection } from "./helpers/ownership-fixture.js";
import { readTxDump, toEnhancedTransaction } from "./helpers/tx-dumps.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";

// Filenames and legacy columns are deliberately asserted at the storage boundary.
const UPGRADE = "064_fill_execution_facts.sql";
const BUNDLE_FIXTURE =
    "0xf2581f8779cb451f662ea3bbc5f6051121c68e3ed653270505cee26315a4e478.json";
const CONTRACT = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const LATER_OWNER = "0x1111111111111111111111111111111111111111";
const TIMESTAMP = 1_700_000_000;

describe("fill execution schema adoption", () => {
    let databasePath: string;
    let migrationsDir: string;
    let runner: MigrationRunner;
    let tx: EnhancedTransaction;

    beforeEach(async () => {
        const root = resolveProjectPath("tmp/fill-execution-upgrades");
        await mkdir(root, { recursive: true });
        const run = await mkdtemp(join(root, "run-"));
        databasePath = join(run, "fixture.sqlite");
        migrationsDir = join(run, "migrations");
        await mkdir(migrationsDir);
        const source = resolveProjectPath("database/migrations");
        for (const name of await readdir(source))
            if (name.endsWith(".sql") && name < UPGRADE)
                await copyFile(join(source, name), join(migrationsDir, name));
        setDbPath(databasePath);
        runner = new MigrationRunner(migrationsDir);
        await runner.runMigrations();
        tx = toEnhancedTransaction(
            await readTxDump(import.meta.url, "fill-txs", BUNDLE_FIXTURE),
        );
    });

    async function installUpgrade(failAfterCutover = false) {
        const sql = await readFile(
            resolveProjectPath(`database/migrations/${UPGRADE}`),
            "utf8",
        );
        await writeFile(
            join(migrationsDir, UPGRADE),
            failAfterCutover
                ? `${sql}\nSELECT * FROM deliberately_missing_upgrade_fixture;\n`
                : sql,
        );
    }

    it.each([0, 50_000])(
        "retires %i legacy fills and every sale source, preserving unrelated state",
        async (rows) => {
            seedHistory({ rows, postAnchor: true });
            const protectedState = snapshotOtherTables();
            const keptActivities = nonSaleActivities();
            await installUpgrade();
            await runner.runMigrations();
            expect(count("fills")).toBe(0);
            expect(count("fill_executions")).toBe(0);
            expect(count("fill_execution_items")).toBe(0);
            expect(saleCount()).toBe(0);
            expect(nonSaleActivities()).toEqual(keptActivities);
            expect(snapshotOtherTables()).toEqual(protectedState);
            expect(db.raw.pragma("table_info(fill_executions)")).not.toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: "raw_json" }),
                ]),
            );
            expect(appliedUpgrade()).toBe(true);
            expect(db.raw.pragma("foreign_key_check")).toEqual([]);
            expect(db.raw.pragma("integrity_check", { simple: true })).toBe(
                "ok",
            );
            setDbPath(databasePath);
            await runner.runMigrations();
            expect(snapshotOtherTables()).toEqual(protectedState);
            expect(nonSaleActivities()).toEqual(keptActivities);
        },
    );

    it("does not resurrect retired sales when an interrupted market-data copy resumes", async () => {
        seedHistory({ rows: 2, postAnchor: true });
        const kept = nonSaleActivities();
        const maintenance = new SqliteMarketDataMaintenance(
            db,
            () => Number.MAX_SAFE_INTEGER,
        );
        maintenance.recoverBatch(TIMESTAMP);
        maintenance.recoverBatch(TIMESTAMP);
        expect(count("market_rebuild_activities")).toBeGreaterThan(kept.length);
        const copiedSales = (
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM market_rebuild_activities WHERE kind=?",
                )
                .get(ACTIVITY_KIND.Sale) as { count: number }
        ).count;
        const removedBefore = maintenance.inspect().removedRows;
        await installUpgrade();
        await runner.runMigrations();
        expect(saleCount()).toBe(0);
        maintenance.recoverBatch(TIMESTAMP);
        expect(saleCount()).toBe(0);
        expect(nonSaleActivities()).toEqual(kept);
        expect(maintenance.inspect().removedRows).toBe(
            removedBefore + copiedSales,
        );
        expect(
            db
                .prepare(
                    "SELECT name FROM sqlite_schema WHERE name='market_rebuild_activities'",
                )
                .get(),
        ).toBeUndefined();
    });

    it("rolls back cleanup, schema and migration ledger together, then succeeds on retry", async () => {
        seedHistory({ rows: 2, postAnchor: true });
        const before = snapshotOtherTables();
        const oldFills = db.prepare("SELECT * FROM fills ORDER BY id").all();
        const oldActivities = db
            .prepare("SELECT * FROM activities ORDER BY id")
            .all();
        await installUpgrade(true);
        await expect(runner.runMigrations()).rejects.toThrow(
            "deliberately_missing_upgrade_fixture",
        );
        expect(appliedUpgrade()).toBe(false);
        expect(db.prepare("SELECT * FROM fills ORDER BY id").all()).toEqual(
            oldFills,
        );
        expect(
            db.prepare("SELECT * FROM activities ORDER BY id").all(),
        ).toEqual(oldActivities);
        expect(snapshotOtherTables()).toEqual(before);
        expect(
            db
                .prepare(
                    "SELECT name FROM sqlite_schema WHERE name='fill_executions'",
                )
                .get(),
        ).toBeUndefined();
        setDbPath(databasePath);
        await installUpgrade();
        await runner.runMigrations();
        expect(count("fills")).toBe(0);
        expect(saleCount()).toBe(0);
        expect(snapshotOtherTables()).toEqual(before);
    });

    it.each([
        { label: "pre-anchor", postAnchor: false, missingTransfer: false },
        {
            label: "post-anchor with existing transfers",
            postAnchor: true,
            missingTransfer: false,
        },
        {
            label: "post-anchor with a missing older transfer",
            postAnchor: true,
            missingTransfer: true,
        },
    ])(
        "normal backfill rebuilds bundle sales $label without reverting balances",
        async ({ postAnchor, missingTransfer }) => {
            const collectionId = seedHistory({
                rows: 2,
                postAnchor,
                missingTransfer,
            });
            const balances = db
                .prepare(
                    "SELECT * FROM nft_balances ORDER BY collection_id, token_id, owner",
                )
                .all();
            const transfersBefore = count("nft_transfer_events");
            await installUpgrade();
            await runner.runMigrations();
            const storage = new SqliteStorage();
            const registry = new SqliteCollectionRegistry();
            const gate = new BackfillExecutionGate();
            const admission = vi.spyOn(gate, "run");
            const rpc = bundleRpc(tx);
            const activities = new SqliteActivityDomain([zeroAddress]);
            const publish = vi.fn<QueuePort["publish"]>(async (_queue, job) => {
                if (job.kind === DOMAIN_JOB_KIND.ActivitySync)
                    await activities.handleDomainSync({
                        ...(job.payload as DomainSyncPayload),
                        chainId: job.chainId!,
                        collectionId: job.collectionId!,
                    });
            });
            const handler = createBackfillSyncHandler({
                chainId: 1,
                batchSize: 1,
                workerCount: 2,
                wethAddress: zeroAddress,
                rpc,
                storage,
                collectionsPort: registry,
                extensions: { getInstall: () => null },
                queue: { publish },
                bidderIndex: { isActive: () => false, shouldEmit: () => false },
                gaps: new SqliteSyncGapStore(),
                recoveries: new SqliteReorgRecoveries(
                    storage,
                    new SqliteQueueOutbox(),
                ),
                gate,
            });
            const [job] = buildManualHistoricalBackfillJobs({
                chainId: 1,
                collectionId,
                fromBlock: tx.blockNumber,
                toBlock: tx.blockNumber,
                batchSize: 1,
                nonce: "upgrade-replay",
            });
            await handler(job!);
            expect(admission.mock.calls[0][0]).toBe(
                postAnchor
                    ? BACKFILL_EXECUTION_MODE.SerializedCurrentState
                    : BACKFILL_EXECUTION_MODE.ParallelFactsOnly,
            );
            expect(count("fill_executions")).toBe(1);
            expect(count("fills")).toBe(2);
            const fills = decodeSeaportFills(tx, new Set([CONTRACT]));
            expect(count("fill_execution_items")).toBe(
                fills[0]!.execution.items.length,
            );
            expect(saleCount()).toBe(2);
            expect(count("nft_transfer_events")).toBe(
                transfersBefore + (missingTransfer ? 1 : 0),
            );
            expect(
                db
                    .prepare(
                        "SELECT * FROM nft_balances ORDER BY collection_id, token_id, owner",
                    )
                    .all(),
            ).toEqual(balances);
            const reader = new SqlitePriceHistoryRead([
                {
                    address: zeroAddress,
                    symbol: PRICE_HISTORY_CURRENCY_SYMBOL.Eth,
                },
            ]);
            const observations = [
                ...reader.iterateObservations({
                    chainId: 1,
                    collectionId,
                    from: 0,
                    to: 2_147_483_647,
                    limit: 10,
                }),
            ];
            expect(observations).toHaveLength(2);
            expect(observations[0]).toMatchObject({
                executionNftQuantity: "2",
                priceBasis: FILL_PRICE_BASIS.BundleAverage,
                unitPrice: { numeratorWei: "100000000000", denominator: "2" },
            });
            expect(
                observations.reduce((total, sale) => {
                    if (!("attributedPriceWei" in sale))
                        throw new Error("Expected a priced bundle observation");
                    return total + BigInt(sale.attributedPriceWei);
                }, 0n),
            ).toBe(100000000000n);
            const recreated = db
                .prepare("SELECT * FROM activities WHERE kind=? ORDER BY id")
                .all(ACTIVITY_KIND.Sale);
            await handler(job!);
            expect(count("fills")).toBe(2);
            expect(count("fill_executions")).toBe(1);
            expect(
                db
                    .prepare(
                        "SELECT * FROM activities WHERE kind=? ORDER BY id",
                    )
                    .all(ACTIVITY_KIND.Sale),
            ).toEqual(recreated);
            expect(
                db
                    .prepare(
                        "SELECT * FROM nft_balances ORDER BY collection_id, token_id, owner",
                    )
                    .all(),
            ).toEqual(balances);
            // A later launch must never repeat the destructive adoption step.
            setDbPath(databasePath);
            await runner.runMigrations();
            expect(count("fills")).toBe(2);
            expect(saleCount()).toBe(2);
            expect(db.raw.pragma("foreign_key_check")).toEqual([]);
        },
    );

    function seedHistory(input: {
        rows: number;
        postAnchor: boolean;
        missingTransfer?: boolean;
    }): number {
        const collectionId = insertCollection({
            chainId: 1,
            slug: "fill-upgrade",
            address: CONTRACT,
            anchorBlock: tx.blockNumber + (input.postAnchor ? -1 : 1),
        });
        const otherCollection = insertCollection({
            chainId: 2,
            slug: "fill-upgrade-other-chain",
            address: CONTRACT,
            anchorBlock: tx.blockNumber - 1,
        });
        const fills = decodeSeaportFills(tx, new Set([CONTRACT]));
        const payment = summarizeFillPayment(fills[0]!.execution.items);
        const transfers = tx.events.filter(
            (event) => event.base.contract === CONTRACT,
        );
        db.writeTransaction(() => {
            db.prepare(
                "INSERT INTO blocks(chain_id,block_number,block_hash,parent_hash,timestamp) VALUES(1,?,?,?,?)",
            ).run(
                tx.blockNumber,
                tx.blockHash,
                syncBlockFixture(tx.blockNumber - 1).hash,
                TIMESTAMP,
            );
            db.prepare(
                "INSERT INTO collection_sync_blocks(chain_id,collection_id,block_number) VALUES(1,?,?)",
            ).run(collectionId, tx.blockNumber);
            db.prepare(
                "INSERT INTO transactions(chain_id,tx_hash,from_address,to_address,input,block_number,block_hash,block_timestamp) VALUES(1,?,?,?,?,?,?,?)",
            ).run(
                tx.txHash,
                tx.transaction.from,
                tx.transaction.to,
                tx.transaction.input,
                tx.blockNumber,
                tx.blockHash,
                TIMESTAMP,
            );
            const transferInsert = db.prepare(
                "INSERT INTO nft_transfer_events(chain_id,collection_id,contract_address,from_address,to_address,token_id,amount,block_number,block_hash,block_timestamp,tx_hash,log_index,kind) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)",
            );
            const balanceInsert = db.prepare(
                "INSERT INTO nft_balances(chain_id,collection_id,contract_address,token_id,owner,amount,last_block_number,last_block_hash,last_block_timestamp,last_tx_hash,last_log_index) VALUES(1,?,?,?,?,?,?,?,?,?,?)",
            );
            for (const [index, event] of transfers.entries()) {
                const leg = event.decoded;
                if (!(input.missingTransfer && index === 0))
                    transferInsert.run(
                        collectionId,
                        CONTRACT,
                        leg.from.toLowerCase(),
                        leg.to.toLowerCase(),
                        leg.tokenId,
                        leg.amount,
                        tx.blockNumber,
                        tx.blockHash,
                        TIMESTAMP,
                        tx.txHash,
                        event.base.logIndex,
                        event.kind,
                    );
                balanceInsert.run(
                    collectionId,
                    CONTRACT,
                    leg.tokenId,
                    leg.to.toLowerCase(),
                    leg.amount,
                    tx.blockNumber,
                    tx.blockHash,
                    TIMESTAMP,
                    tx.txHash,
                    event.base.logIndex,
                );
            }
            db.prepare(
                "INSERT INTO app_settings(key,value) VALUES('fill-upgrade-preservation','keep')",
            ).run();
            db.prepare(
                "INSERT INTO tokens(chain_id,collection_id,contract_address,token_id) VALUES(1,?,?,'8314')",
            ).run(collectionId, CONTRACT);
            db.prepare(
                "INSERT INTO token_metadata(chain_id,collection_id,contract_address,token_id,name,image) VALUES(1,?,?,'8314','Keep artwork','ipfs://keep')",
            ).run(collectionId, CONTRACT);
            db.prepare(
                "INSERT INTO orders(id,chain_id,collection_id,kind,side,maker,contract_address,token_id,price,currency,fillability_status,valid_until) VALUES('keep-order',1,?,?,?,?,?,'8314','12',?,?,2147483647)",
            ).run(
                collectionId,
                FILL_KIND.Seaport,
                ORDER_SIDE.Sell,
                tx.transaction.from.toLowerCase(),
                CONTRACT,
                zeroAddress,
                ORDER_STATUS.Fillable,
            );
            const insertFill = db.prepare(
                "INSERT INTO fills(chain_id,collection_id,kind,contract_address,token_id,amount,price,currency,block_number,block_hash,block_timestamp,tx_hash,log_index,price_nft_count) VALUES(@chain,@collection,@kind,@contract,@token,'1',@price,@currency,@block,@hash,@timestamp,@tx,@log,'2')",
            );
            const insertActivity = db.prepare(
                "INSERT INTO activities(chain_id,collection_id,scope_kind,kind,contract_address,token_id,occurred_at,source_kind,source_name,price,currency,dedupe_key,listing_day,listing_price_at) VALUES(@chain,@collection,'token',@kind,@contract,'8314',@timestamp,@sourceKind,@sourceName,@price,@currency,@key,@day,@listingPriceAt)",
            );
            const base = {
                chain: 1,
                collection: collectionId,
                contract: CONTRACT,
                timestamp: TIMESTAMP,
                currency: zeroAddress,
                price: payment.totalPrice,
                day: null,
                listingPriceAt: null,
            };
            for (let index = 0; index < input.rows; index++) {
                const fill = fills[index % fills.length]!;
                const chain = index % 2 ? 2 : 1;
                const collection = chain === 1 ? collectionId : otherCollection;
                insertFill.run({
                    ...base,
                    chain,
                    collection,
                    kind: FILL_KIND.Seaport,
                    token: fill.tokenId,
                    block: tx.blockNumber,
                    hash: tx.blockHash,
                    tx: tx.txHash,
                    log: fill.logIndex + index,
                });
                insertActivity.run({
                    ...base,
                    chain,
                    collection,
                    kind: ACTIVITY_KIND.Sale,
                    sourceKind: ACTIVITY_SOURCE_KIND.Onchain,
                    sourceName: FILL_KIND.Seaport,
                    key: `legacy-sale:${index}`,
                });
            }
            // All sale rows are retired, including unmatched rows from other sources.
            for (const sourceKind of Object.values(ACTIVITY_SOURCE_KIND))
                insertActivity.run({
                    ...base,
                    chain: 2,
                    collection: otherCollection,
                    kind: ACTIVITY_KIND.Sale,
                    sourceKind,
                    sourceName: "unmatched-sale",
                    key: `unmatched:${sourceKind}`,
                });
            for (const kind of [
                ACTIVITY_KIND.Transfer,
                ACTIVITY_KIND.ListingCreated,
                ACTIVITY_KIND.Custom,
            ])
                insertActivity.run({
                    ...base,
                    kind,
                    sourceKind: ACTIVITY_SOURCE_KIND.Onchain,
                    sourceName: "keep",
                    key: `keep:${kind}`,
                    day:
                        kind === ACTIVITY_KIND.ListingCreated
                            ? Math.floor(TIMESTAMP / 86400)
                            : null,
                    listingPriceAt:
                        kind === ACTIVITY_KIND.ListingCreated
                            ? TIMESTAMP
                            : null,
                });
        })();
        if (input.postAnchor) {
            // Realtime already moved this NFT again after the sale being replayed.
            const earlier = transfers[0]!;
            const later = syncBlockFixture(tx.blockNumber + 1);
            const event: NftTransferEvent = {
                collectionId,
                contract: CONTRACT,
                tokenId: earlier.decoded.tokenId,
                from: earlier.decoded.to.toLowerCase(),
                to: LATER_OWNER,
                amount: "1",
                kind: earlier.kind,
                blockNumber: later.number,
                blockHash: later.hash,
                txHash: later.hash,
                logIndex: 1,
            };
            // Seed the persisted legacy boundary; the new writer cannot prepare
            // execution-table statements until this migration has been applied.
            db.prepare(
                "INSERT INTO blocks(chain_id,block_number,block_hash,parent_hash,timestamp) VALUES(1,?,?,?,?)",
            ).run(later.number, later.hash, tx.blockHash, TIMESTAMP + 12);
            db.prepare(
                "INSERT INTO collection_sync_blocks(chain_id,collection_id,block_number) VALUES(1,?,?)",
            ).run(collectionId, later.number);
            db.prepare(
                "INSERT INTO nft_transfer_events(chain_id,collection_id,contract_address,from_address,to_address,token_id,amount,block_number,block_hash,block_timestamp,tx_hash,log_index,kind) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)",
            ).run(
                collectionId,
                CONTRACT,
                event.from,
                event.to,
                event.tokenId,
                event.amount,
                event.blockNumber,
                event.blockHash,
                TIMESTAMP + 12,
                event.txHash,
                event.logIndex,
                event.kind,
            );
            db.prepare(
                "UPDATE nft_balances SET owner=?,last_block_number=?,last_block_hash=?,last_block_timestamp=?,last_tx_hash=?,last_log_index=? WHERE collection_id=? AND token_id=?",
            ).run(
                LATER_OWNER,
                event.blockNumber,
                event.blockHash,
                TIMESTAMP + 12,
                event.txHash,
                event.logIndex,
                collectionId,
                event.tokenId,
            );
        }
        return collectionId;
    }
});

function bundleRpc(tx: EnhancedTransaction): RpcProviderPort {
    const transferIndices = new Set(
        tx.events
            .filter((event) => event.base.contract === CONTRACT)
            .map((event) => event.base.logIndex),
    );
    const transferLogs = tx.receiptLogs.filter((log) =>
        transferIndices.has(log.logIndex),
    );
    const unexpected = async () => {
        throw new Error("Unexpected RPC call in stored-history replay");
    };
    return {
        getBlockNumber: async () => tx.blockNumber,
        getBlock: async (number) => {
            expect(number).toBe(tx.blockNumber);
            return {
                number,
                hash: tx.blockHash as Hex,
                parentHash: syncBlockFixture(number - 1).hash,
                timestamp: TIMESTAMP,
                transactions: [tx.txHash as Hex],
            };
        },
        getLogs: async (filter) =>
            filter.events?.some((event) => event.name === "Transfer")
                ? transferLogs
                : [],
        getTransaction: async () => ({
            ...tx.transaction,
            hash: tx.txHash as Hex,
            from: tx.transaction.from as Hex,
            to: tx.transaction.to as Hex | null,
        }),
        getTransactionReceipt: async () => ({
            transactionHash: tx.txHash as Hex,
            logs: tx.receiptLogs,
        }),
        readContract: unexpected,
        readContractAtBlock: unexpected,
        getBalance: unexpected,
    };
}

function count(table: string): number {
    return (
        db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
            count: number;
        }
    ).count;
}
function saleCount(): number {
    return (
        db
            .prepare("SELECT COUNT(*) AS count FROM activities WHERE kind=?")
            .get(ACTIVITY_KIND.Sale) as { count: number }
    ).count;
}
function nonSaleActivities() {
    return db
        .prepare("SELECT * FROM activities WHERE kind<>? ORDER BY id")
        .all(ACTIVITY_KIND.Sale);
}
function appliedUpgrade(): boolean {
    return Boolean(
        db.prepare("SELECT name FROM migrations WHERE name=?").get(UPGRADE),
    );
}
function snapshotOtherTables() {
    const tables = db
        .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('fills','activities','migrations','fill_executions','fill_execution_items') ORDER BY name",
        )
        .all() as { name: string }[];
    return Object.fromEntries(
        tables.map(({ name }) => [
            name,
            db
                .prepare(`SELECT * FROM "${name}"`)
                .all()
                .map((row) => JSON.stringify(row))
                .sort(),
        ]),
    );
}
