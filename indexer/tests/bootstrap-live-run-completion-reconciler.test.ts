import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    type BootstrapRunStatus,
    type BootstrapStepKey,
    type BootstrapStepStatus,
    type BootstrapTaskCounts,
} from "@artgod/shared/bootstrap/pipeline";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION } from "@artgod/shared/config/bootstrap";
import { COLLECTION_STATUS, type CollectionStatus } from "@artgod/shared/types";
import { BootstrapLiveRunCompletionReconciler } from "../src/application/bootstrap-live-run-completion-reconciler.js";
import {
    CollectionRecord,
    CollectionTokenScope,
    COLLECTION_STANDARD,
} from "../src/domain/collections.js";
import type { BootstrapRunDefinition } from "../src/ports/bootstrap-runs.js";
import type { BootstrapStepRecord } from "../src/ports/bootstrap-steps.js";

const TEST_CHAIN_ID = 1;
const TEST_COLLECTION_ID = 42;
const TEST_RUN_ID = 101;
const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";
const TEST_ANCHOR_BLOCK = 100;
const TEST_ANCHOR_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_ANCHOR_TIMESTAMP = 1_700_000_000;
const TEST_SLUG = "test-collection";
const EMPTY_COUNTS: BootstrapTaskCounts = {
    pending: 0,
    retry: 0,
    succeeded: 0,
    failedTerminal: 0,
    total: 0,
};

describe("BootstrapLiveRunCompletionReconciler", () => {
    it("restores completed status for a live run after every step settles", () => {
        const harness = buildHarness({
            run: buildRun({ status: BOOTSTRAP_RUN_STATUS.Metadata }),
            collection: buildCollection(COLLECTION_STATUS.Live),
            steps: [
                succeededStep(BOOTSTRAP_STEP_KEY.Anchor),
                succeededStep(BOOTSTRAP_STEP_KEY.Enumeration),
                succeededStep(BOOTSTRAP_STEP_KEY.Metadata),
                succeededStep(BOOTSTRAP_STEP_KEY.Ownership),
                succeededStep(BOOTSTRAP_STEP_KEY.Backfill),
                succeededStep(BOOTSTRAP_STEP_KEY.CollectionLive),
                failedTerminalStep(BOOTSTRAP_STEP_KEY.ImageCache, false),
            ],
        });

        const result = harness.reconciler.reconcile(TEST_RUN_ID);

        expect(result.completed).toBe(true);
        expect(harness.run?.status).toBe(BOOTSTRAP_RUN_STATUS.Completed);
        expect(harness.updateStatuses).toEqual([
            BOOTSTRAP_RUN_STATUS.Completed,
        ]);
    });

    it("keeps the run active while a non-blocking side lane is recoverable", () => {
        const harness = buildHarness({
            run: buildRun({ status: BOOTSTRAP_RUN_STATUS.Metadata }),
            collection: buildCollection(COLLECTION_STATUS.Live),
            steps: [
                succeededStep(BOOTSTRAP_STEP_KEY.Anchor),
                succeededStep(BOOTSTRAP_STEP_KEY.Enumeration),
                succeededStep(BOOTSTRAP_STEP_KEY.Metadata),
                succeededStep(BOOTSTRAP_STEP_KEY.Ownership),
                succeededStep(BOOTSTRAP_STEP_KEY.Backfill),
                succeededStep(BOOTSTRAP_STEP_KEY.CollectionLive),
                readyStep(BOOTSTRAP_STEP_KEY.ImageCache, false),
            ],
        });

        const result = harness.reconciler.reconcile(TEST_RUN_ID);

        expect(result.completed).toBe(false);
        expect(harness.run?.status).toBe(BOOTSTRAP_RUN_STATUS.Metadata);
        expect(harness.updateStatuses).toEqual([]);
    });

    it("does not complete when a blocking step failed terminally", () => {
        const harness = buildHarness({
            run: buildRun({ status: BOOTSTRAP_RUN_STATUS.Metadata }),
            collection: buildCollection(COLLECTION_STATUS.Live),
            steps: [
                succeededStep(BOOTSTRAP_STEP_KEY.Anchor),
                succeededStep(BOOTSTRAP_STEP_KEY.Enumeration),
                succeededStep(BOOTSTRAP_STEP_KEY.Metadata),
                failedTerminalStep(BOOTSTRAP_STEP_KEY.Ownership, true),
                succeededStep(BOOTSTRAP_STEP_KEY.Backfill),
                succeededStep(BOOTSTRAP_STEP_KEY.CollectionLive),
            ],
        });

        const result = harness.reconciler.reconcile(TEST_RUN_ID);

        expect(result.completed).toBe(false);
        expect(harness.run?.status).toBe(BOOTSTRAP_RUN_STATUS.Metadata);
        expect(harness.updateStatuses).toEqual([]);
    });

    it("does not complete before the collection is live", () => {
        const harness = buildHarness({
            run: buildRun({ status: BOOTSTRAP_RUN_STATUS.Metadata }),
            collection: buildCollection(COLLECTION_STATUS.Bootstrapping),
            steps: [
                succeededStep(BOOTSTRAP_STEP_KEY.Anchor),
                succeededStep(BOOTSTRAP_STEP_KEY.Enumeration),
                succeededStep(BOOTSTRAP_STEP_KEY.Metadata),
                succeededStep(BOOTSTRAP_STEP_KEY.Ownership),
                succeededStep(BOOTSTRAP_STEP_KEY.Backfill),
                succeededStep(BOOTSTRAP_STEP_KEY.CollectionLive),
            ],
        });

        const result = harness.reconciler.reconcile(TEST_RUN_ID);

        expect(result.completed).toBe(false);
        expect(harness.run?.status).toBe(BOOTSTRAP_RUN_STATUS.Metadata);
        expect(harness.updateStatuses).toEqual([]);
    });
});

