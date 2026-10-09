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
import {
    MigrationRunner,
    createMigrationRunner,
} from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { ACTIVITY_KIND, ACTIVITY_SOURCE_KIND } from "@artgod/shared/types";
import {
    FILL_KIND,
    FILL_PRICE_BASIS,
    summarizeFillPayment,
} from "@artgod/shared/market-data/fills";
import { PRICE_HISTORY_CURRENCY_SYMBOL } from "@artgod/shared/types/price-history";
import { AutomaticSyncExecutor } from "../src/application/automatic-sync-executor.js";
import { SyncGapScheduler } from "../src/application/sync-gap-scheduler.js";
import { createBackfillSyncHandler } from "../src/application/backfill-sync-handler.js";
import { drainQueueOutbox } from "../src/application/queue-outbox/drainer.js";
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
import { SqliteSyncRangeCommit } from "../src/infra/storage/sqlite-sync-range-commit.js";
import { SqliteReorgRecoveries } from "../src/infra/storage/sqlite-reorg-recoveries.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import { SqlitePriceHistoryRead } from "../../backend/src/infra/collections/sqlite-price-history-read.js";
import { insertCollection } from "./helpers/ownership-fixture.js";
import { readTxDump, toEnhancedTransaction } from "./helpers/tx-dumps.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";

