import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractFunctionRevertedError, encodeErrorResult } from "viem";
import {
    ERC721_OWNERSHIP_ABI,
    ERC721_OWNER_OF_FUNCTION,
    ERC721_ABSENT_TOKEN_ERROR,
} from "@artgod/shared/evm/erc721-ownership";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    type BootstrapRunStatus,
} from "@artgod/shared/bootstrap/pipeline";
import type {
    RpcLog,
    RpcLogFilter,
    RpcFirstLogPage,
    RpcLogRequestHooks,
    RpcProviderPort,
} from "../src/ports/rpc.js";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import { TOKEN_RECORD_KIND } from "@artgod/shared/types/token-records";
import { RpcBudgetDeferred } from "@artgod/shared/evm/rpc-budget";
import { getSettingDefaultNumber } from "@artgod/shared/config/generated-settings-defaults";
import {
    COLLECTION_STATUS,
    COLLECTION_CUSTOMIZATION_SOURCE_KIND,
} from "@artgod/shared/types";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import {
    OPENSEA_INTEGRATION_MODE,
    OPENSEA_INTEGRATION_MODE_ENV,
    resolveOpenSeaIntegrationStatus,
} from "@artgod/shared/config/opensea-integration";
import { CreateBootstrapRunUseCase } from "../../backend/src/application/use-cases/bootstrap/create-bootstrap-run.js";
import type { BootstrapCommandQueuePort } from "../../backend/src/application/use-cases/bootstrap/ports.js";
import type { CreateBootstrapRunInput } from "../../backend/src/application/use-cases/bootstrap/types.js";
import { SqliteBootstrapRunsRepository } from "../../backend/src/infra/bootstrap/sqlite-bootstrap-runs.js";
import {
    CollectionTokenScope,
    COLLECTION_STANDARD,
} from "../src/domain/collections.js";
import {
    BootstrapDeploymentExecutor,
    type BootstrapDeploymentRpcPort,
} from "../src/application/bootstrap-deployment-executor.js";
import {
    BootstrapStepScheduler,
    BOOTSTRAP_STARTUP_SWEEP_RUN_LIMIT,
} from "../src/application/bootstrap-step-scheduler.js";
import { resolveBootstrapLanePollDelayMs } from "../src/application/bootstrap-lane-poller.js";
import {
    readyStepResult,
    terminalStepResult,
} from "../src/application/bootstrap-step-orchestrator.js";
import { SqliteBootstrapDeployment } from "../src/infra/bootstrap/sqlite-deployment.js";
import { SqliteBootstrapRuns } from "../src/infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { BootstrapLiveRunCompletionReconciler } from "../src/application/bootstrap-live-run-completion-reconciler.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    BootstrapEnumerationExecutor,
    BOOTSTRAP_ENUMERATION_EXECUTOR_OUTCOME,
    type BootstrapEnumerationAnchor,
} from "../src/application/bootstrap-enumeration-executor.js";
import { resolveTokenIdsForRun } from "../src/application/bootstrap-token-enumeration.js";
import { Erc721TokenOwnership } from "../src/infra/ownership/erc721-token-ownership.js";
import { cleanupSuccessfulBootstrapTemporaryData } from "../src/application/bootstrap-temporary-data-cleanup.js";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const HASH = `0x${"a".repeat(64)}` as const;
const OTHER_HASH = `0x${"b".repeat(64)}` as const;
const NOW = 1_000;
const OWNER = "deployment-test";
const DEPLOYMENT = 42;

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function bootstrapCreator(
    publishBootstrapStart: BootstrapCommandQueuePort["publishBootstrapStart"],
) {
    const repository = new SqliteBootstrapRunsRepository();
    const create = new CreateBootstrapRunUseCase(
        1,
        resolveOpenSeaIntegrationStatus({
            [OPENSEA_INTEGRATION_MODE_ENV]: OPENSEA_INTEGRATION_MODE.Disabled,
        }),
        {
            resolveChainRef: () => ({
                id: 1,
                type: "evm",
                publicChainId: 1,
                slug: "ethereum",
                name: "Ethereum",
            }),
        },
        repository,
        { resolveExtensionKey: () => null },
        {
            updateImageCachePolicyState: ({ selectedSource, userConfig }) => ({
                selectedSource,
                userConfig,
                extensionConfig: null,
                effectiveConfig: userConfig,
            }),
        },
        {
            publishBootstrapStart,
            publishBootstrapMetadataProcess: async () => {},
            publishBootstrapImageCacheProcess: async () => {},
        },
    );
    return { repository, create };
}

function manualInput(tokenId: string): CreateBootstrapRunInput {
    return {
        chainRef: "ethereum",
        slug: "late-start",
        address: ADDRESS,
        standard: COLLECTION_STANDARD.Erc721,
        imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
        metadataMode: BOOTSTRAP_METADATA_MODE.BestEffort,
        scope: {
            mode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
            tokenIds: [tokenId],
        },
        imageCache: {
            selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
            imageCacheMode: IMAGE_CACHE_MODE.Off,
            maxDimension: null,
        },
    };
}

function mintLog(blockNumber: number): RpcLog {
    return {
        address: ADDRESS,
        data: "0x",
        topics: [],
        blockNumber,
        blockHash: HASH,
        transactionHash: HASH,
        logIndex: 0,
    };
}

function rpc() {
    return {
        findFirstLogPage: vi.fn(
            async (
                filter: RpcLogFilter,
                hooks?: RpcLogRequestHooks,
            ): Promise<RpcFirstLogPage> => {
                hooks?.beforeRequest?.();
                hooks?.onRequest?.({
                    fromBlock: filter.fromBlock,
                    toBlock: filter.toBlock,
                });
                const blockNumber =
                    filter.args?.tokenId === 200n ? 75 : DEPLOYMENT;
                return {
                    log: mintLog(blockNumber),
                    nextBlock: filter.toBlock + 1,
                };
            },
        ),
        getBlockNumber: vi.fn(async () => 101),
        getBlock: vi.fn(async (number: number) => ({
            number,
            hash: HASH,
            parentHash: HASH,
            timestamp: 1_700_000_000,
            transactions: [],
        })),
        getBytecode: vi.fn(
            async (
                _address: `0x${string}`,
                block: number,
            ): Promise<`0x${string}` | null> =>
                block >= DEPLOYMENT ? "0x1234" : null,
        ),
    } satisfies BootstrapDeploymentRpcPort;
}

function seed(
    runId: number,
    status: BootstrapRunStatus = BOOTSTRAP_RUN_STATUS.Queued,
    deploymentBlock: number | null = null,
    chainId = 1,
    sharedContract = false,
) {
    const scope = CollectionTokenScope.allContractTokens().toPersistence();
    db.prepare(
        "INSERT INTO collections (collection_id, chain_id, slug, address, standard, status, token_scope_kind, deployment_block) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        runId,
        chainId,
        `test-${runId}`,
        ADDRESS,
        COLLECTION_STANDARD.Erc721,
        status === BOOTSTRAP_RUN_STATUS.Completed
            ? COLLECTION_STATUS.Live
            : COLLECTION_STATUS.Bootstrapping,
        scope.tokenScopeKind,
        deploymentBlock,
    );
    db.prepare(
        "INSERT INTO bootstrap_runs (run_id, chain_id, collection_id, request_slug, request_address, request_standard, metadata_mode, enumeration_mode, request_image_cache_mode, status, deployment_block) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        runId,
        chainId,
        runId,
        `test-${runId}`,
        ADDRESS,
        COLLECTION_STANDARD.Erc721,
        BOOTSTRAP_METADATA_MODE.BestEffort,
        BOOTSTRAP_ENUMERATION_MODE.Enumerable,
        IMAGE_CACHE_MODE.Off,
        status,
        deploymentBlock,
    );
    db.prepare(
        "INSERT INTO bootstrap_run_steps (run_id, step_key, status, blocking, config_json) VALUES (?, ?, ?, ?, ?)",
    ).run(
        runId,
        BOOTSTRAP_STEP_KEY.DeploymentBlock,
        BOOTSTRAP_STEP_STATUS.Ready,
        0,
        JSON.stringify({ sharedContract }),
    );
}

function harness(
    client = rpc(),
    options: {
        nowMs?: () => number;
        pollMinMs?: number;
        runLimit?: number;
    } = {},
) {
    const nowMs = options.nowMs ?? (() => NOW);
    const runs = new SqliteBootstrapRuns();
    const steps = new SqliteBootstrapSteps(nowMs);
    const store = new SqliteBootstrapDeployment(nowMs);
    const executor = new BootstrapDeploymentExecutor(client, store);
    const scheduler = new BootstrapStepScheduler(
        runs,
        steps,
        {
            processClaimedStep: async ({ run, leaseOwner }) =>
                (await executor.search({
                    run,
                    leaseOwner,
                    reorgDepth: 1,
                }))
                    ? terminalStepResult()
                    : readyStepResult(nowMs() + (options.pollMinMs ?? 100)),
        },
        { wakeBootstrapStep: async () => {} },
        nowMs,
    );
    return {
        runs,
        steps,
        store,
        executor,
        scheduler,
        poll: () =>
            scheduler.runOnce({
                chainId: 1,
                traceId: "deployment-test",
                laneName: "deployment-test",
                laneStepKeys: [BOOTSTRAP_STEP_KEY.DeploymentBlock],
                leaseOwner: OWNER,
                leaseMs: 10_000,
                maxProgressStaleMs: 20_000,
                claimLimit: 1,
                maxIterationsPerRun: 2,
                runLimit: options.runLimit ?? 10,
                retryPolicy: {
                    maxAttempts: 2,
                    baseDelayMs: 100,
                    maxDelayMs: 1_000,
                },
            }),
    };
}