function buildHarness(input: {
    run: BootstrapRunDefinition | null;
    collection: CollectionRecord | null;
    steps: BootstrapStepRecord[];
}): {
    reconciler: BootstrapLiveRunCompletionReconciler;
    run: BootstrapRunDefinition | null;
    updateStatuses: BootstrapRunStatus[];
} {
    let run = input.run;
    const updateStatuses: BootstrapRunStatus[] = [];
    return {
        get run() {
            return run;
        },
        updateStatuses,
        reconciler: new BootstrapLiveRunCompletionReconciler(
            {
                getCollection: () => input.collection,
            },
            {
                getRun: () => run,
                updateRunStatus: (_runId, status) => {
                    updateStatuses.push(status);
                    if (run) {
                        run = { ...run, status };
                    }
                },
            },
            {
                listRunSteps: () => input.steps,
            },
            {
                deleteSnapshotRows: () => 0,
                deleteSucceededMetadataTasks: () => 0,
                deleteSucceededImageCacheTasks: () => 0,
                deleteSucceededOwnershipTasks: () => 0,
                deleteSucceededCollectionExtensionArtifactTasks: () => 0,
                getMetadataTaskCounts: () => EMPTY_COUNTS,
                getImageCacheTaskCounts: () => EMPTY_COUNTS,
                getOwnershipTaskCounts: () => EMPTY_COUNTS,
                getCollectionExtensionArtifactTaskCounts: () => EMPTY_COUNTS,
            },
        ),
    };
}

function buildRun(input: {
    status: BootstrapRunStatus;
}): BootstrapRunDefinition {
    return {
        runId: TEST_RUN_ID,
        chainId: TEST_CHAIN_ID,
        collectionId: TEST_COLLECTION_ID,
        requestSlug: TEST_SLUG,
        requestAddress: TEST_CONTRACT_ADDRESS,
        requestStandard: COLLECTION_STANDARD.Erc721,
        imageSourceField: null,
        requestExtensionKey: null,
        metadataMode: BOOTSTRAP_METADATA_MODE.BestEffort,
        enumerationMode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
        manualTokenIdsJson: null,
        manualRangeStartTokenId: null,
        manualRangeTotalSupply: null,
        imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
        imageCacheMaxDimension: BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION,
        deploymentBlock: null,
        status: input.status,
        anchorBlock: TEST_ANCHOR_BLOCK,
        anchorBlockHash: TEST_ANCHOR_HASH,
        anchorBlockTimestamp: TEST_ANCHOR_TIMESTAMP,
    };
}

function buildCollection(status: CollectionStatus): CollectionRecord {
    const scope = CollectionTokenScope.allContractTokens().toPersistence();
    return CollectionRecord.fromPersistence({
        chainId: TEST_CHAIN_ID,
        id: TEST_COLLECTION_ID,
        slug: TEST_SLUG,
        address: TEST_CONTRACT_ADDRESS,
        standard: COLLECTION_STANDARD.Erc721,
        status,
        tokenScopeKind: scope.tokenScopeKind,
        scopeStartTokenId: scope.scopeStartTokenId,
        scopeTotalSupply: scope.scopeTotalSupply,
        deploymentBlock: null,
        bootstrapAnchorBlock: TEST_ANCHOR_BLOCK,
        bootstrapStartedAt: null,
        bootstrapFinishedAt: null,
        bootstrapLastSyncedBlock: TEST_ANCHOR_BLOCK,
        openseaSlug: null,
        openseaStatus: null,
        openseaReadyAt: null,
        openseaSnapshotStartedAt: null,
        openseaSnapshotCompletedAt: null,
        openseaReconcileStartedAt: null,
        openseaReconcileCompletedAt: null,
        openseaLastStreamEventAt: null,
        openseaLastStreamHealthyAt: null,
        openseaLastError: null,
    });
}

function succeededStep(stepKey: BootstrapStepKey): BootstrapStepRecord {
    return step(stepKey, BOOTSTRAP_STEP_STATUS.Succeeded, true);
}

function failedTerminalStep(
    stepKey: BootstrapStepKey,
    blocking: boolean,
): BootstrapStepRecord {
    return step(stepKey, BOOTSTRAP_STEP_STATUS.FailedTerminal, blocking);
}

function readyStep(
    stepKey: BootstrapStepKey,
    blocking: boolean,
): BootstrapStepRecord {
    return step(stepKey, BOOTSTRAP_STEP_STATUS.Ready, blocking);
}

function step(
    stepKey: BootstrapStepKey,
    status: BootstrapStepStatus,
    blocking: boolean,
): BootstrapStepRecord {
    return {
        runId: TEST_RUN_ID,
        stepKey,
        status,
        blocking,
        dependsOn: [],
        nextAttemptAt: 0,
        leaseOwner: null,
        leaseUntil: null,
        progressCompleted: 0,
        progressTotal: null,
        resultJson: null,
        attempts: 0,
        lastError: null,
    };
}