// Filenames and legacy columns are deliberately asserted at the storage boundary.
const UPGRADE = "064_fill_execution_facts.sql";
const COVERAGE_RESET = "067_reset_collection_sale_coverage.sql";
const AUTOMATIC_SYNC_SCHEMA = new Set([
    "068_recent_gap_checks.sql",
    "069_newest_gap_priority.sql",
]);
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
            const balances = balanceOwnershipState();
            const transfersBefore = count("nft_transfer_events");
            await installUpgrade();
            await runner.runMigrations();
            // Runtime backfill starts after every current migration, not at the
            // isolated fill-adoption boundary used by the migration-only cases.
            await createMigrationRunner().runMigrations();
            const { outbox, gate, publish, handler } = replayServices(tx);
            const admission = vi.spyOn(gate, "run");
            const [job] = buildManualHistoricalBackfillJobs({
                chainId: 1,
                collectionId,
                fromBlock: tx.blockNumber,
                toBlock: tx.blockNumber,
                batchSize: 1,
                nonce: "upgrade-replay",
            });
            await handler(job!);
            expect(publish).not.toHaveBeenCalled();
            expect(saleCount()).toBe(0);
            await drainQueueOutbox(outbox, { publish });
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
            expect(balanceOwnershipState()).toEqual(balances);
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
            await drainQueueOutbox(outbox, { publish });
            expect(count("fills")).toBe(2);
            expect(count("fill_executions")).toBe(1);
            expect(
                db
                    .prepare(
                        "SELECT * FROM activities WHERE kind=? ORDER BY id",
                    )
                    .all(ACTIVITY_KIND.Sale),
            ).toEqual(recreated);
            expect(balanceOwnershipState()).toEqual(balances);
            // A later launch must never repeat the destructive adoption step.
            setDbPath(databasePath);
            await createMigrationRunner().runMigrations();
            expect(count("fills")).toBe(2);
            expect(saleCount()).toBe(2);
            expect(db.raw.pragma("foreign_key_check")).toEqual([]);
        },
    );

    describe("sale-history coverage reset", () => {
        async function prepareReset(normalized: boolean) {
            const collectionId = seedHistory({
                rows: normalized ? 2 : 0,
                postAnchor: true,
            });
            await installUpgrade();
            await runner.runMigrations();
            const source = resolveProjectPath("database/migrations");
            for (const name of await readdir(source))
                if (
                    name.endsWith(".sql") &&
                    name > UPGRADE &&
                    (name < COVERAGE_RESET || AUTOMATIC_SYNC_SCHEMA.has(name))
                )
                    await copyFile(
                        join(source, name),
                        join(migrationsDir, name),
                    );
            await runner.runMigrations();
            const services = replayServices(tx, tx.blockNumber + 1);
            if (normalized) {
                const [job] = buildManualHistoricalBackfillJobs({
                    chainId: 1,
                    collectionId,
                    fromBlock: tx.blockNumber,
                    toBlock: tx.blockNumber,
                    batchSize: 1,
                    nonce: "normalized-before-reset",
                });
                await services.handler(job!);
                await drainQueueOutbox(services.outbox, {
                    publish: services.publish,
                });
                expect(count("fills")).toBe(2);
            }
            // Include a different chain and a paused collection, not just active sales.
            const other = db
                .prepare(
                    "SELECT collection_id FROM collections WHERE chain_id=2",
                )
                .get() as { collection_id: number };
            db.prepare(
                "UPDATE collections SET status='paused' WHERE collection_id=?",
            ).run(other.collection_id);
            db.prepare(
                "INSERT INTO collection_sync_blocks(chain_id,collection_id,block_number) VALUES(2,?,?)",
            ).run(other.collection_id, tx.blockNumber);
            for (const [chainId, id] of [
                [1, collectionId],
                [2, other.collection_id],
            ])
                services.gaps.saveProgress({
                    chainId,
                    collectionId: id,
                    expected: services.gaps.getProgress(chainId, id),
                    progress: {
                        anchorBlock: tx.blockNumber - 1,
                        cursorBlock: tx.blockNumber,
                        lastHeadCheckAt: 1000,
                        pending: {
                            repairId: `old:${chainId}:${id}`,
                            fromBlock: tx.blockNumber,
                            toBlock: tx.blockNumber + 1,
                            retryAt: 999999,
                        },
                    },
                });
            return { collectionId, ...services };
        }
        async function installReset(fail = false) {
            const sql = await readFile(
                resolveProjectPath(`database/migrations/${COVERAGE_RESET}`),
                "utf8",
            );
            await writeFile(
                join(migrationsDir, COVERAGE_RESET),
                fail
                    ? `${sql}\nSELECT * FROM missing_coverage_reset_fixture;\n`
                    : sql,
            );
        }
        function protectedState() {
            return snapshotTables([
                "migrations",
                "collection_sync_blocks",
                "collection_sync_gap_scans",
            ]);
        }
        it.each([false, true])(
            "clears only coverage and scan state, preserving normalized fills=%s",
            async (normalized) => {
                const services = await prepareReset(normalized);
                const before = protectedState();
                await installReset();
                await runner.runMigrations();
                expect(count("collection_sync_blocks")).toBe(0);
                expect(count("collection_sync_gap_scans")).toBe(0);
                expect(protectedState()).toEqual(before);
                expect(db.raw.pragma("foreign_key_check")).toEqual([]);
                expect(db.raw.pragma("integrity_check", { simple: true })).toBe(
                    "ok",
                );
                // A later launch must keep any rebuilt coverage and scan progress.
                const coverage = db.prepare(
                    "INSERT INTO collection_sync_blocks(chain_id,collection_id,block_number) SELECT chain_id,collection_id,bootstrap_anchor_block FROM collections WHERE bootstrap_anchor_block IS NOT NULL",
                );
                coverage.run();
                services.gaps.saveProgress({
                    chainId: 1,
                    collectionId: services.collectionId,
                    expected: services.gaps.getProgress(
                        1,
                        services.collectionId,
                    ),
                    progress: {
                        anchorBlock: tx.blockNumber - 1,
                        cursorBlock: tx.blockNumber,
                        pending: null,
                        lastHeadCheckAt: 1000,
                    },
                });
                const resumed = snapshotTables(["migrations"]);
                setDbPath(databasePath);
                await runner.runMigrations();
                expect(snapshotTables(["migrations"])).toEqual(resumed);
            },
        );
        it("rolls back coverage, intent and ledger together and succeeds on retry", async () => {
            await prepareReset(true);
            const before = snapshotTables([]);
            await installReset(true);
            await expect(runner.runMigrations()).rejects.toThrow(
                "missing_coverage_reset_fixture",
            );
            expect(snapshotTables([])).toEqual(before);
            await installReset();
            await runner.runMigrations();
            expect(count("collection_sync_blocks")).toBe(0);
            expect(count("collection_sync_gap_scans")).toBe(0);
        });
        it.each([false, true])(
            "automatic repair starts at HEAD and rebuilds sales without changing balances, normalized=%s",
            async (normalized) => {
                const s = await prepareReset(normalized);
                const balances = balanceOwnershipState();
                const transfers = db
                    .prepare(
                        "SELECT * FROM nft_transfer_events ORDER BY collection_id,token_id,block_number",
                    )
                    .all();
                await installReset();
                await runner.runMigrations();
                const scanner = new SyncGapScheduler(s.registry, s.gaps, {
                    chainId: 1,
                    batchSize: 2,
                    now: () => 1000,
                });
                await scanner.scan(tx.blockNumber + 1);
                expect(
                    s.gaps.getProgress(1, s.collectionId)?.pending,
                ).toMatchObject({
                    fromBlock: tx.blockNumber,
                    toBlock: tx.blockNumber + 1,
                });
                await s.executor.runDue();
                await drainQueueOutbox(s.outbox, { publish: s.publish });
                expect(count("fill_executions")).toBe(1);
                expect(count("fills")).toBe(2);
                expect(saleCount()).toBe(2);
                await scanner.scan(tx.blockNumber + 1);
                await s.executor.runDue();
                expect(
                    s.storage.countCollectionSyncedBlocksInRange(
                        1,
                        s.collectionId,
                        tx.blockNumber - 1,
                        tx.blockNumber + 1,
                    ),
                ).toBe(3);
                expect(
                    s.storage.countCollectionSyncedBlocksInRange(
                        1,
                        s.collectionId,
                        1,
                        tx.blockNumber - 2,
                    ),
                ).toBe(0);
                expect(balanceOwnershipState()).toEqual(balances);
                expect(
                    db
                        .prepare(
                            "SELECT * FROM nft_transfer_events ORDER BY collection_id,token_id,block_number",
                        )
                        .all(),
                ).toEqual(transfers);
            },
        );
    });

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

