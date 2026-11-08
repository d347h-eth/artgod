import assert from "node:assert/strict";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_ACTION,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
} from "../../../shared/bootstrap/pipeline.ts";
import { BOOTSTRAP_RUN_EVENT_CODE } from "../../../shared/bootstrap/run-events.ts";
import {
    buildCreateBootstrapRunPath,
    buildBootstrapRunDetailPath,
    buildBootstrapStepActionPath,
    buildRetryBootstrapFailedTasksPath,
} from "../../../shared/http/bootstrap-routes.ts";
import {
    COLLECTION_STANDARD,
    COLLECTION_STATUS,
} from "../../../shared/types/browse.ts";
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from "../../../shared/types/customization.ts";
import { IMAGE_CACHE_MODE } from "../../../shared/media/token-image-cache.ts";
import { createOperatorHttp } from "./operator-http.mjs";
import { assertRestartedRuntime } from "./process-faults.mjs";
import { RUNTIME_PROCESS } from "./runtime-manifest.mjs";

export const BOOTSTRAP_METADATA_BARRIER = "bootstrap-metadata-request";
export const BOOTSTRAP_PROPERTY = Object.freeze({
    Admission: "bootstrap-http-admission",
    Paused: "bootstrap-pause-after-real-request",
    ReopenedPaused: "bootstrap-restart-preserves-pause",
    BestEffortLive: "bootstrap-failed-metadata-preserves-ownership",
    RetryAdmitted: "bootstrap-completed-run-retry-admitted",
    MetadataRecovered: "bootstrap-retried-metadata-converges",
    Completed: "bootstrap-reopened-run-completes",
});

const TOKENS = Object.freeze(["1", "2"]);
const success = (steps, key) =>
    steps.some(
        (step) =>
            step.step_key === key &&
            step.status === BOOTSTRAP_STEP_STATUS.Succeeded,
    );

function assertSnapshot(snapshot, world, anchor) {
    assert.equal(
        snapshot.owners.length,
        TOKENS.length,
        "Bootstrap must snapshot both minted tokens",
    );
    for (const tokenId of TOKENS) {
        const owner = snapshot.owners.find((row) => row.token_id === tokenId);
        assert.equal(
            owner?.owner.toLowerCase(),
            world.ledger.addresses.seller.toLowerCase(),
        );
        assert.equal(String(owner?.amount), "1");
        assert.equal(
            owner?.last_block_number,
            anchor,
            "Ownership came from the actual anchored snapshot",
        );
    }
    assert.ok(success(snapshot.steps, BOOTSTRAP_STEP_KEY.Ownership));
    assert.ok(success(snapshot.steps, BOOTSTRAP_STEP_KEY.Backfill));
    assert.ok(success(snapshot.steps, BOOTSTRAP_STEP_KEY.CollectionLive));
    const coverage = new Set(snapshot.coverage.map((row) => row.block_number));
    for (
        let block = anchor + 1;
        block <= world.providerView("default").head;
        block++
    )
        assert.ok(
            coverage.has(block),
            `Bootstrap catchup must cover block ${block}`,
        );
}

/**
 * External operator controls and read-only observations around the production
 * bootstrap worker. No use case is invoked and no bootstrap/projection row is
 * inserted by this driver. Its callbacks launch the exact production artifact.
 */