function collectionBlock(id: number): number | null {
    return (
        db
            .prepare(
                "SELECT deployment_block FROM collections WHERE collection_id = ?",
            )
            .get(id) as { deployment_block: number | null }
    ).deployment_block;
}

function claimEnumeration(
    runId: number,
    anchor: BootstrapEnumerationAnchor = {
        anchorBlock: 100,
        anchorHash: HASH,
        anchorTimestamp: 1_700_000_000,
    },
) {
    const runs = new SqliteBootstrapRuns();
    runs.updateRunAnchor({
        runId,
        ...anchor,
    });
    db.prepare(
        "INSERT INTO bootstrap_run_steps (run_id, step_key, status, blocking) VALUES (?, ?, ?, 1) ON CONFLICT(run_id, step_key) DO UPDATE SET status = excluded.status, lease_owner = NULL, lease_until = NULL",
    ).run(runId, BOOTSTRAP_STEP_KEY.Enumeration, BOOTSTRAP_STEP_STATUS.Ready);
    const steps = new SqliteBootstrapSteps(() => NOW);
    steps.claimReadySteps({
        runId,
        stepKeys: [BOOTSTRAP_STEP_KEY.Enumeration],
        leaseOwner: OWNER,
        leaseUntil: NOW + 10_000,
        nowMs: NOW,
        limit: 1,
    });
    return {
        run: runs.getRun(runId)!,
        anchor,
        leaseOwner: OWNER,
    };
}

function recordEnumeration(
    runId: number,
    firstTokenId?: string,
    anchor?: BootstrapEnumerationAnchor,
) {
    if (firstTokenId !== undefined) {
        const input = claimEnumeration(runId, anchor);
        expect(
            new SqliteBootstrapSteps(() => NOW).completeEnumeration({
                ...input,
                tokenCount: 2,
                elapsedMs: 0,
                firstTokenId,
            }),
        ).toBe(true);
    } else {
        const run = new SqliteBootstrapRuns().getRun(runId)!;
        new SqliteBootstrapRuns().appendRunEvent({
            runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationCompleted,
            eventLevel: "info",
            message: "Enumeration complete",
            payloadJson: JSON.stringify({ tokenCount: 2 }),
        });
    }
}

function seedOwnedToken(runId: number, tokenId: string, synthetic = false) {
    db.prepare(
        "INSERT INTO tokens (chain_id, collection_id, contract_address, token_id, record_kind) VALUES (?, ?, ?, ?, ?)",
    ).run(
        1,
        runId,
        ADDRESS,
        tokenId,
        synthetic
            ? TOKEN_RECORD_KIND.ExtensionSynthetic
            : TOKEN_RECORD_KIND.Canonical,
    );
    db.prepare(
        "INSERT INTO nft_balances (chain_id, collection_id, contract_address, token_id, owner, amount, last_block_number, last_block_hash, last_block_timestamp, last_tx_hash, last_log_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        1,
        runId,
        ADDRESS,
        tokenId,
        ADDRESS,
        "1",
        100,
        HASH,
        1_700_000_000,
        HASH,
        0,
    );
}

function producingEnumeration(runId: number, presentIds: string[]) {
    const claim = claimEnumeration(runId);
    const present = new Set(presentIds);
    const calls: string[] = [];
    const network: Pick<
        RpcProviderPort,
        "readContract" | "readContractAtBlock"
    > = {
        readContract: async <T>(
            input: Parameters<RpcProviderPort["readContract"]>[0],
        ) => {
            expect(input.blockNumber).toBe(claim.anchor.anchorBlock);
            return (
                input.functionName === "totalSupply"
                    ? BigInt(presentIds.length)
                    : BigInt(presentIds[Number(input.args![0])]!)
            ) as T;
        },
        readContractAtBlock: async <T>(
            input: Parameters<RpcProviderPort["readContractAtBlock"]>[0],
        ) => {
            expect(input.block).toEqual({
                chainId: claim.run.chainId,
                blockNumber: claim.anchor.anchorBlock,
                blockHash: claim.anchor.anchorHash,
            });
            const tokenId = String(input.args![0]);
            calls.push(tokenId);
            if (!present.has(tokenId))
                throw new ContractFunctionRevertedError({
                    abi: ERC721_OWNERSHIP_ABI,
                    functionName: ERC721_OWNER_OF_FUNCTION,
                    data: encodeErrorResult({
                        abi: ERC721_OWNERSHIP_ABI,
                        errorName: ERC721_ABSENT_TOKEN_ERROR.NonexistentToken,
                        args: [BigInt(tokenId)],
                    }),
                });
            return ADDRESS as T;
        },
    };
    const resolveTokenIds = vi.fn(
        ({
            run,
            anchorBlock,
            onProgress,
        }: Parameters<
            import("../src/application/bootstrap-enumeration-executor.js").BootstrapEnumerationResolverPort["resolveTokenIds"]
        >[0]) =>
            resolveTokenIdsForRun(
                network,
                new Erc721TokenOwnership(network),
                run,
                anchorBlock,
                onProgress,
            ),
    );
    const storage = new SqliteBootstrapStorage();
    const runs = new SqliteBootstrapRuns();
    const steps = new SqliteBootstrapSteps(() => NOW);
    const executor = new BootstrapEnumerationExecutor(
        { resolveTokenIds },
        storage,
        runs,
        steps,
        60_000,
    );
    return {
        claim,
        calls,
        resolveTokenIds,
        storage,
        runs,
        steps,
        executor,
        execute: () =>
            executor.execute({
                ...claim,
                metadataBatchSize: 2,
                traceId: "confirmed-input",
            }),
    };
}