function replayServices(tx: EnhancedTransaction, headBlock = tx.blockNumber) {
    const storage = new SqliteStorage();
    const registry = new SqliteCollectionRegistry();
    const outbox = new SqliteQueueOutbox();
    const gaps = new SqliteSyncGapStore();
    const recoveries = new SqliteReorgRecoveries(storage);
    const commit = new SqliteSyncRangeCommit({
        storage,
        outbox,
        gaps,
        recoveries,
        collections: registry,
    });
    const gate = new BackfillExecutionGate();
    const rpc = bundleRpc(tx, headBlock);
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
        workerCount: 2,
        wethAddress: zeroAddress,
        rpc,
        storage,
        commit,
        collectionsPort: registry,
        extensions: { getInstall: () => null },
        bidderIndex: { isActive: () => false, shouldEmit: () => false },
        gate,
    });
    const executor = new AutomaticSyncExecutor({
        chainId: 1,
        batchSize: 2,
        wethAddress: zeroAddress,
        rpc,
        storage,
        commit,
        collectionsPort: registry,
        collectionExtensions: { getInstall: () => null },
        bidderIndex: { isActive: () => false, shouldEmit: () => false },
        gate,
        gaps,
        recoveries,
        now: () => 1000,
        headGapRecheck: new SyncGapScheduler(registry, gaps, {
            chainId: 1,
            batchSize: 2,
            now: () => 1000,
        }),
    });
    return {
        storage,
        registry,
        gaps,
        outbox,
        gate,
        publish,
        handler,
        executor,
    };
}

function bundleRpc(
    tx: EnhancedTransaction,
    headBlock = tx.blockNumber,
): RpcProviderPort {
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
        getBlockNumber: async () => headBlock,
        getBlock: async (number) => {
            expect(number).toBeGreaterThanOrEqual(tx.blockNumber - 1);
            expect(number).toBeLessThanOrEqual(headBlock);
            if (number !== tx.blockNumber) {
                return {
                    ...syncBlockFixture(number),
                    parentHash:
                        number === tx.blockNumber + 1
                            ? (tx.blockHash as Hex)
                            : syncBlockFixture(number - 1).hash,
                    timestamp: TIMESTAMP + (number - tx.blockNumber) * 12,
                    transactions: [],
                };
            }
            return {
                number,
                hash: tx.blockHash as Hex,
                parentHash: syncBlockFixture(number - 1).hash,
                timestamp: TIMESTAMP,
                transactions: [tx.txHash as Hex],
            };
        },
        getLogs: async (filter) =>
            filter.fromBlock <= tx.blockNumber &&
            filter.toBlock >= tx.blockNumber &&
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
// Discovering an older transfer may refresh the projection's local updated_at.
// Ownership, quantity and every retained chain-provenance field must stay intact.
function balanceOwnershipState() {
    return db
        .prepare(
            "SELECT chain_id, collection_id, contract_address, token_id, owner, amount, " +
                "last_block_number, last_block_hash, last_block_timestamp, last_tx_hash, last_log_index " +
                "FROM nft_balances ORDER BY collection_id, token_id, owner",
        )
        .all();
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
    return snapshotTables([
        "fills",
        "activities",
        "migrations",
        "fill_executions",
        "fill_execution_items",
    ]);
}
function snapshotTables(excluded: string[]) {
    const tables = db
        .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[];
    return Object.fromEntries(
        tables
            .filter(({ name }) => !excluded.includes(name))
            .map(({ name }) => [
                name,
                db
                    .prepare(`SELECT * FROM "${name}"`)
                    .all()
                    .map((row) => JSON.stringify(row))
                    .sort(),
            ]),
    );
}