export async function executeCollectionBootstrap(
    context,
    { timeoutMs = 180_000 } = {},
) {
    const {
        origin,
        chainRef,
        world,
        processes,
        restartProcess,
        stopProcess,
        eventually,
        observeBootstrap,
        onCreated = () => {},
        fetchFn = fetch,
    } = context;
    for (const [name, callback] of Object.entries({
        restartProcess,
        stopProcess,
        eventually,
        observeBootstrap,
        onCreated,
    }))
        assert.equal(
            typeof callback,
            "function",
            `Bootstrap driver requires ${name}`,
        );
    const worker = processes.find(
        (entry) => entry.id === RUNTIME_PROCESS.CollectionBootstrap,
    );
    assert.ok(
        worker && !worker.intentionallyStopped,
        "The actual collection-bootstrap entrypoint must be running",
    );
    worker.assertAlive();
    const http = createOperatorHttp({ origin, fetchFn });
    const evidence = { reached: {}, checks: {}, checkpoints: [] };
    const checkpoint = (name, detail) =>
        evidence.checkpoints.push({ name, ...detail });
    let property = BOOTSTRAP_PROPERTY.Admission;
    let runId;
    let collectionId;
    let released = false;
    try {
        const view = world.providerView("default");
        assert.equal(
            view.branch,
            "B",
            "Bootstrap starts on the coherent no-sale branch",
        );
        assert.equal(
            view.head,
            105,
            "Head105 gives the production depth3 anchor102",
        );
        const validMetadata = new Map(
            TOKENS.map((id) => [id, world.tokenMetadataDocument(id)]),
        );
        for (const id of TOKENS)
            assert.ok(
                world.tokenMetadataUri(id),
                "Bootstrap metadata must use a stable external HTTP URI",
            );
        for (const id of TOKENS) world.setTokenMetadataDocument(id, "{");
        const created = await http.post(buildCreateBootstrapRunPath(chainRef), {
            slug: world.ledger.collectionSlug,
            address: world.ledger.addresses.nft,
            openseaSlug: world.ledger.collectionSlug,
            standard: COLLECTION_STANDARD.Erc721,
            metadataMode: BOOTSTRAP_METADATA_MODE.BestEffort,
            scope: {
                mode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
                tokenIds: [...TOKENS],
            },
            imageSourceField: "image",
            imageCache: {
                selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
                imageCacheMode: IMAGE_CACHE_MODE.Off,
                maxDimension: null,
            },
            deploymentBlock: 101,
        });
        assert.ok(
            Number.isSafeInteger(created.runId) && created.runId > 0,
            "The backend must admit a real run",
        );
        assert.ok(
            Number.isSafeInteger(created.collectionId) &&
                created.collectionId > 0,
            "The backend must declare a real collection",
        );
        ({ runId, collectionId } = created);
        await onCreated({ runId, collectionId });
        evidence.reached.admitted = true;
        evidence.runId = runId;
        evidence.collectionId = collectionId;
        const detail = () =>
            http.get(buildBootstrapRunDetailPath(chainRef, runId));
        const observe = () => observeBootstrap({ runId, collectionId });
        const stepAction = (action) =>
            http.post(
                buildBootstrapStepActionPath(
                    chainRef,
                    runId,
                    BOOTSTRAP_STEP_KEY.Metadata,
                    action,
                ),
            );
        const waitDetail = async (predicate, label) => {
            let observed;
            await eventually(
                async () => {
                    observed = await detail();
                    evidence.lastObservedStatus = {
                        runStatus: observed.run.status,
                        collectionStatus: observed.collection.status,
                        metadataTasks: Object.fromEntries(
                            [
                                "pending",
                                "retry",
                                "succeeded",
                                "failedTerminal",
                                "total",
                            ].map((key) => [key, observed.metadataTasks[key]]),
                        ),
                        steps: observed.flow.steps
                            .slice(0, Object.keys(BOOTSTRAP_STEP_KEY).length)
                            .map(({ key, state, paused }) => ({
                                key,
                                state,
                                paused,
                            })),
                    };
                    return predicate(observed);
                },
                label,
                timeoutMs,
            );
            return observed;
        };

        property = BOOTSTRAP_PROPERTY.Paused;
        await eventually(
            () =>
                world.trace.some(
                    (entry) =>
                        entry.type === "barrier-reached" &&
                        entry.name === BOOTSTRAP_METADATA_BARRIER,
                ),
            "actual bootstrap metadata request held",
            timeoutMs,
        );
        const heldRequest = world.trace.find(
            (entry) =>
                entry.type === "barrier-reached" &&
                entry.name === BOOTSTRAP_METADATA_BARRIER,
        ).requestIndex;
        evidence.reached.metadataRequest = true;
        const paused = await stepAction(BOOTSTRAP_STEP_ACTION.Pause);
        assert.equal(paused.status, BOOTSTRAP_STEP_STATUS.Paused);
        const pausedDetail = await detail();
        assert.equal(
            pausedDetail.collection.status,
            COLLECTION_STATUS.Bootstrapping,
        );
        assert.equal(pausedDetail.run.anchorBlock, 102);
        assert.equal(
            pausedDetail.run.anchorBlockHash,
            world.ledger.blockAt("B", 102).hash,
        );
        world.release(BOOTSTRAP_METADATA_BARRIER);
        released = true;
        await eventually(
            () =>
                world.trace.some(
                    (entry) =>
                        entry.type === "response" &&
                        entry.functionName === "tokenURI" &&
                        entry.requestIndex === heldRequest,
                ),
            "held metadata response completed at wire boundary",
            timeoutMs,
        );
        evidence.reached.paused = true;
        checkpoint("bootstrap-paused", {
            runId,
            anchor: pausedDetail.run.anchorBlock,
        });

        property = BOOTSTRAP_PROPERTY.ReopenedPaused;
        const identity = {
            pid: worker.child.pid,
            artifact: worker.artifact,
            filename: worker.filename,
        };
        worker.intentionallyStopped = true;
        await stopProcess(worker.child, "SIGKILL");
        const replacement = await restartProcess(worker.id);
        assertRestartedRuntime(identity, replacement, processes);
        const reopened = await detail();
        const metadataStep = reopened.flow.steps.find(
            (step) => step.key === BOOTSTRAP_STEP_KEY.Metadata,
        );
        assert.equal(
            metadataStep?.paused,
            true,
            "Production startup must preserve the operator pause",
        );
        assert.equal(
            reopened.collection.status,
            COLLECTION_STATUS.Bootstrapping,
        );
        evidence.reached.reopenedPaused = true;
        checkpoint("bootstrap-reopened-paused", {
            runId,
            oldPid: identity.pid,
            newPid: replacement.child.pid,
        });
        assert.equal(
            (await stepAction(BOOTSTRAP_STEP_ACTION.Resume)).status,
            BOOTSTRAP_STEP_STATUS.Ready,
        );

        property = BOOTSTRAP_PROPERTY.BestEffortLive;
        const firstLive = await waitDetail(
            (value) =>
                value.run.status === BOOTSTRAP_RUN_STATUS.Completed &&
                value.collection.status === COLLECTION_STATUS.Live &&
                value.metadataTasks.failedTerminal === TOKENS.length,
            "best-effort metadata failures and real ownership reach live",
        );
        assert.equal(
            firstLive.metadataTasks.pending + firstLive.metadataTasks.retry,
            0,
        );
        assertSnapshot(await observe(), world, 102);
        evidence.reached.bestEffortLive = true;
        checkpoint("bootstrap-live-with-metadata-failures", {
            runId,
            failedMetadata: firstLive.metadataTasks.failedTerminal,
        });

        property = BOOTSTRAP_PROPERTY.RetryAdmitted;
        for (const [id, document] of validMetadata)
            world.setTokenMetadataDocument(id, document);
        const retried = await http.post(
            buildRetryBootstrapFailedTasksPath(chainRef, runId),
        );
        assert.equal(
            retried.runId,
            runId,
            "Recovery reopens the same persisted run",
        );
        assert.equal(
            retried.updatedCount,
            TOKENS.length,
            "Retry must reopen actual terminal tasks",
        );
        assert.equal(retried.status, BOOTSTRAP_RUN_STATUS.Metadata);
        evidence.reached.retryAdmitted = true;
        checkpoint("bootstrap-completed-run-reopened", {
            runId,
            updatedCount: retried.updatedCount,
        });

        property = BOOTSTRAP_PROPERTY.MetadataRecovered;
        let recovered;
        await eventually(
            async () => {
                recovered = await observe();
                return (
                    TOKENS.every((id) =>
                        recovered.metadata.some(
                            (row) =>
                                row.token_id === id &&
                                row.name ===
                                    JSON.parse(validMetadata.get(id)).name,
                        ),
                    ) && success(recovered.steps, BOOTSTRAP_STEP_KEY.Metadata)
                );
            },
            "retried metadata stored by actual production bootstrap",
            timeoutMs,
        );
        assertSnapshot(recovered, world, 102);
        assert.ok(
            recovered.events.some(
                (event) =>
                    event.event_code === BOOTSTRAP_RUN_EVENT_CODE.StepPaused,
            ),
        );
        assert.ok(
            recovered.events.some(
                (event) =>
                    event.event_code === BOOTSTRAP_RUN_EVENT_CODE.StepResumed,
            ),
        );
        assert.ok(
            recovered.events.some(
                (event) =>
                    event.event_code ===
                    BOOTSTRAP_RUN_EVENT_CODE.MetadataRetryFailedTerminal,
            ),
        );
        evidence.reached.metadataRecovered = true;
        evidence.checks.metadataCorrect = true;
        checkpoint("bootstrap-retried-metadata-correct", {
            runId,
            tokenIds: [...TOKENS],
        });

        property = BOOTSTRAP_PROPERTY.Completed;
        const completed = await waitDetail(
            (value) =>
                value.run.status === BOOTSTRAP_RUN_STATUS.Completed &&
                value.collection.status === COLLECTION_STATUS.Live &&
                value.metadataTasks.pending +
                    value.metadataTasks.retry +
                    value.metadataTasks.failedTerminal ===
                    0,
            "reopened bootstrap run returns to completed while collection stays live",
        );
        evidence.reached.reopenedCompleted = true;
        evidence.checks.completed = true;
        checkpoint("bootstrap-reopened-run-completed", {
            runId,
            status: completed.run.status,
        });
        return evidence;
    } catch (error) {
        error.failureProperty = error.failureProperty ?? property;
        error.simulation = {
            ...error.simulation,
            failureProperty: error.failureProperty,
            bootstrapJourney: evidence,
        };
        throw error;
    } finally {
        if (!released) world.release(BOOTSTRAP_METADATA_BARRIER);
    }
}