describe("deployment input produced by anchored enumeration", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    it.each([
        {
            mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
            candidates: ["0", "1", "2", "3"],
            present: ["2", "3"],
            expected: "2",
        },
        {
            mode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
            candidates: ["200", "2", "0"],
            present: ["2", "0"],
            expected: "2",
        },
        {
            mode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
            candidates: ["0", "1"],
            present: ["0"],
            expected: "0",
        },
        {
            mode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
            candidates: [],
            present: ["200", "1"],
            expected: "200",
        },
    ])(
        "publishes only this run's confirmed first token: $mode $expected",
        async ({ mode, candidates, present, expected }) => {
            seed(
                101,
                BOOTSTRAP_RUN_STATUS.Queued,
                null,
                1,
                mode === BOOTSTRAP_ENUMERATION_MODE.Enumerable,
            );
            db.prepare(
                "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ?, manual_range_start_token_id = ?, manual_range_total_supply = ? WHERE run_id = ?",
            ).run(
                mode,
                mode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
                    ? JSON.stringify(candidates)
                    : null,
                mode === BOOTSTRAP_ENUMERATION_MODE.ManualRange ? "0" : null,
                mode === BOOTSTRAP_ENUMERATION_MODE.ManualRange ? 4 : null,
                101,
            );
            seedOwnedToken(101, "1");
            const client = rpc();
            await harness(client).poll();
            expect(client.getBytecode).not.toHaveBeenCalled();
            expect(client.findFirstLogPage).not.toHaveBeenCalled();
            const enumeration = producingEnumeration(101, present);
            await enumeration.execute();
            expect(enumeration.calls).toEqual(candidates);
            expect(enumeration.storage.getMetadataTaskCounts(101).total).toBe(
                present.length,
            );
            const resultJson = enumeration.steps.getStep(
                101,
                BOOTSTRAP_STEP_KEY.Enumeration,
            )!.resultJson;
            expect(JSON.parse(resultJson!)).toMatchObject({
                firstTokenId: expected,
                anchorBlock: 100,
                anchorHash: HASH,
            });

            // Restart with task rows, then clean/reset operational rows after live.
            // Neither path is allowed to reconstruct this input from current state.
            claimEnumeration(101);
            await enumeration.execute();
            expect(enumeration.resolveTokenIds).toHaveBeenCalledTimes(1);
            for (const tokenId of present)
                enumeration.storage.markMetadataTaskSucceeded(101, tokenId, 1);
            enumeration.runs.updateRunStatus(
                101,
                BOOTSTRAP_RUN_STATUS.Completed,
            );
            expect(
                cleanupSuccessfulBootstrapTemporaryData({
                    bootstrapStorage: enumeration.storage,
                    bootstrapRuns: enumeration.runs,
                    runId: 101,
                }).deleted,
            ).toBe(true);
            enumeration.storage.deleteRunTemporaryData(101);
            expect(
                enumeration.steps.getStep(101, BOOTSTRAP_STEP_KEY.Enumeration)!
                    .resultJson,
            ).toBe(resultJson);
            db.prepare(
                "UPDATE bootstrap_run_steps SET next_attempt_at = 0 WHERE run_id = ? AND step_key = ?",
            ).run(101, BOOTSTRAP_STEP_KEY.DeploymentBlock);
            await harness(client).poll();
            expect(client.findFirstLogPage).toHaveBeenCalledWith(
                expect.objectContaining({
                    args: expect.objectContaining({
                        tokenId: BigInt(expected),
                    }),
                }),
                expect.any(Object),
            );
            expect(collectionBlock(101)).toBe(
                expected === "200" ? 75 : DEPLOYMENT,
            );
        },
    );

    it("does not use another run's confirmation, declared list, event, or existing inventory", async () => {
        seed(101, BOOTSTRAP_RUN_STATUS.Queued, null, 1, true);
        seed(102, BOOTSTRAP_RUN_STATUS.Completed, null, 1, true);
        db.prepare(
            "UPDATE bootstrap_runs SET collection_id = ? WHERE run_id = ?",
        ).run(101, 102);
        recordEnumeration(102, "2");
        new SqliteBootstrapSteps(() => NOW).markStepSucceeded(
            102,
            BOOTSTRAP_STEP_KEY.DeploymentBlock,
        );
        seedOwnedToken(101, "2");
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = ?",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["2"]', 101);
        new SqliteBootstrapRuns().appendRunEvent({
            runId: 101,
            chainId: 1,
            collectionId: 101,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationCompleted,
            eventLevel: "info",
            message: "Historical event",
            payloadJson: JSON.stringify({ tokenCount: 1, firstTokenId: "2" }),
        });
        const client = rpc();
        await harness(client).poll();
        expect(client.getBytecode).not.toHaveBeenCalled();
        expect(client.findFirstLogPage).not.toHaveBeenCalled();
        expect(collectionBlock(101)).toBeNull();
    });

    it.each(["failure", "replacement", "expiry", "anchor", "deletion"])(
        "fences late enumeration output after %s",
        async (change) => {
            seed(101, BOOTSTRAP_RUN_STATUS.Queued, null, 1, true);
            const enumeration = producingEnumeration(101, ["0"]);
            const response = deferred<string[]>();
            enumeration.resolveTokenIds.mockImplementationOnce(
                () => response.promise,
            );
            const running = enumeration.execute();
            if (change === "failure")
                enumeration.runs.updateRunStatus(
                    101,
                    BOOTSTRAP_RUN_STATUS.Failed,
                );
            if (change === "replacement")
                db.prepare(
                    "UPDATE bootstrap_run_steps SET lease_owner = ? WHERE run_id = ? AND step_key = ?",
                ).run("replacement", 101, BOOTSTRAP_STEP_KEY.Enumeration);
            if (change === "expiry")
                db.prepare(
                    "UPDATE bootstrap_run_steps SET lease_until = ? WHERE run_id = ? AND step_key = ?",
                ).run(NOW, 101, BOOTSTRAP_STEP_KEY.Enumeration);
            if (change === "anchor")
                enumeration.runs.updateRunAnchor({
                    runId: 101,
                    anchorBlock: 100,
                    anchorHash: OTHER_HASH,
                    anchorTimestamp: 1_700_000_000,
                });
            if (change === "deletion")
                db.prepare(
                    "DELETE FROM bootstrap_run_steps WHERE run_id = ? AND step_key = ?",
                ).run(101, BOOTSTRAP_STEP_KEY.Enumeration);
            response.resolve(["0"]);
            expect(await running).toMatchObject({
                outcome: BOOTSTRAP_ENUMERATION_EXECUTOR_OUTCOME.LeaseLost,
            });
            expect(
                new SqliteBootstrapDeployment(
                    () => NOW,
                ).getEnumerationConfirmation(enumeration.runs.getRun(101)!),
            ).toBeNull();
            expect(enumeration.storage.getMetadataTaskCounts(101).total).toBe(
                0,
            );
        },
    );

    it("rolls back confirmation and success if the completed event cannot be saved", () => {
        seed(101);
        const claim = claimEnumeration(101);
        db.exec(
            `CREATE TRIGGER reject_enumeration_event BEFORE INSERT ON bootstrap_run_events WHEN NEW.event_code = '${BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationCompleted}' BEGIN SELECT RAISE(ABORT, 'event write failed'); END`,
        );
        expect(() =>
            new SqliteBootstrapSteps(() => NOW).completeEnumeration({
                ...claim,
                tokenCount: 1,
                elapsedMs: 0,
                firstTokenId: "0",
            }),
        ).toThrow("event write failed");
        expect(
            new SqliteBootstrapSteps(() => NOW).getStep(
                101,
                BOOTSTRAP_STEP_KEY.Enumeration,
            ),
        ).toMatchObject({
            status: BOOTSTRAP_STEP_STATUS.Running,
            resultJson: null,
            leaseOwner: OWNER,
        });
    });

    it("withholds retained input when the run's anchor changes", async () => {
        seed(101, BOOTSTRAP_RUN_STATUS.Queued, null, 1, true);
        const enumeration = producingEnumeration(101, ["0"]);
        await enumeration.execute();
        enumeration.runs.updateRunAnchor({
            runId: 101,
            anchorBlock: 100,
            anchorHash: OTHER_HASH,
            anchorTimestamp: 1_700_000_000,
        });
        const client = rpc();
        await harness(client).poll();
        expect(client.getBytecode).not.toHaveBeenCalled();
        expect(collectionBlock(101)).toBeNull();
    });
});

