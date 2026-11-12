import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { zeroAddress } from "viem";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    NFT111K_EXTENSION_KEY,
    NFT111K_MAINNET_CHAIN_ID as CHAIN_ID,
    NFT111K_MAINNET_CONTRACT_ADDRESS as CONTRACT,
    NFT111K_MAINNET_DEPLOYMENT_BLOCK,
} from "@artgod/shared/extensions/111k";
import { COLLECTION_TOKEN_SCOPE_KIND as ScopeKind } from "@artgod/shared/collections/token-scope";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import {
    BOOTSTRAP_ENUMERATION_MODE as Mode,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY as Step,
    BOOTSTRAP_STEP_STATUS,
    serializeBootstrapStepDependencies,
} from "@artgod/shared/bootstrap/pipeline";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import {
    resolveOpenSeaIntegrationStatus,
    OPENSEA_INTEGRATION_MODE_ENV,
    OPENSEA_INTEGRATION_MODE,
} from "@artgod/shared/config/opensea-integration";
import { ERC721_OWNER_OF_FUNCTION } from "@artgod/shared/evm/erc721-ownership";
import { BootstrapAnchorExecutor } from "../src/application/bootstrap-anchor-executor.js";
import {
    BootstrapEnumerationExecutor,
    BOOTSTRAP_ENUMERATION_EXECUTOR_OUTCOME,
} from "../src/application/bootstrap-enumeration-executor.js";
import {
    BootstrapBackfillExecutor,
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    type BootstrapBackfillQueuePort,
} from "../src/application/bootstrap-backfill-executor.js";
import {
    BootstrapCollectionLiveExecutor,
    type BootstrapCollectionLiveQueuePort,
} from "../src/application/bootstrap-collection-live-executor.js";
import { bindCollectionExtensionBootstrapEnumerator } from "../src/application/collection-extensions/bootstrap-enumeration.js";
import {
    NFT111K_READ_FUNCTION as Read,
    NFT111K_ITEM_KIND as Kind,
} from "../src/application/collection-extensions/111k.js";
import { resolveTokenIdsForRun } from "../src/application/bootstrap-token-enumeration.js";
import {
    NFT_TRANSFER_EVENTS,
    decodeNftTransferLog,
} from "../src/application/nft-transfers.js";
import { syncRange } from "../src/application/sync.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import {
    DOMAIN_SYNC_PROJECTION,
    type DomainSyncMode,
} from "../src/domain/domain-jobs.js";
import { SYNC_JOB_KIND } from "../src/domain/sync-jobs.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { SqliteBootstrapRuns } from "../src/infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteCollectionExtensions } from "../src/infra/collection-extensions/sqlite.js";
import { createMetadataDomain } from "../src/runtime/create-metadata-domain.js";
import { HttpMetadataFetcher } from "../src/infra/metadata/http-fetcher.js";
import { Erc721TokenOwnership } from "../src/infra/ownership/erc721-token-ownership.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import type { RpcBlock, RpcLog, RpcProviderPort } from "../src/ports/rpc.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    nft111kTestInstall,
    nft111kTestMint,
    NFT111K_TEST_OWNER,
} from "./fixtures/111k-bootstrap.js";
import captured from "./fixtures/111k-warehouse-opening.json" with { type: "json" };

