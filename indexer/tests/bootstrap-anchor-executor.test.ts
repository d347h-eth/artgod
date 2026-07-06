import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    type BootstrapRunStatus,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import {
    BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME,
    BOOTSTRAP_ANCHOR_FAILURE_CODE,
    BootstrapAnchorExecutor,
    type BootstrapAnchorCollectionPort,
    type BootstrapAnchorRunsPort,
    type BootstrapAnchorStepsPort,
} from "../src/application/bootstrap-anchor-executor.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { BootstrapRunDefinition } from "../src/ports/bootstrap-runs.js";
import type { RpcBlock } from "../src/ports/rpc.js";

const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";
const TEST_BLOCK_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("bootstrap anchor executor", () => {
    it("fails unsupported standards before selecting an anchor", async () => {
        const harness = createHarness({
            run: buildRun({ requestStandard: COLLECTION_STANDARD.Erc1155 }),
        });

        const result = await harness.executor.anchor({
            run: harness.run,
            reorgDepth: 10,
        });

        expect(result).toEqual({
            outcome: BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.UnsupportedStandard,
            run: harness.run,
            anchor: null,
        });
        expect(harness.runStatusUpdates).toEqual([
            {
                runId: 41,
                status: BOOTSTRAP_RUN_STATUS.Failed,
                error: {
                    code: BOOTSTRAP_ANCHOR_FAILURE_CODE.UnsupportedStandard,
                    message: `Unsupported standard: ${COLLECTION_STANDARD.Erc1155}`,
                },
            },
        ]);
        expect(harness.events.map((event) => event.eventCode)).toEqual([
            BOOTSTRAP_RUN_EVENT_CODE.RunFailed,
        ]);
        expect(harness.failedSteps).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Anchor,
                attempts: 1,
                error: `Unsupported standard: ${COLLECTION_STANDARD.Erc1155}`,
            },
        ]);
        expect(harness.runningSteps).toEqual([]);
    });

    it("fails when the confirmed anchor would be below block one", async () => {
        const harness = createHarness({ headBlock: 5 });

        const result = await harness.executor.anchor({
            run: harness.run,
            reorgDepth: 10,
        });

        expect(result.outcome).toBe(
            BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.InvalidAnchor,
        );
        expect(harness.failedSteps).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Anchor,
                attempts: 1,
                error: "Anchor block is invalid",
            },
        ]);
        expect(harness.runStatusUpdates).toEqual([
            {
                runId: 41,
                status: BOOTSTRAP_RUN_STATUS.Failed,
                error: {
                    code: BOOTSTRAP_ANCHOR_FAILURE_CODE.InvalidAnchor,
                    message: "Anchor block is invalid",
                },
            },
        ]);
        expect(harness.anchorUpdates).toEqual([]);
    });

    it("persists anchor state and starts the collection on success", async () => {
        const harness = createHarness({ headBlock: 120 });

        const result = await harness.executor.anchor({
            run: harness.run,
            reorgDepth: 20,
        });

        expect(result).toEqual({
            outcome: BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.Anchored,
            run: harness.run,
            anchor: {
                anchorBlock: 100,
                anchorHash: TEST_BLOCK_HASH,
                anchorTimestamp: 1726000000,
            },
        });
        expect(harness.anchorUpdates).toEqual([
            {
                runId: 41,
                anchorBlock: 100,
                anchorHash: TEST_BLOCK_HASH,
                anchorTimestamp: 1726000000,
            },
        ]);
        expect(harness.runStatusUpdates).toEqual([
            {
                runId: 41,
                status: BOOTSTRAP_RUN_STATUS.Metadata,
                error: undefined,
            },
        ]);
        expect(harness.succeededSteps).toEqual([
            { runId: 41, stepKey: BOOTSTRAP_STEP_KEY.Anchor },
        ]);
        expect(harness.collectionStarts).toEqual([
            { chainId: 1, collectionId: 7, anchorBlock: 100 },
        ]);
        expect(harness.events.map((event) => event.eventCode)).toEqual([
            BOOTSTRAP_RUN_EVENT_CODE.RunAnchorSelected,
        ]);
    });

    it("fails the run when the collection row is missing after anchor selection", async () => {
        const harness = createHarness({
            headBlock: 120,
            collectionStartResult: false,
        });

        const result = await harness.executor.anchor({
            run: harness.run,
            reorgDepth: 20,
        });

        expect(result.outcome).toBe(
            BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.CollectionMissing,
        );
        expect(result.anchor).toEqual({
            anchorBlock: 100,
            anchorHash: TEST_BLOCK_HASH,
            anchorTimestamp: 1726000000,
        });
        expect(harness.runStatusUpdates).toEqual([
            {
                runId: 41,
                status: BOOTSTRAP_RUN_STATUS.Metadata,
                error: undefined,
            },
            {
                runId: 41,
                status: BOOTSTRAP_RUN_STATUS.Failed,
                error: {
                    code: BOOTSTRAP_ANCHOR_FAILURE_CODE.MissingCollection,
                    message: "Collection row is missing",
                },
            },
        ]);
    });
});