describe("durable optional deployment lookup", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    it.each([false, true])(
        "resumes successful code probes after shared quota defers the next probe: manual=%s",
        async (manual) => {
            seed(101, BOOTSTRAP_RUN_STATUS.Completed);
            if (manual)
                db.prepare(
                    "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
                ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200"]');
            recordEnumeration(101, "200");
            const client = rpc();
            const readCode = client.getBytecode.getMockImplementation()!;
            const successfulProbes: number[] = [];
            let probes = 0;
            client.getBytecode.mockImplementation(async (address, block) => {
                if (++probes % 3 === 0) throw new RpcBudgetDeferred(25);
                const code = await readCode(address, block);
                successfulProbes.push(block);
                return code;
            });
            const first = harness(client);
            await first.poll();
            expect(
                first.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock),
            ).toMatchObject({
                status: BOOTSTRAP_STEP_STATUS.Ready,
                attempts: 0,
            });
            for (
                let pass = 0;
                pass < 10 && collectionBlock(101) === null;
                pass++
            ) {
                db.prepare(
                    `UPDATE bootstrap_run_steps SET next_attempt_at = 0 WHERE run_id = 101 AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
                ).run();
                await harness(client).poll();
            }
            expect(collectionBlock(101)).toBe(manual ? 75 : DEPLOYMENT);
            expect(new Set(successfulProbes).size).toBe(
                successfulProbes.length,
            );
        },
    );

    it("checkpoints only completed pages and resumes them after restart and a failed request", async () => {
        seed(101, BOOTSTRAP_RUN_STATUS.Completed);
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200"]');
        recordEnumeration(101, "200");
        const first = rpc();
        first.findFirstLogPage.mockResolvedValueOnce({
            log: null,
            nextBlock: 50,
        });
        const initial = harness(first);
        await initial.poll();
        expect(
            initial.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock)
                ?.status,
        ).toBe(BOOTSTRAP_STEP_STATUS.Ready);
        expect(initial.store.getSearchProgress(101)).toMatchObject({
            firstTokenId: "200",
            upperBlock: 100,
            lowerBlock: DEPLOYMENT,
            nextBlock: 50,
        });
        expect(collectionBlock(101)).toBeNull();

        const retry = rpc();
        retry.findFirstLogPage.mockImplementationOnce(async (filter, hooks) => {
            hooks?.beforeRequest?.();
            hooks?.onRequest?.({ fromBlock: filter.fromBlock, toBlock: 59 });
            throw new Error("connection lost");
        });
        const restarted = harness(retry);
        db.prepare(
            `UPDATE bootstrap_run_steps SET next_attempt_at = 0 WHERE run_id = 101 AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
        ).run();
        await restarted.poll();
        expect(restarted.store.getSearchProgress(101)?.nextBlock).toBe(50);
        expect(
            restarted.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock)
                ?.status,
        ).toBe(BOOTSTRAP_STEP_STATUS.FailedRetry);
        db.prepare(
            `UPDATE bootstrap_run_steps SET next_attempt_at = 0 WHERE run_id = 101 AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
        ).run();
        await restarted.poll();
        expect(
            retry.findFirstLogPage.mock.calls.map(
                ([filter]) => filter.fromBlock,
            ),
        ).toEqual([50, 50]);
        expect(collectionBlock(101)).toBe(75);
        expect(first.findFirstLogPage.mock.calls[0]?.[0].fromBlock).toBe(
            DEPLOYMENT,
        );
        const codeProbes = first.getBytecode.mock.calls.map(
            ([, block]) => block,
        );
        expect(new Set(codeProbes).size).toBe(codeProbes.length);
        expect(retry.getBytecode).not.toHaveBeenCalled();
        // The pinned hash is checked at settlement; every empty page does not
        // spend two extra header calls on the same settled upper block.
        expect(retry.getBlock).toHaveBeenCalledTimes(1);
    });

    it("does not advance a page cursor after pause or run failure", async () => {
        seed(101);
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200"]');
        recordEnumeration(101, "200");
        const client = rpc();
        const h = harness(client);
        client.findFirstLogPage.mockImplementationOnce(async () => {
            h.runs.updateRunStatus(101, BOOTSTRAP_RUN_STATUS.Failed);
            return { log: null, nextBlock: 50 };
        });
        await h.poll();
        expect(h.store.getSearchProgress(101)?.nextBlock).toBe(DEPLOYMENT);
        expect(collectionBlock(101)).toBeNull();
        await h.poll();
        expect(client.findFirstLogPage).toHaveBeenCalledTimes(1);
    });

    it.each(
        ["anchor", "hash", "replacement", "deletion"].flatMap((change) =>
            ["code reply", "quota wait", "mint reply", "publication"].map(
                (boundary) => ({ change, boundary }),
            ),
        ),
    )(
        "fences a changed enumeration confirmation: $change during $boundary",
        async ({ change, boundary }) => {
            seed(101);
            db.prepare(
                "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
            ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200", "1"]');
            recordEnumeration(101, "200");
            const entered = deferred<void>();
            const release = deferred<void>();
            const wait = async () => {
                entered.resolve();
                await release.promise;
            };
            const client = rpc();
            const wireRequest = vi.fn();
            if (boundary === "code reply") {
                client.getBytecode.mockImplementationOnce(async () => {
                    await wait();
                    return "0x1234";
                });
            } else if (boundary === "publication") {
                const getBlock = client.getBlock.getMockImplementation()!;
                client.getBlock.mockImplementation(async (number) => {
                    if (client.getBlock.mock.calls.length === 2) await wait();
                    return getBlock(number);
                });
            } else {
                client.findFirstLogPage.mockImplementationOnce(
                    async (filter, hooks) => {
                        await wait();
                        if (boundary === "quota wait") {
                            hooks?.beforeRequest?.();
                            wireRequest();
                        }
                        return { log: null, nextBlock: 50 };
                    },
                );
            }
            const h = harness(client);
            const polling = h.poll();
            await entered.promise;
            const progressBefore = h.steps.getStep(
                101,
                BOOTSTRAP_STEP_KEY.DeploymentBlock,
            )!.resultJson;
            if (change === "anchor" || change === "hash") {
                h.runs.updateRunAnchor({
                    runId: 101,
                    anchorBlock: change === "anchor" ? 200 : 100,
                    anchorHash: OTHER_HASH,
                    anchorTimestamp: 1_700_000_000,
                });
            } else if (change === "replacement") {
                recordEnumeration(101, "1");
            } else {
                db.prepare(
                    "DELETE FROM bootstrap_run_steps WHERE run_id = ? AND step_key = ?",
                ).run(101, BOOTSTRAP_STEP_KEY.Enumeration);
            }
            release.resolve();
            await polling;
            expect(collectionBlock(101)).toBeNull();
            expect(h.runs.getRun(101)?.deploymentBlock).toBeNull();
            expect(
                h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock),
            ).toMatchObject({
                status: BOOTSTRAP_STEP_STATUS.Ready,
                attempts: 0,
                resultJson: progressBefore,
            });
            expect(wireRequest).not.toHaveBeenCalled();
        },
    );

    it("rejects stale mint progress and publication inside the store transaction", () => {
        seed(101, BOOTSTRAP_RUN_STATUS.Queued, null, 1, true);
        recordEnumeration(101, "1");
        const h = harness();
        h.steps.claimReadySteps({
            runId: 101,
            stepKeys: [BOOTSTRAP_STEP_KEY.DeploymentBlock],
            leaseOwner: OWNER,
            leaseUntil: NOW + 10_000,
            nowMs: NOW,
            limit: 1,
        });
        const claim = {
            runId: 101,
            chainId: 1,
            collectionId: 101,
            address: ADDRESS,
            leaseOwner: OWNER,
            confirmation: {
                firstTokenId: "1",
                anchorBlock: 100,
                anchorHash: HASH,
            },
        };
        expect(h.store.ownsLease(claim)).toBe(true);
        recordEnumeration(101, "2");
        h.store.recordSearchRange(claim, { fromBlock: 20, toBlock: 100 });
        expect(h.store.complete(claim, { deploymentBlock: 75 })).toBe(false);
        expect(collectionBlock(101)).toBeNull();
        expect(
            h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock),
        ).toMatchObject({
            status: BOOTSTRAP_STEP_STATUS.Running,
            leaseOwner: OWNER,
            resultJson: null,
        });
    });

    it.each([100, 200])(
        "restarts mint progress for the same token confirmed at a new %s/hash",
        async (anchorBlock) => {
            seed(101, BOOTSTRAP_RUN_STATUS.Queued, null, 1, true);
            recordEnumeration(101, "200");
            const client = rpc();
            client.findFirstLogPage.mockResolvedValueOnce({
                log: null,
                nextBlock: 50,
            });
            const h = harness(client);
            await h.poll();
            expect(h.store.getSearchProgress(101)?.nextBlock).toBe(50);
            recordEnumeration(101, "200", {
                anchorBlock,
                anchorHash: OTHER_HASH,
                anchorTimestamp: 1_700_000_000,
            });
            client.getBlock.mockImplementation(async (number) => ({
                number,
                hash: OTHER_HASH,
                parentHash: HASH,
                timestamp: 1_700_000_000,
                transactions: [],
            }));
            client.getBytecode.mockImplementation(async (_address, block) =>
                block >= 20 ? "0x1234" : null,
            );
            client.findFirstLogPage.mockResolvedValueOnce({
                log: mintLog(30),
                nextBlock: anchorBlock + 1,
            });
            db.prepare(
                "UPDATE bootstrap_run_steps SET next_attempt_at = 0 WHERE run_id = ? AND step_key = ?",
            ).run(101, BOOTSTRAP_STEP_KEY.DeploymentBlock);
            await h.poll();
            expect(
                client.findFirstLogPage.mock.calls.map(([filter]) => ({
                    from: filter.fromBlock,
                    to: filter.toBlock,
                })),
            ).toEqual([
                { from: DEPLOYMENT, to: 100 },
                { from: 20, to: anchorBlock },
            ]);
            expect(collectionBlock(101)).toBe(30);
        },
    );

    it("requires a matching enumeration confirmation after canonical history changes", async () => {
        seed(101);
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200"]');
        recordEnumeration(101, "200");
        const client = rpc();
        client.findFirstLogPage.mockResolvedValueOnce({
            log: null,
            nextBlock: 50,
        });
        const h = harness(client);
        await h.poll();
        client.getBlock.mockImplementation(async (number) => ({
            number,
            hash: OTHER_HASH,
            parentHash: HASH,
            timestamp: 1_700_000_000,
            transactions: [],
        }));
        db.prepare(
            `UPDATE bootstrap_run_steps SET next_attempt_at = 0 WHERE run_id = 101 AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
        ).run();
        await h.poll();
        expect(collectionBlock(101)).toBeNull();
        expect(h.store.getSearchProgress(101)).toMatchObject({
            lowerBlock: null,
            nextBlock: 0,
            upperBlockHash: HASH,
        });
        // The same confirmation cannot authorize a retry against the new fork.
        db.prepare(
            "UPDATE bootstrap_run_steps SET next_attempt_at = 0 WHERE run_id = ? AND step_key = ?",
        ).run(101, BOOTSTRAP_STEP_KEY.DeploymentBlock);
        const codeReads = client.getBytecode.mock.calls.length;
        await h.poll();
        expect(collectionBlock(101)).toBeNull();
        expect(client.getBytecode).toHaveBeenCalledTimes(codeReads);
        expect(client.findFirstLogPage).toHaveBeenCalledTimes(2);
        recordEnumeration(101, "200", {
            anchorBlock: 100,
            anchorHash: OTHER_HASH,
            anchorTimestamp: 1_700_000_000,
        });
        // The new history may deploy the contract and mint the token earlier.
        // Recompute the code boundary instead of trusting the old lower bound.
        client.getBytecode.mockImplementation(async (_address, block) =>
            block >= 20 ? "0x1234" : null,
        );
        client.findFirstLogPage.mockResolvedValueOnce({
            log: mintLog(30),
            nextBlock: 101,
        });
        db.prepare(
            "UPDATE bootstrap_run_steps SET status = ?, attempts = 0, next_attempt_at = 0 WHERE run_id = ? AND step_key = ?",
        ).run(
            BOOTSTRAP_STEP_STATUS.Ready,
            101,
            BOOTSTRAP_STEP_KEY.DeploymentBlock,
        );
        await h.poll();
        expect(
            client.findFirstLogPage.mock.calls.map(
                ([filter]) => filter.fromBlock,
            ),
        ).toEqual([DEPLOYMENT, 50, 20]);
        expect(collectionBlock(101)).toBe(30);
    });

    it.each([BOOTSTRAP_STEP_STATUS.Ready, BOOTSTRAP_STEP_STATUS.Paused])(
        "services later runnable deployment work past multiple windows of %s input waiters",
        async (waitingStatus) => {
            const runLimit = BOOTSTRAP_STARTUP_SWEEP_RUN_LIMIT;
            const waitingIds = Array.from(
                { length: runLimit * 2 + 1 },
                (_, index) => 1_001 + index,
            );
            const runnableIds = [
                waitingIds.at(-1)! + 1,
                waitingIds.at(-1)! + 2,
            ];
            db.writeTransaction(() => {
                for (const runId of waitingIds) {
                    seed(runId);
                    db.prepare(
                        "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = ?",
                    ).run(
                        BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
                        '["1"]',
                        runId,
                    );
                    db.prepare(
                        "UPDATE bootstrap_run_steps SET status = ? WHERE run_id = ? AND step_key = ?",
                    ).run(
                        waitingStatus,
                        runId,
                        BOOTSTRAP_STEP_KEY.DeploymentBlock,
                    );
                }
                for (const runId of runnableIds) seed(runId);
            })();
            let nowMs = NOW;
            const pollMinMs = getSettingDefaultNumber(
                "BOOTSTRAP_SCHEDULER_POLL_MIN_MS",
            );
            const pollMaxMs = getSettingDefaultNumber(
                "BOOTSTRAP_SCHEDULER_POLL_MAX_MS",
            );
            const client = rpc();
            const h = harness(client, {
                nowMs: () => nowMs,
                runLimit,
                pollMinMs,
            });
            const passLimit = Math.ceil(
                (waitingIds.length + runnableIds.length) / runLimit,
            );
            for (let pass = 0; pass < passLimit; pass++) {
                const result = await h.poll();
                expect(result.runIds.length).toBeLessThanOrEqual(runLimit);
                if (
                    waitingStatus === BOOTSTRAP_STEP_STATUS.Paused &&
                    pass === 0
                ) {
                    // Due work stays ahead of the bounded startup fallback,
                    // even when that fallback contains only earlier idle runs.
                    expect(result.runIds.slice(0, runnableIds.length)).toEqual(
                        runnableIds,
                    );
                }
                nowMs += resolveBootstrapLanePollDelayMs({
                    nextDueAt: result.nextDueAt,
                    pollMinMs,
                    pollMaxMs,
                    nowMs,
                });
            }
            for (const runId of runnableIds) {
                expect(collectionBlock(runId)).toBe(DEPLOYMENT);
                expect(
                    h.steps.getStep(runId, BOOTSTRAP_STEP_KEY.DeploymentBlock)
                        ?.status,
                ).toBe(BOOTSTRAP_STEP_STATUS.Succeeded);
            }
            for (const runId of waitingIds) {
                expect(
                    h.steps.getStep(runId, BOOTSTRAP_STEP_KEY.DeploymentBlock),
                ).toMatchObject({
                    status: waitingStatus,
                    attempts: 0,
                    resultJson: null,
                });
                expect(collectionBlock(runId)).toBeNull();
            }
            expect(client.getBytecode).toHaveBeenCalled();
            expect(client.findFirstLogPage).not.toHaveBeenCalled();
        },
    );

    it("starts before anchoring and saves the marker without changing the run lifecycle", async () => {
        seed(101);
        db.prepare(
            "INSERT INTO bootstrap_run_steps (run_id, step_key, status, blocking) VALUES (?, ?, ?, 1)",
        ).run(101, BOOTSTRAP_STEP_KEY.Anchor, BOOTSTRAP_STEP_STATUS.Ready);
        const client = rpc();
        const h = harness(client);
        await h.poll();
        expect(collectionBlock(101)).toBe(DEPLOYMENT);
        expect(h.runs.getRun(101)).toMatchObject({
            deploymentBlock: DEPLOYMENT,
            status: BOOTSTRAP_RUN_STATUS.Queued,
            anchorBlock: null,
        });
        expect(h.steps.getStep(101, BOOTSTRAP_STEP_KEY.Anchor)?.status).toBe(
            BOOTSTRAP_STEP_STATUS.Ready,
        );
        const step = h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock)!;
        expect(step.status).toBe(BOOTSTRAP_STEP_STATUS.Succeeded);
        expect(JSON.parse(step.resultJson!)).toMatchObject({
            deploymentBlock: DEPLOYMENT,
        });
        expect(client.getBlock.mock.calls.map(([number]) => number)).toEqual([
            100, 100,
        ]);
    });

    it("reclaims unfinished lookup after restart even when the run is completed", async () => {
        seed(101, BOOTSTRAP_RUN_STATUS.Completed);
        db.prepare(
            `UPDATE bootstrap_run_steps SET status = ?, lease_owner = ?, lease_until = ? WHERE run_id = ? AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
        ).run(BOOTSTRAP_STEP_STATUS.Running, "dead-worker", NOW - 1, 101);
        const h = harness();
        await h.poll();
        expect(collectionBlock(101)).toBe(DEPLOYMENT);
        expect(h.runs.getRun(101)?.status).toBe(BOOTSTRAP_RUN_STATUS.Completed);
    });

    it("keeps different mint blocks for collections on the same shared contract", async () => {
        seed(101, BOOTSTRAP_RUN_STATUS.Completed);
        const first = rpc();
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["100", "1"]');
        recordEnumeration(101, "100");
        await harness(first).poll();
        seed(102, BOOTSTRAP_RUN_STATUS.Completed);
        const second = rpc();
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_range_start_token_id = ?, manual_range_total_supply = ? WHERE run_id = 102",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualRange, "200", 5);
        recordEnumeration(102, "200");
        await harness(second).poll();
        expect(collectionBlock(101)).toBe(DEPLOYMENT);
        expect(collectionBlock(102)).toBe(75);
        expect(first.getBytecode).toHaveBeenCalled();
        expect(second.getBytecode).toHaveBeenCalled();
        expect(first.findFirstLogPage).toHaveBeenCalledWith(
            expect.objectContaining({
                args: expect.objectContaining({ tokenId: 100n }),
            }),
            expect.objectContaining({
                beforeRequest: expect.any(Function),
                onRequest: expect.any(Function),
            }),
        );
        expect(second.findFirstLogPage).toHaveBeenCalledWith(
            expect.objectContaining({
                address: ADDRESS,
                fromBlock: DEPLOYMENT,
                toBlock: 100,
                args: expect.objectContaining({ tokenId: 200n }),
            }),
            expect.objectContaining({
                beforeRequest: expect.any(Function),
                onRequest: expect.any(Function),
            }),
        );
    });

    it("uses code deployment for an entire contract without a shared-contract finding", async () => {
        seed(101);
        const client = rpc();
        client.findFirstLogPage.mockResolvedValue({
            log: mintLog(75),
            nextBlock: 101,
        });
        await harness(client).poll();
        expect(collectionBlock(101)).toBe(DEPLOYMENT);
        expect(client.getBytecode).toHaveBeenCalled();
        expect(client.findFirstLogPage).not.toHaveBeenCalled();
    });

    it.each([
        BOOTSTRAP_ENUMERATION_MODE.ManualRange,
        BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
    ])(
        "uses the first mint for manual %s scope without a shared-contract finding",
        async (mode) => {
            seed(101);
            db.prepare(
                "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ?, manual_range_start_token_id = ?, manual_range_total_supply = ? WHERE run_id = 101",
            ).run(
                mode,
                mode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
                    ? '["200", "1"]'
                    : null,
                mode === BOOTSTRAP_ENUMERATION_MODE.ManualRange ? "200" : null,
                mode === BOOTSTRAP_ENUMERATION_MODE.ManualRange ? 5 : null,
            );
            const client = rpc();
            recordEnumeration(101, "200");
            client.findFirstLogPage.mockResolvedValue({
                log: mintLog(75),
                nextBlock: 101,
            });
            await harness(client).poll();
            expect(collectionBlock(101)).toBe(75);
            expect(client.getBytecode).toHaveBeenCalled();
            expect(client.findFirstLogPage).toHaveBeenCalledWith(
                expect.objectContaining({
                    args: expect.objectContaining({ tokenId: 200n }),
                }),
                expect.objectContaining({
                    beforeRequest: expect.any(Function),
                    onRequest: expect.any(Function),
                }),
            );
        },
    );

    it("keeps a missing mint recoverable without failing the collection run", async () => {
        seed(101, BOOTSTRAP_RUN_STATUS.Completed);
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200"]');
        recordEnumeration(101, "200");
        const client = rpc();
        client.findFirstLogPage.mockResolvedValue({
            log: null,
            nextBlock: 101,
        });
        const h = harness(client);
        await h.poll();
        expect(collectionBlock(101)).toBeNull();
        expect(h.runs.getRun(101)?.status).toBe(BOOTSTRAP_RUN_STATUS.Completed);
        expect(
            h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock)?.status,
        ).toBe(BOOTSTRAP_STEP_STATUS.FailedRetry);
    });

    it("waits for a confirmed range token instead of searching its unminted start", async () => {
        seed(101);
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_range_start_token_id = ?, manual_range_total_supply = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualRange, "1", 1_000);
        const client = rpc();
        await harness(client).poll();
        expect(client.getBlockNumber).not.toHaveBeenCalled();
        expect(client.getBytecode).not.toHaveBeenCalled();
        expect(client.findFirstLogPage).not.toHaveBeenCalled();
        recordEnumeration(101, "2");
        db.prepare(
            `UPDATE bootstrap_run_steps SET next_attempt_at = 0 WHERE run_id = 101 AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
        ).run();
        await harness(client).poll();
        expect(collectionBlock(101)).toBe(DEPLOYMENT);
        expect(client.findFirstLogPage).toHaveBeenCalledWith(
            expect.objectContaining({
                args: expect.objectContaining({ tokenId: 2n }),
            }),
            expect.any(Object),
        );
    });

    it("stays pending when a count-only event and current balances have no run confirmation", async () => {
        seed(101, BOOTSTRAP_RUN_STATUS.Completed);
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_range_start_token_id = ?, manual_range_total_supply = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualRange, "1", 1_000);
        recordEnumeration(101);
        seedOwnedToken(101, "0"); // Outside this run's universe.
        seedOwnedToken(101, "1", true);
        seedOwnedToken(101, "2");
        const client = rpc();
        const h = harness(client);
        expect(
            h.store.getEnumerationConfirmation(h.runs.getRun(101)!),
        ).toBeNull();
        await h.poll();
        expect(collectionBlock(101)).toBeNull();
        expect(client.getBytecode).not.toHaveBeenCalled();
        expect(client.findFirstLogPage).not.toHaveBeenCalled();
    });

    it("does not reuse another run's owned inventory before enumeration confirms this run's scope", async () => {
        seed(101);
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_range_start_token_id = ?, manual_range_total_supply = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualRange, "1", 1_000);
        seedOwnedToken(101, "2");
        const client = rpc();
        await harness(client).poll();
        expect(client.getBytecode).not.toHaveBeenCalled();
        expect(client.findFirstLogPage).not.toHaveBeenCalled();
    });

    it("discards an old range-start mint cursor when enumeration supplies a different confirmed token", async () => {
        seed(101, BOOTSTRAP_RUN_STATUS.Completed);
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_range_start_token_id = ?, manual_range_total_supply = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualRange, "1", 1_000);
        recordEnumeration(101, "2");
        db.prepare(
            `UPDATE bootstrap_run_steps SET result_json = ? WHERE run_id = 101 AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
        ).run(
            JSON.stringify({
                firstTokenId: "1",
                upperBlock: 100,
                upperBlockHash: HASH,
                lowerBlock: DEPLOYMENT,
                codeSearch: null,
                nextBlock: 90,
            }),
        );
        const client = rpc();
        await harness(client).poll();
        expect(client.findFirstLogPage).toHaveBeenCalledWith(
            expect.objectContaining({
                fromBlock: DEPLOYMENT,
                args: expect.objectContaining({ tokenId: 2n }),
            }),
            expect.any(Object),
        );
        expect(collectionBlock(101)).toBe(DEPLOYMENT);
    });

    it("uses the confirmed enumeration output instead of an absent first list candidate", async () => {
        seed(101);
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200", "2"]');
        recordEnumeration(101, "2");
        const client = rpc();
        await harness(client).poll();
        expect(collectionBlock(101)).toBe(DEPLOYMENT);
        expect(client.findFirstLogPage).toHaveBeenCalledWith(
            expect.objectContaining({
                args: expect.objectContaining({ tokenId: 2n }),
            }),
            expect.any(Object),
        );
    });

    it("rejects an enumerated token outside the run's declared range", async () => {
        seed(101);
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_range_start_token_id = ?, manual_range_total_supply = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualRange, "200", 5);
        recordEnumeration(101, "2");
        const client = rpc();
        await harness(client).poll();
        expect(client.getBytecode).not.toHaveBeenCalled();
        expect(client.findFirstLogPage).not.toHaveBeenCalled();
    });

    it("retains the confirmed token when restart appends a count-only enumeration record", async () => {
        seed(101);
        db.prepare(
            "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_range_start_token_id = ?, manual_range_total_supply = ? WHERE run_id = 101",
        ).run(BOOTSTRAP_ENUMERATION_MODE.ManualRange, "1", 1_000);
        recordEnumeration(101, "200");
        recordEnumeration(101);
        const client = rpc();
        await harness(client).poll();
        expect(collectionBlock(101)).toBe(75);
        expect(client.findFirstLogPage).toHaveBeenCalledWith(
            expect.objectContaining({
                args: expect.objectContaining({ tokenId: 200n }),
            }),
            expect.any(Object),
        );
    });

    it("waits for the first runtime token and recovers it from enumeration after a restart", async () => {
        seed(101, BOOTSTRAP_RUN_STATUS.Completed, null, 1, true);
        const client = rpc();
        await harness(client).poll();
        expect(collectionBlock(101)).toBeNull();
        expect(client.getBytecode).not.toHaveBeenCalled();
        expect(client.findFirstLogPage).not.toHaveBeenCalled();
        recordEnumeration(101, "200");
        db.prepare(
            `UPDATE bootstrap_run_steps SET next_attempt_at = 0 WHERE run_id = 101 AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
        ).run();
        await harness(client).poll();
        expect(collectionBlock(101)).toBe(75);
        expect(client.findFirstLogPage).toHaveBeenCalledWith(
            expect.objectContaining({
                args: expect.objectContaining({ tokenId: 200n }),
            }),
            expect.objectContaining({
                beforeRequest: expect.any(Function),
                onRequest: expect.any(Function),
            }),
        );
    });

    it("preserves supplied deployment hints", async () => {
        seed(101, BOOTSTRAP_RUN_STATUS.Completed, 60);
        const client = rpc();
        await harness(client).poll();
        expect(collectionBlock(101)).toBe(60);
        expect(client.getBytecode).not.toHaveBeenCalled();
        expect(client.findFirstLogPage).not.toHaveBeenCalled();
    });

    it.each([
        BOOTSTRAP_STEP_STATUS.Ready,
        BOOTSTRAP_STEP_STATUS.FailedRetry,
        BOOTSTRAP_STEP_STATUS.Running,
    ])(
        "never schedules or claims %s work from a failed run",
        async (stepStatus) => {
            seed(101, BOOTSTRAP_RUN_STATUS.Failed);
            db.prepare(
                `UPDATE bootstrap_run_steps SET status = ?, lease_until = ? WHERE run_id = 101 AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
            ).run(
                stepStatus,
                stepStatus === BOOTSTRAP_STEP_STATUS.Running ? NOW - 1 : null,
            );
            const client = rpc();
            const h = harness(client);
            const query = {
                chainId: 1,
                stepKeys: [BOOTSTRAP_STEP_KEY.DeploymentBlock],
            };
            expect(
                h.steps.listDueStepRunIds({ ...query, nowMs: NOW, limit: 1 }),
            ).toEqual([]);
            expect(h.steps.getNextDueStepAt(query)).toBeNull();
            expect(h.runs.listRunsForStartupSweep(1, 1)).toEqual([]);
            expect(
                h.steps.claimReadySteps({
                    runId: 101,
                    stepKeys: query.stepKeys,
                    leaseOwner: OWNER,
                    leaseUntil: NOW + 10_000,
                    nowMs: NOW,
                    limit: 1,
                }),
            ).toEqual([]);
            await h.poll();
            expect(client.getBlockNumber).not.toHaveBeenCalled();
            expect(client.findFirstLogPage).not.toHaveBeenCalled();
            expect(client.getBytecode).not.toHaveBeenCalled();
            expect(collectionBlock(101)).toBeNull();

            // Failed rows must be excluded before LIMIT so they cannot starve eligible work.
            seed(102, BOOTSTRAP_RUN_STATUS.Completed);
            expect(
                h.steps.listDueStepRunIds({ ...query, nowMs: NOW, limit: 1 }),
            ).toEqual([102]);
            expect(
                h.runs.listRunsForStartupSweep(1, 1).map((run) => run.runId),
            ).toEqual([102]);
            await h.poll();
            expect(collectionBlock(102)).toBe(DEPLOYMENT);
        },
    );

    it.each([
        { mint: false, reject: false },
        { mint: false, reject: true },
        { mint: true, reject: false },
        { mint: true, reject: true },
    ])(
        "stops a lookup when its run fails during an RPC: %j",
        async ({ mint, reject }) => {
            seed(101);
            if (mint)
                db.prepare(
                    "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
                ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200"]');
            recordEnumeration(101, "200");
            const client = rpc();
            const h = harness(client);
            const fail = () => {
                h.runs.updateRunStatus(101, BOOTSTRAP_RUN_STATUS.Failed);
                if (reject) throw new Error("RPC stopped responding");
            };
            if (mint)
                client.findFirstLogPage.mockImplementationOnce(async () => {
                    fail();
                    return { log: mintLog(75), nextBlock: 101 };
                });
            else
                client.getBytecode.mockImplementationOnce(async () => {
                    fail();
                    return "0x1234";
                });
            await h.poll();
            await h.poll();
            expect(collectionBlock(101)).toBeNull();
            expect(h.runs.getRun(101)).toMatchObject({
                status: BOOTSTRAP_RUN_STATUS.Failed,
                deploymentBlock: null,
            });
            expect(
                h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock),
            ).toMatchObject({
                status: BOOTSTRAP_STEP_STATUS.Running,
                attempts: 0,
                lastError: null,
            });
            expect(
                mint ? client.findFirstLogPage : client.getBytecode,
            ).toHaveBeenCalledTimes(1);
            expect(client.getBlock).toHaveBeenCalledTimes(1);
        },
    );

    it.each(
        Object.values(BOOTSTRAP_RUN_STATUS).filter(
            (status) => status !== BOOTSTRAP_RUN_STATUS.Failed,
        ),
    )(
        "a late automatic %s transition cannot revive a failed run or publish its mint block",
        async (status) => {
            seed(101);
            db.prepare(
                "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
            ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200"]');
            recordEnumeration(101, "200");
            const requested = deferred<void>();
            const reply = deferred<RpcFirstLogPage>();
            const client = rpc();
            client.findFirstLogPage.mockImplementationOnce(async () => {
                requested.resolve();
                return reply.promise;
            });
            const h = harness(client);
            const polling = h.poll();
            await requested.promise;
            h.runs.updateRunStatus(101, BOOTSTRAP_RUN_STATUS.Failed);
            h.runs.updateRunStatus(101, status);
            reply.resolve({ log: mintLog(75), nextBlock: 101 });
            await polling;

            expect(collectionBlock(101)).toBeNull();
            expect(h.runs.getRun(101)).toMatchObject({
                status: BOOTSTRAP_RUN_STATUS.Failed,
                deploymentBlock: null,
            });
            expect(client.findFirstLogPage).toHaveBeenCalledTimes(1);
            expect(client.getBlock).toHaveBeenCalledTimes(1);
        },
    );

    it("rejects progress, lease renewal, and publication after the run fails with a current lease", () => {
        seed(101);
        const h = harness();
        h.steps.claimReadySteps({
            runId: 101,
            stepKeys: [BOOTSTRAP_STEP_KEY.DeploymentBlock],
            leaseOwner: OWNER,
            leaseUntil: NOW + 10_000,
            nowMs: NOW,
            limit: 1,
        });
        const claim = {
            runId: 101,
            chainId: 1,
            collectionId: 101,
            address: ADDRESS,
            leaseOwner: OWNER,
        };
        expect(h.store.ownsLease(claim)).toBe(true);
        h.runs.updateRunStatus(101, BOOTSTRAP_RUN_STATUS.Failed);
        expect(h.store.ownsLease(claim)).toBe(false);
        h.store.recordSearchRange(claim, { fromBlock: 0, toBlock: 100 });
        h.steps.renewStepLease({
            runId: 101,
            stepKey: BOOTSTRAP_STEP_KEY.DeploymentBlock,
            leaseOwner: OWNER,
            leaseUntil: NOW + 20_000,
        });
        expect(h.store.complete(claim, { deploymentBlock: 75 })).toBe(false);
        expect(
            h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock),
        ).toMatchObject({
            status: BOOTSTRAP_STEP_STATUS.Running,
            resultJson: null,
            leaseUntil: NOW + 10_000,
        });
        expect(collectionBlock(101)).toBeNull();
        expect(h.runs.getRun(101)?.deploymentBlock).toBeNull();
    });

    it.each(Object.values(BOOTSTRAP_RUN_STATUS))(
        "startup acknowledgement queues only requested runs, preserving %s",
        async (status) => {
            const publish =
                vi.fn<BootstrapCommandQueuePort["publishBootstrapStart"]>();
            const { repository, create } = bootstrapCreator(publish);
            let beforeAcknowledgement:
                | ReturnType<SqliteBootstrapRunsRepository["getRunById"]>
                | undefined;
            publish.mockImplementationOnce(async ({ runId }) => {
                repository.updateRunStatus(
                    runId,
                    status,
                    status === BOOTSTRAP_RUN_STATUS.Failed
                        ? { code: "test-failure", message: "Bootstrap failed" }
                        : null,
                );
                beforeAcknowledgement = repository.getRunById(1, runId);
            });
            const result = await create.createRun(manualInput("1"));
            const requested = status === BOOTSTRAP_RUN_STATUS.Requested;
            expect(result.status).toBe(
                requested ? BOOTSTRAP_RUN_STATUS.Queued : status,
            );
            if (!requested) {
                expect(repository.getRunById(1, result.runId)).toEqual(
                    beforeAcknowledgement,
                );
            }
            expect(
                repository
                    .listRunEvents(result.runId)
                    .filter(
                        (event) =>
                            event.eventCode ===
                            BOOTSTRAP_RUN_EVENT_CODE.RunQueued,
                    ),
            ).toHaveLength(requested ? 1 : 0);
        },
    );

    it.each([false, true])(
        "keeps a failed lookup fenced after late startup acknowledgement; replacement completed: %s",
        async (replacementCompleted) => {
            const queueEntered = deferred<{
                runId: number;
                collectionId: number;
            }>();
            const queueReply = deferred<void>();
            const publish = vi.fn<
                BootstrapCommandQueuePort["publishBootstrapStart"]
            >(async () => {});
            publish.mockImplementationOnce(async (input) => {
                queueEntered.resolve(input);
                await queueReply.promise;
            });
            const { repository, create } = bootstrapCreator(publish);
            const oldCreation = create.createRun(manualInput("200"));
            const old = await queueEntered.promise;
            recordEnumeration(old.runId, "200");
            const client = rpc();
            const h = harness(client);
            const mintEntered = deferred<void>();
            const mintReply = deferred<RpcFirstLogPage>();
            client.findFirstLogPage.mockImplementationOnce(async () => {
                mintEntered.resolve();
                return mintReply.promise;
            });
            expect(
                h.steps.claimReadySteps({
                    runId: old.runId,
                    stepKeys: [BOOTSTRAP_STEP_KEY.DeploymentBlock],
                    leaseOwner: OWNER,
                    leaseUntil: NOW + 10_000,
                    nowMs: NOW,
                    limit: 1,
                }),
            ).toHaveLength(1);
            const oldSearch = h.executor.search({
                run: h.runs.getRun(old.runId)!,
                leaseOwner: OWNER,
                reorgDepth: 1,
            });
            await mintEntered.promise;
            h.runs.updateRunStatus(old.runId, BOOTSTRAP_RUN_STATUS.Failed, {
                code: "test-failure",
                message: "Bootstrap failed",
            });
            const failedRun = h.runs.getRun(old.runId);
            const failedStep = h.steps.getStep(
                old.runId,
                BOOTSTRAP_STEP_KEY.DeploymentBlock,
            );
            const replacement = await create.createRun(manualInput("1"));
            recordEnumeration(replacement.runId, "1");
            if (replacementCompleted) {
                // Complete mandatory work through the real reconciler while deployment remains ready.
                for (const step of h.steps.listRunSteps(replacement.runId)) {
                    if (step.stepKey !== BOOTSTRAP_STEP_KEY.DeploymentBlock) {
                        h.steps.markStepSucceeded(
                            replacement.runId,
                            step.stepKey,
                            {
                                completed: 1,
                                total: 1,
                            },
                        );
                    }
                }
                db.prepare(
                    "UPDATE bootstrap_runs SET anchor_block = ?, anchor_block_hash = ?, anchor_block_timestamp = ? WHERE run_id = ?",
                ).run(100, HASH, 1, replacement.runId);
                db.prepare(
                    "UPDATE collections SET status = ?, bootstrap_anchor_block = ?, bootstrap_last_synced_block = ? WHERE collection_id = ?",
                ).run(COLLECTION_STATUS.Live, 100, 100, old.collectionId);
                const reconciler = new BootstrapLiveRunCompletionReconciler(
                    new SqliteCollectionRegistry(),
                    h.runs,
                    h.steps,
                    new SqliteBootstrapStorage(),
                );
                expect(reconciler.reconcile(replacement.runId).completed).toBe(
                    true,
                );
                expect(h.runs.getRun(replacement.runId)?.status).toBe(
                    BOOTSTRAP_RUN_STATUS.Completed,
                );
            }
            queueReply.resolve();
            await expect(oldCreation).resolves.toMatchObject({
                runId: old.runId,
                status: BOOTSTRAP_RUN_STATUS.Failed,
            });
            expect(h.runs.getRun(old.runId)).toEqual(failedRun);
            expect(
                repository
                    .listRunEvents(old.runId)
                    .map((event) => event.eventCode),
            ).not.toContain(BOOTSTRAP_RUN_EVENT_CODE.RunQueued);
            const claim = {
                runId: old.runId,
                chainId: 1,
                collectionId: old.collectionId,
                address: ADDRESS,
                leaseOwner: OWNER,
            };
            expect(h.store.ownsLease(claim)).toBe(false);
            h.store.recordSearchRange(claim, { fromBlock: 7, toBlock: 9 });
            expect(h.store.complete(claim, { deploymentBlock: 75 })).toBe(
                false,
            );
            mintReply.resolve({ log: mintLog(75), nextBlock: 101 });
            expect(await oldSearch).toBe(false);
            expect(
                h.steps.getStep(old.runId, BOOTSTRAP_STEP_KEY.DeploymentBlock),
            ).toEqual(failedStep);
            expect(collectionBlock(old.collectionId)).toBeNull();
            expect(h.runs.getRun(old.runId)?.deploymentBlock).toBeNull();
            await h.poll();
            expect(
                client.findFirstLogPage.mock.calls.map(
                    ([filter]) => filter.args?.tokenId,
                ),
            ).toEqual([200n, 1n]);
            expect(collectionBlock(old.collectionId)).toBe(DEPLOYMENT);
            expect(h.runs.getRun(replacement.runId)?.deploymentBlock).toBe(
                DEPLOYMENT,
            );
            expect(
                h.steps.getStep(
                    replacement.runId,
                    BOOTSTRAP_STEP_KEY.DeploymentBlock,
                )?.status,
            ).toBe(BOOTSTRAP_STEP_STATUS.Succeeded);
        },
    );

    it.each([
        { sharedContract: false, reject: false },
        { sharedContract: false, reject: true },
        { sharedContract: true, reject: false },
        { sharedContract: true, reject: true },
    ])(
        "honors pause during an in-flight RPC: %j",
        async ({ sharedContract, reject }) => {
            seed(101);
            if (sharedContract)
                db.prepare(
                    "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
                ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200"]');
            recordEnumeration(101, "200");
            const pause = () => {
                db.prepare(
                    `UPDATE bootstrap_run_steps SET status = ?, lease_owner = NULL, lease_until = NULL WHERE run_id = ? AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
                ).run(BOOTSTRAP_STEP_STATUS.Paused, 101);
                if (reject) throw new Error("RPC stopped responding");
            };
            const client = rpc();
            if (sharedContract)
                client.findFirstLogPage.mockImplementationOnce(async () => {
                    pause();
                    return { log: mintLog(75), nextBlock: 101 };
                });
            else
                client.getBytecode.mockImplementationOnce(async () => {
                    pause();
                    return "0x1234";
                });
            const h = harness(client);
            await h.poll();
            expect(collectionBlock(101)).toBeNull();
            expect(
                h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock),
            ).toMatchObject({
                status: BOOTSTRAP_STEP_STATUS.Paused,
                lastError: null,
            });
        },
    );

    it("rejects stale completion after another owner claims the step", async () => {
        seed(101);
        const client = rpc();
        client.getBytecode.mockImplementationOnce(async () => {
            db.prepare(
                `UPDATE bootstrap_run_steps SET lease_owner = ? WHERE run_id = ? AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
            ).run("new-owner", 101);
            return "0x1234";
        });
        const h = harness(client);
        await h.poll();
        expect(collectionBlock(101)).toBeNull();
        expect(
            h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock),
        ).toMatchObject({
            status: BOOTSTRAP_STEP_STATUS.Running,
            leaseOwner: "new-owner",
        });
    });

    it.each([false, true])(
        "keeps unavailable code history recoverable without starting a genesis mint scan: manual=%s",
        async (manual) => {
            seed(101, BOOTSTRAP_RUN_STATUS.Completed);
            if (manual)
                db.prepare(
                    "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
                ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200"]');
            recordEnumeration(101, "200");
            const client = rpc();
            client.getBytecode.mockRejectedValue(
                new Error("historical state unavailable"),
            );
            const h = harness(client);
            await h.poll();
            expect(collectionBlock(101)).toBeNull();
            expect(h.runs.getRun(101)?.status).toBe(
                BOOTSTRAP_RUN_STATUS.Completed,
            );
            expect(client.findFirstLogPage).not.toHaveBeenCalled();
            expect(
                h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock),
            ).toMatchObject({
                status: BOOTSTRAP_STEP_STATUS.FailedRetry,
                attempts: 1,
            });
        },
    );

    it.each([BOOTSTRAP_RUN_STATUS.Failed, BOOTSTRAP_STEP_STATUS.Paused])(
        "stops a mint lookup during the code-bound search when it becomes %s",
        async (state) => {
            seed(101);
            db.prepare(
                "UPDATE bootstrap_runs SET enumeration_mode = ?, manual_token_ids_json = ? WHERE run_id = 101",
            ).run(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, '["200"]');
            recordEnumeration(101, "200");
            const client = rpc();
            const h = harness(client);
            client.getBytecode.mockImplementationOnce(async () => {
                if (state === BOOTSTRAP_RUN_STATUS.Failed)
                    h.runs.updateRunStatus(101, state);
                else
                    db.prepare(
                        `UPDATE bootstrap_run_steps SET status = ?, lease_owner = NULL, lease_until = NULL WHERE run_id = 101 AND step_key = \'${BOOTSTRAP_STEP_KEY.DeploymentBlock}\'`,
                    ).run(state);
                return "0x1234";
            });
            await h.poll();
            expect(client.getBytecode).toHaveBeenCalledTimes(1);
            expect(client.findFirstLogPage).not.toHaveBeenCalled();
            expect(collectionBlock(101)).toBeNull();
            expect(h.store.getSearchProgress(101)).toMatchObject({
                lowerBlock: null,
                nextBlock: 0,
            });
        },
    );

    it("does not save results if the pinned chain block changes", async () => {
        seed(101);
        const client = rpc();
        client.getBlock.mockImplementationOnce(async (number) => ({
            number,
            hash: HASH,
            parentHash: HASH,
            timestamp: 1,
            transactions: [],
        }));
        client.getBlock.mockImplementationOnce(async (number) => ({
            number,
            hash: `0x${"b".repeat(64)}`,
            parentHash: HASH,
            timestamp: 1,
            transactions: [],
        }));
        const h = harness(client);
        await h.poll();
        expect(collectionBlock(101)).toBeNull();
        expect(
            h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock)?.status,
        ).toBe(BOOTSTRAP_STEP_STATUS.FailedRetry);
    });

    it("preserves a supplied hint that arrives while discovery is in flight", async () => {
        seed(101);
        const client = rpc();
        const readBlock = client.getBlock.getMockImplementation()!;
        let headers = 0;
        client.getBlock.mockImplementation(async (number) => {
            if (++headers === 2)
                db.prepare(
                    "UPDATE collections SET deployment_block = 60 WHERE collection_id = 101",
                ).run();
            return readBlock(number);
        });
        const h = harness(client);
        await h.poll();
        expect(collectionBlock(101)).toBe(60);
        expect(h.runs.getRun(101)?.deploymentBlock).toBe(60);
    });

    it("rejects publication when the collection contract identity changes", async () => {
        seed(101);
        const client = rpc();
        const readBlock = client.getBlock.getMockImplementation()!;
        let headers = 0;
        client.getBlock.mockImplementation(async (number) => {
            if (++headers === 2)
                db.prepare(
                    "UPDATE collections SET address = ? WHERE collection_id = 101",
                ).run("0x2222222222222222222222222222222222222222");
            return readBlock(number);
        });
        const h = harness(client);
        await h.poll();
        expect(collectionBlock(101)).toBeNull();
        expect(h.runs.getRun(101)?.deploymentBlock).toBeNull();
        expect(
            h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock)?.status,
        ).toBe(BOOTSTRAP_STEP_STATUS.Ready);
    });

    it("fences completion and progress writes after lease expiry", () => {
        seed(101);
        const h = harness();
        h.steps.claimReadySteps({
            runId: 101,
            stepKeys: [BOOTSTRAP_STEP_KEY.DeploymentBlock],
            leaseOwner: OWNER,
            leaseUntil: NOW - 1,
            nowMs: NOW - 2,
            limit: 1,
        });
        const claim = {
            runId: 101,
            chainId: 1,
            collectionId: 101,
            address: ADDRESS,
            leaseOwner: OWNER,
        };
        h.store.recordSearchRange(claim, { fromBlock: 0, toBlock: 100 });
        expect(
            h.store.complete(claim, {
                deploymentBlock: DEPLOYMENT,
            }),
        ).toBe(false);
        expect(collectionBlock(101)).toBeNull();
        expect(
            h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock)
                ?.resultJson,
        ).toBeNull();
    });

    it("rolls back step and run settlement when saving the collection fails", async () => {
        seed(101);
        db.exec(
            "CREATE TRIGGER reject_deployment BEFORE UPDATE OF deployment_block ON collections BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END",
        );
        try {
            const h = harness();
            await h.poll();
            expect(collectionBlock(101)).toBeNull();
            expect(h.runs.getRun(101)?.deploymentBlock).toBeNull();
            expect(
                h.steps.getStep(101, BOOTSTRAP_STEP_KEY.DeploymentBlock)
                    ?.status,
            ).toBe(BOOTSTRAP_STEP_STATUS.FailedRetry);
        } finally {
            db.exec("DROP TRIGGER reject_deployment");
        }
    });
});