// Captured chain events, controlled state/download replies, real application and
// SQLite components. This is not a running broker/app or a live-chain test.
describe("111K bootstrap and continuous transfer projection", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    afterAll(() => db.raw.close());

    it("seeds only anchor-present IDs, catches up the real warehouse opening and admits later synthetic receipts", async () => {
        const opening = captured.openingBlock as RpcBlock;
        const logs = captured.logs as RpcLog[];
        const anchorBlock = opening.number - 1;
        const anchor = {
            chainId: CHAIN_ID,
            blockNumber: anchorBlock,
            blockHash: opening.parentHash,
        };
        const anchorHeader = captured.anchorBlock as RpcBlock;
        const anchorOwners = new Map<string, string>();
        for (const log of logs.filter(
            (log) => log.blockNumber <= anchorBlock,
        )) {
            for (const {
                decoded: { tokenId, to },
            } of decodeNftTransferLog(log)) {
                if (to.toLowerCase() === zeroAddress)
                    anchorOwners.delete(tokenId);
                else anchorOwners.set(tokenId, to.toLowerCase());
            }
        }
        expect(anchorOwners.size).toBe(272);
        const realOpeningLogs = logs.filter(
            (log) => log.blockNumber === opening.number,
        );
        expect(realOpeningLogs).toHaveLength(59);

        // Explicitly synthetic: no receipt mint was needed on the public chain.
        const receiptIds = ["1000001", "2000001", "3000001"];
        const laterIds = ["116666", ...receiptIds];
        const syntheticBlock: RpcBlock = {
            ...opening,
            number: opening.number + 1,
            hash: `0x${"ef".repeat(32)}`,
            parentHash: opening.hash,
            timestamp: opening.timestamp + 12,
            transactions: [`0x${"de".repeat(32)}`],
        };
        const syntheticLogs = laterIds.map((id, logIndex) =>
            nft111kTestMint(id, {
                blockNumber: syntheticBlock.number,
                blockHash: syntheticBlock.hash,
                transactionHash: syntheticBlock.transactions[0],
                logIndex,
            }),
        );
        const allLogs = [...logs, ...syntheticLogs];
        const readContractAtBlock = vi.fn(
            async (
                input: Parameters<RpcProviderPort["readContractAtBlock"]>[0],
            ): Promise<unknown> => {
                expect(input.block).toEqual(anchor);
                if (input.functionName === Read.TotalSupply)
                    return BigInt(anchorOwners.size);
                if (input.functionName === Read.GetTokenInfos) {
                    return (input.args![0] as bigint[]).map((id) =>
                        anchorOwners.has(String(id))
                            ? {
                                  kind: Kind.Artwork,
                                  displayId: id,
                                  holder: anchorOwners.get(String(id)),
                              }
                            : {
                                  kind: Kind.None,
                                  displayId: 0n,
                                  holder: zeroAddress,
                              },
                    );
                }
                expect(input.functionName).toBe(ERC721_OWNER_OF_FUNCTION);
                return anchorOwners.get(String(input.args![0]));
            },
        );
        const rpc: RpcProviderPort = {
            getBlockNumber: async () => opening.number,
            getBlock: async (number) => {
                if (number === anchorBlock) return anchorHeader;
                if (number === opening.number) return opening;
                if (number === syntheticBlock.number) return syntheticBlock;
                throw new Error("Unexpected fixture block");
            },
            getLogs: async (filter) => {
                const inRange = allLogs.filter(
                    (log) =>
                        log.blockNumber >= filter.fromBlock &&
                        log.blockNumber <= filter.toBlock,
                );
                if (filter.event) {
                    expect(filter.args).toEqual({ from: zeroAddress });
                    expect(filter.toBlock).toBeLessThanOrEqual(anchorBlock);
                    return inRange.filter(
                        (log) =>
                            decodeNftTransferLog(
                                log,
                            )[0].decoded.from.toLowerCase() === zeroAddress,
                    );
                }
                return filter.events === NFT_TRANSFER_EVENTS ? inRange : [];
            },
            getTransaction: async (hash) => {
                const transaction = captured.transactions.find(
                    (tx) => tx.hash === hash,
                );
                if (transaction)
                    return transaction as Awaited<
                        ReturnType<RpcProviderPort["getTransaction"]>
                    >;
                if (hash === syntheticBlock.transactions[0])
                    return {
                        hash: syntheticBlock.transactions[0],
                        from: NFT111K_TEST_OWNER,
                        to: CONTRACT as `0x${string}`,
                        input: "0x",
                    };
                throw new Error("Unexpected fixture transaction");
            },
            getTransactionReceipt: async (hash) => {
                const receipt = captured.receipts.find(
                    (item) => item.transactionHash === hash,
                );
                return receipt
                    ? (receipt as Awaited<
                          ReturnType<RpcProviderPort["getTransactionReceipt"]>
                      >)
                    : {
                          transactionHash: hash as `0x${string}`,
                          logs: syntheticLogs.filter(
                              (log) => log.transactionHash === hash,
                          ),
                      };
            },
            readContract: async () => {
                throw new Error(
                    "Enumerable reads are forbidden for this fixture",
                );
            },
            getBalance: async () => {
                throw new Error("Unused balance read");
            },
            readContractAtBlock: <T>(
                input: Parameters<RpcProviderPort["readContractAtBlock"]>[0],
            ): Promise<T> => readContractAtBlock(input) as Promise<T>,
        };
        const { collectionId, runId } = seedRun();
        const runs = new SqliteBootstrapRuns(),
            steps = new SqliteBootstrapSteps(),
            snapshots = new SqliteBootstrapStorage();
        const collections = new SqliteCollectionRegistry(),
            storage = new SqliteStorage();
        const anchorResult = await new BootstrapAnchorExecutor(
            { ...rpc, getBlockNumber: async () => anchorBlock + 10 },
            runs,
            steps,
            collections,
        ).anchor({ run: runs.getRun(runId)!, reorgDepth: 10 });
        expect(anchorResult.anchor?.anchorHash).toBe(anchor.blockHash);
        const installs = new SqliteCollectionExtensions();
        installs.upsertInstall({ ...nft111kTestInstall(), collectionId });
        steps.markStepReady(runId, Step.Enumeration);
        expect(
            steps.claimReadySteps({
                runId,
                stepKeys: [Step.Enumeration],
                leaseOwner: "111k-test",
                nowMs: Date.now(),
                leaseUntil: Date.now() + 60_000,
                limit: 1,
            }),
        ).toHaveLength(1);
        const ownership = new Erc721TokenOwnership(rpc);
        const enumerator = new BootstrapEnumerationExecutor(
            {
                resolveTokenIds: ({ run, anchorBlock, onProgress }) =>
                    resolveTokenIdsForRun(
                        rpc,
                        ownership,
                        run,
                        anchorBlock,
                        onProgress,
                        bindCollectionExtensionBootstrapEnumerator({
                            rpc,
                            run,
                            installs,
                        }),
                    ),
            },
            snapshots,
            runs,
            steps,
            1_000,
        );
        const enumerated = await enumerator.execute({
            run: runs.getRun(runId)!,
            anchor: anchorResult.anchor!,
            leaseOwner: "111k-test",
            metadataBatchSize: 20,
            traceId: "111k-test",
        });
        expect(enumerated.outcome).toBe(
            BOOTSTRAP_ENUMERATION_EXECUTOR_OUTCOME.MetadataQueued,
        );
        const presentIds = snapshots.listMetadataTaskTokenIds(runId);
        expect(new Set(presentIds)).toEqual(new Set(anchorOwners.keys()));
        expect(presentIds).toHaveLength(272);
        expect(presentIds).not.toContain("113087"); // First crate from the captured warehouse opening.
        const lastMint = logs
            .filter(
                (log) =>
                    log.blockNumber <= anchorBlock &&
                    decodeNftTransferLog(log)[0].decoded.from.toLowerCase() ===
                        zeroAddress,
            )
            .at(-1)!;
        // Even a mint after an earlier preflight belongs to the worker's snapshot.
        expect(presentIds).toContain(
            decodeNftTransferLog(lastMint)[0].decoded.tokenId,
        );
        expectScope(collectionId);

        while (true) {
            const tasks = snapshots.listMetadataTasksDueNow(
                runId,
                Date.now(),
                100,
            );
            if (tasks.length === 0) break;
            snapshots.insertOwnershipTasks(tasks);
            for (const task of tasks) {
                // Metadata completion is controlled; production ownership still reads ownerOf.
                snapshots.markMetadataTaskSucceeded(runId, task.tokenId, 1);
                const owner = await ownership.readOwner({
                    contract: CONTRACT,
                    tokenId: task.tokenId,
                    block: anchor,
                });
                snapshots.markOwnershipTaskSucceeded({
                    runId,
                    tokenId: task.tokenId,
                    attempts: 1,
                    owner: owner!,
                });
            }
        }
        expect(
            readContractAtBlock.mock.calls.filter(
                ([p]) => p.functionName === ERC721_OWNER_OF_FUNCTION,
            ),
        ).toHaveLength(272);
        snapshots.finalizeSnapshot({
            runId,
            chainId: CHAIN_ID,
            collectionId,
            contract: CONTRACT,
            anchorBlock,
            anchorHash: opening.parentHash,
            anchorTimestamp: anchorHeader.timestamp,
        });
        for (const step of [Step.Metadata, Step.Ownership])
            steps.markStepSucceeded(runId, step, {
                completed: 272,
                total: 272,
            });
        expect(count("nft_balances", collectionId)).toBe(272);

        const queue = {
            scheduleBackfillRange: vi.fn(async () => {}),
            scheduleBackfillCheck: vi.fn(async () => {}),
            scheduleOpenSeaBootstrap: vi.fn(async () => {
                throw new Error("OpenSea is disabled");
            }),
            enqueueBootstrapFinalStats: vi.fn(async () => {}),
        } satisfies BootstrapBackfillQueuePort &
            BootstrapCollectionLiveQueuePort;
        const backfill = new BootstrapBackfillExecutor(
            rpc,
            storage,
            collections,
            runs,
            steps,
            queue,
            new SqliteSyncGapStore(),
        );
        const backfillInput = {
            chainId: CHAIN_ID,
            runId,
            collectionId,
            address: CONTRACT,
            anchorBlock,
            backfillBatchSize: 100,
            openSeaIntegration: resolveOpenSeaIntegrationStatus({
                [OPENSEA_INTEGRATION_MODE_ENV]:
                    OPENSEA_INTEGRATION_MODE.Disabled,
            }),
            traceId: "111k-test",
            sourceJobId: "111k-test",
        };
        expect(
            (await backfill.scheduleAfterSnapshot(backfillInput)).outcome,
        ).toBe(BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillQueued);
        expect(queue.scheduleBackfillRange).toHaveBeenCalledWith(
            expect.objectContaining({
                fromBlock: anchorBlock + 1,
                toBlock: opening.number,
            }),
        );
        expect(
            (
                await backfill.checkProgress({
                    ...backfillInput,
                    fromBlock: opening.number,
                    toBlock: opening.number,
                })
            ).outcome,
        ).toBe(BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete);
        expect(collections.getCollection(CHAIN_ID, collectionId)?.status).toBe(
            COLLECTION_STATUS.Bootstrapping,
        );

        const metadata = createMetadataDomain(
            {
                resolveTokenUri: async (_contract, id) =>
                    "data:application/json," +
                    encodeURIComponent(
                        JSON.stringify({
                            name: `Controlled fixture #${id}`,
                            image: `https://example.invalid/${id}.png`,
                            attributes: [],
                        }),
                    ),
            },
            new HttpMetadataFetcher(),
        );
        async function projectBlock(block: RpcBlock, mode: DomainSyncMode) {
            const selected = collections.listCollectionsForSync(CHAIN_ID, mode);
            const data = await syncRange(rpc, CHAIN_ID, selected, collections, {
                fromBlock: block.number,
                toBlock: block.number,
            });
            storage.persistSyncResult({
                checkpoint: storage.captureSyncCheckpoint(CHAIN_ID),
                canonicalCheck: {
                    observedHeadBlock: block.number + 32,
                    reorgDepth: 32,
                },
                blocks: [block],
                data,
                collections: selected,
            });
            await metadata.handleDomainSync({
                chainId: CHAIN_ID,
                collectionId,
                fromBlock: block.number,
                toBlock: block.number,
                mode,
                projection: DOMAIN_SYNC_PROJECTION.CurrentState,
                sourceJobId: "111k-fixture",
                sourceKind:
                    mode === "backfill"
                        ? SYNC_JOB_KIND.BackfillRange
                        : SYNC_JOB_KIND.RealtimeBlock,
            });
            return data.collectionScoped.nftTransferEvents;
        }
        const transfers = await projectBlock(opening, "backfill");
        const mints = transfers.filter((event) => event.from === zeroAddress),
            burns = transfers.filter((event) => event.to === zeroAddress);
        const warehouseTransfers = transfers.filter(
            (event) =>
                event.txHash === captured.warehouseOpeningTransactionHash,
        );
        expect(
            warehouseTransfers
                .filter((event) => event.from === zeroAddress)
                .map((event) => event.tokenId),
        ).toEqual(Array.from({ length: 11 }, (_, i) => String(113087 + i)));
        expect(
            warehouseTransfers.filter((event) => event.to === zeroAddress),
        ).toHaveLength(1);
        expect(mints).toHaveLength(56);
        expect(burns).toHaveLength(3);
        expect(
            db
                .prepare(
                    "SELECT owner FROM nft_balances WHERE collection_id = ? AND token_id = ?",
                )
                .get(collectionId, burns[0].tokenId),
        ).toBeUndefined();
        expect(count("nft_balances", collectionId)).toBe(325);
        for (const event of mints)
            expect(
                db
                    .prepare(
                        "SELECT owner FROM nft_balances WHERE collection_id = ? AND token_id = ?",
                    )
                    .get(collectionId, event.tokenId),
            ).toEqual({ owner: event.to.toLowerCase() });
        expect(
            (
                await backfill.checkProgress({
                    ...backfillInput,
                    fromBlock: opening.number,
                    toBlock: opening.number,
                })
            ).outcome,
        ).toBe(BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted);
        steps.markStepReady(runId, Step.CollectionLive);
        await new BootstrapCollectionLiveExecutor(
            collections,
            runs,
            steps,
            snapshots,
            queue,
        ).complete({
            run: runs.getRun(runId)!,
            step: steps.getStep(runId, Step.CollectionLive)!,
            traceId: "111k-test",
            sourceJobId: "111k-test",
        });
        expect(runs.getRun(runId)?.status).toBe(BOOTSTRAP_RUN_STATUS.Completed);
        expect(collections.getCollection(CHAIN_ID, collectionId)?.status).toBe(
            COLLECTION_STATUS.Live,
        );
        const counts = [
            count("nft_balances", collectionId),
            count("nft_transfer_events", collectionId),
            count("token_metadata", collectionId),
        ];
        await projectBlock(opening, "realtime");
        expect([
            count("nft_balances", collectionId),
            count("nft_transfer_events", collectionId),
            count("token_metadata", collectionId),
        ]).toEqual(counts);

        const later = await projectBlock(syntheticBlock, "realtime");
        expect(later.map((event) => event.tokenId)).toEqual(laterIds);
        expect(count("nft_balances", collectionId)).toBe(329);
        for (const id of laterIds) {
            expect(
                db
                    .prepare(
                        "SELECT owner FROM nft_balances WHERE collection_id = ? AND token_id = ?",
                    )
                    .get(collectionId, id),
            ).toEqual({ owner: NFT111K_TEST_OWNER });
            expect(
                db
                    .prepare(
                        "SELECT token_id FROM tokens WHERE collection_id = ? AND token_id = ?",
                    )
                    .get(collectionId, id),
            ).toEqual({ token_id: id });
        }
        await projectBlock(syntheticBlock, "realtime");
        expect(count("nft_balances", collectionId)).toBe(329);
        expect(count("nft_transfer_events", collectionId)).toBe(63);
        expectScope(collectionId);

        // An artwork-only range excludes the same warehouse-opening transaction.
        db.prepare(
            "UPDATE collections SET token_scope_kind = ?, scope_start_token_id = '1', scope_total_supply = 378 WHERE collection_id = ?",
        ).run(ScopeKind.TokenRange, collectionId);
        const narrow = collections.listCollectionsForSync(CHAIN_ID, "realtime");
        expect(
            (
                await syncRange(rpc, CHAIN_ID, narrow, collections, {
                    fromBlock: opening.number,
                    toBlock: opening.number,
                })
            ).collectionScoped.nftTransferEvents.filter(
                (event) =>
                    event.txHash === captured.warehouseOpeningTransactionHash,
            ),
        ).toEqual([]);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
});

function seedRun() {
    const collectionId = Number(
        db
            .prepare(
                "INSERT INTO collections (chain_id, slug, address, standard, status, token_scope_kind, deployment_block) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
                CHAIN_ID,
                "111k-replay",
                CONTRACT,
                COLLECTION_STANDARD.Erc721,
                COLLECTION_STATUS.Bootstrapping,
                ScopeKind.AllContractTokens,
                NFT111K_MAINNET_DEPLOYMENT_BLOCK,
            ).lastInsertRowid,
    );
    const runId = Number(
        db
            .prepare(
                "INSERT INTO bootstrap_runs (chain_id, collection_id, request_slug, request_address, request_standard, request_extension_key, metadata_mode, enumeration_mode, request_image_cache_mode, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
                CHAIN_ID,
                collectionId,
                "111k-replay",
                CONTRACT,
                COLLECTION_STANDARD.Erc721,
                NFT111K_EXTENSION_KEY,
                BOOTSTRAP_METADATA_MODE.BestEffort,
                Mode.Enumerable,
                IMAGE_CACHE_MODE.Off,
                BOOTSTRAP_RUN_STATUS.Queued,
            ).lastInsertRowid,
    );
    const chain = [
        Step.Anchor,
        Step.Enumeration,
        Step.Metadata,
        Step.Ownership,
        Step.Backfill,
        Step.CollectionLive,
    ];
    for (let i = 0; i < chain.length; i++)
        db.prepare(
            "INSERT INTO bootstrap_run_steps (run_id, step_key, status, blocking, depends_on_json) VALUES (?, ?, ?, 1, ?)",
        ).run(
            runId,
            chain[i],
            i === 0
                ? BOOTSTRAP_STEP_STATUS.Ready
                : BOOTSTRAP_STEP_STATUS.Pending,
            serializeBootstrapStepDependencies(i === 0 ? [] : [chain[i - 1]]),
        );
    return { collectionId, runId };
}
function count(
    table: "nft_balances" | "nft_transfer_events" | "token_metadata",
    collectionId: number,
) {
    return (
        db
            .prepare(
                `SELECT COUNT(*) AS n FROM ${table} WHERE collection_id = ?`,
            )
            .get(collectionId) as { n: number }
    ).n;
}
function expectScope(collectionId: number) {
    expect(
        db
            .prepare(
                "SELECT token_scope_kind, scope_start_token_id, scope_total_supply FROM collections WHERE collection_id = ?",
            )
            .get(collectionId),
    ).toEqual({
        token_scope_kind: ScopeKind.AllContractTokens,
        scope_start_token_id: null,
        scope_total_supply: null,
    });
    expect(
        db
            .prepare(
                "SELECT * FROM collection_scope_tokens WHERE collection_id = ?",
            )
            .all(collectionId),
    ).toEqual([]);
}