type Harness = {
    executor: BootstrapAnchorExecutor;
    run: BootstrapRunDefinition;
    runStatusUpdates: Array<{
        runId: number;
        status: BootstrapRunStatus;
        error?: { code: string; message: string } | null;
    }>;
    anchorUpdates: Array<{
        runId: number;
        anchorBlock: number;
        anchorHash: string;
        anchorTimestamp: number;
    }>;
    events: Array<Parameters<BootstrapAnchorRunsPort["appendRunEvent"]>[0]>;
    runningSteps: Array<{ runId: number; stepKey: typeof BOOTSTRAP_STEP_KEY.Anchor }>;
    succeededSteps: Array<{
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.Anchor;
    }>;
    failedSteps: Array<{
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.Anchor;
        attempts: number;
        error: string;
    }>;
    collectionStarts: Array<{
        chainId: number;
        collectionId: number;
        anchorBlock: number;
    }>;
};

function createHarness(input: {
    run?: BootstrapRunDefinition;
    headBlock?: number;
    collectionStartResult?: boolean;
}): Harness {
    const run = input.run ?? buildRun({});
    const runStatusUpdates: Harness["runStatusUpdates"] = [];
    const anchorUpdates: Harness["anchorUpdates"] = [];
    const events: Harness["events"] = [];
    const runningSteps: Harness["runningSteps"] = [];
    const succeededSteps: Harness["succeededSteps"] = [];
    const failedSteps: Harness["failedSteps"] = [];
    const collectionStarts: Harness["collectionStarts"] = [];
    const runsPort: BootstrapAnchorRunsPort = {
        updateRunStatus: (runId, status, error) => {
            runStatusUpdates.push({ runId, status, error });
            if (runId === run.runId) {
                run.status = status;
            }
        },
        updateRunAnchor: (anchor) => {
            anchorUpdates.push(anchor);
        },
        appendRunEvent: (event) => {
            events.push(event);
        },
    };
    const stepsPort: BootstrapAnchorStepsPort = {
        markStepRunning: (runId, stepKey) => {
            runningSteps.push({ runId, stepKey });
        },
        markStepSucceeded: (runId, stepKey) => {
            succeededSteps.push({ runId, stepKey });
        },
        markStepFailedTerminal: (failure) => {
            failedSteps.push(failure);
        },
    };
    const collectionPort: BootstrapAnchorCollectionPort = {
        markBootstrapStarted: (chainId, collectionId, anchorBlock) => {
            collectionStarts.push({ chainId, collectionId, anchorBlock });
            return input.collectionStartResult ?? true;
        },
    };
    const executor = new BootstrapAnchorExecutor(
        {
            getBlockNumber: async () => input.headBlock ?? 120,
            getBlock: async (blockNumber) => buildBlock(blockNumber),
        },
        runsPort,
        stepsPort,
        collectionPort,
    );

    return {
        executor,
        run,
        runStatusUpdates,
        anchorUpdates,
        events,
        runningSteps,
        succeededSteps,
        failedSteps,
        collectionStarts,
    };
}

function buildRun(input: {
    requestStandard?: BootstrapRunDefinition["requestStandard"];
    status?: BootstrapRunStatus;
}): BootstrapRunDefinition {
    return {
        runId: 41,
        chainId: 1,
        collectionId: 7,
        requestSlug: "milady-by-remilia-corporation",
        requestAddress: TEST_CONTRACT_ADDRESS,
        requestStandard: input.requestStandard ?? COLLECTION_STANDARD.Erc721,
        imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
        animationSourceField: null,
        requestExtensionKey: null,
        metadataMode: BOOTSTRAP_METADATA_MODE.BestEffort,
        enumerationMode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
        manualTokenIdsJson: null,
        manualRangeStartTokenId: null,
        manualRangeTotalSupply: null,
        imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
        imageCacheMaxDimension: 1024,
        deploymentBlock: null,
        status: input.status ?? BOOTSTRAP_RUN_STATUS.Queued,
        anchorBlock: null,
        anchorBlockHash: null,
        anchorBlockTimestamp: null,
    };
}

function buildBlock(blockNumber: number): RpcBlock {
    return {
        number: blockNumber,
        hash: TEST_BLOCK_HASH,
        parentHash:
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        timestamp: 1726000000,
        transactions: [],
    };
}
