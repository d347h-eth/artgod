import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData } from "viem";
import { createSimulationWorld } from "../world/world.mjs";
import { CONTRACT_ABI } from "../world/wire.mjs";
import { METADATA_TRANSPORT } from "../world/contract.mjs";
import {
    executeCollectionBootstrap,
    BOOTSTRAP_METADATA_BARRIER,
    BOOTSTRAP_PROPERTY,
} from "./bootstrap-journey.mjs";
import { PRODUCTION_BOOTSTRAP_PROCESSES } from "./runtime-manifest.mjs";
import { BOOTSTRAP_RUN_EVENT_CODE } from "../../../shared/bootstrap/run-events.ts";
import {
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    BOOTSTRAP_RUN_STATUS,
} from "../../../shared/bootstrap/pipeline.ts";
import { API_CSRF_HEADER_NAME } from "../../../shared/http/api-security.ts";
import {
    buildBootstrapRunDetailPath,
    buildBootstrapStepActionPath,
    buildRetryBootstrapFailedTasksPath,
} from "../../../shared/http/bootstrap-routes.ts";

// Controller guard tests: state transitions below are doubles, not evidence of
// actual production bootstrap behavior. The authored VM case supplies that proof.
function controller({
    missingBarrier = false,
    ignorePause = false,
    wrongArtifact = false,
    wrongOwner = false,
    coverageHole = false,
    retryNoop = false,
    metadataNoop = false,
    completedNoop = false,
} = {}) {
    const world = createSimulationWorld({
        epochSeconds: 1_800_000_000,
        metadataTransport: METADATA_TRANSPORT.Http,
        providers: { default: { branch: "B", head: 105 } },
        scripts: missingBarrier
            ? []
            : [
                  {
                      when: {
                          method: "eth_call",
                          functionName: "tokenURI",
                          occurrence: 1,
                      },
                      before: { barrier: BOOTSTRAP_METADATA_BARRIER },
                  },
              ],
    });
    world.publishMetadataAt("http://127.0.0.1:47123");
    const calls = [];
    const controls = [];
    const evidence = [];
    const spec = PRODUCTION_BOOTSTRAP_PROCESSES[0];
    const entry = {
        ...spec,
        filename: `/workbench/runtime/${spec.artifact}`,
        child: { pid: 9001, exitCode: null, signalCode: null },
        assertAlive() {
            assert.equal(this.child.exitCode, null);
        },
    };
    const processes = [entry];
    let state = "new";
    let paused = false;
    let pendingRequest;
    const events = [];
    const detail = () => ({
        run: {
            runId: 7,
            status:
                state === "live" || (state === "retried" && !completedNoop)
                    ? BOOTSTRAP_RUN_STATUS.Completed
                    : BOOTSTRAP_RUN_STATUS.Metadata,
            anchorBlock: 102,
            anchorBlockHash: world.ledger.blockAt("B", 102).hash,
        },
        collection: {
            status: ["live", "retried"].includes(state)
                ? "live"
                : "bootstrapping",
        },
        metadataTasks: {
            pending: 0,
            retry: 0,
            succeeded: state === "retried" ? 2 : 0,
            failedTerminal: state === "live" ? 2 : 0,
        },
        flow: { steps: [{ key: BOOTSTRAP_STEP_KEY.Metadata, paused }] },
    });
    const context = {
        origin: "http://127.0.0.1:42722",
        chainRef: "ethereum",
        world,
        processes,
        async onCreated(value) {
            evidence.push(value);
        },
        async eventually(check, label) {
            for (let i = 0; i < 5; i++) {
                if (await check()) return;
                await new Promise((resolve) => setImmediate(resolve));
            }
            throw new Error(`controller timeout: ${label}`);
        },
        async stopProcess(child, signal) {
            controls.push({ pid: child.pid, signal });
            child.signalCode = signal;
            await pendingRequest;
        },
        async restartProcess() {
            const replacement = {
                ...entry,
                artifact: wrongArtifact ? "wrong.mjs" : entry.artifact,
                child: { pid: 9002, exitCode: null, signalCode: null },
                intentionallyStopped: false,
            };
            processes.splice(0, 1, replacement);
            return replacement;
        },
        async observeBootstrap() {
            return {
                run: detail().run,
                owners: ["1", "2"].map((id) => ({
                    token_id: id,
                    owner: wrongOwner
                        ? world.ledger.addresses.buyer
                        : world.ledger.addresses.seller,
                    amount: 1,
                    last_block_number: 102,
                })),
                coverage: (coverageHole ? [103, 105] : [103, 104, 105]).map(
                    (block_number) => ({ block_number }),
                ),
                metadata:
                    state === "retried" && !metadataNoop
                        ? ["1", "2"].map((id) => ({
                              token_id: id,
                              name: JSON.parse(world.tokenMetadataDocument(id))
                                  .name,
                          }))
                        : [],
                steps: [
                    BOOTSTRAP_STEP_KEY.Metadata,
                    BOOTSTRAP_STEP_KEY.Ownership,
                    BOOTSTRAP_STEP_KEY.Backfill,
                    BOOTSTRAP_STEP_KEY.CollectionLive,
                ].map((step_key) => ({
                    step_key,
                    status: BOOTSTRAP_STEP_STATUS.Succeeded,
                })),
                events,
            };
        },
        async fetchFn(url, options) {
            calls.push({ url, ...options });
            const route = new URL(url).pathname;
            if (route === "/api/security/csrf")
                return Response.json({ token: "public-test-csrf" });
            if (!options?.method) return Response.json(detail());
            assert.equal(
                options.headers[API_CSRF_HEADER_NAME],
                "public-test-csrf",
            );
            if (route.endsWith("/collections/bootstrap")) {
                state = "held";
                pendingRequest = world.handleRpc("default", {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "eth_call",
                    params: [
                        {
                            to: world.ledger.addresses.nft,
                            data: encodeFunctionData({
                                abi: CONTRACT_ABI,
                                functionName: "tokenURI",
                                args: [1n],
                            }),
                        },
                        "0x66",
                    ],
                });
                return Response.json({ runId: 7, collectionId: 9 });
            }
            if (route.endsWith("/pause")) {
                paused = !ignorePause;
                events.push({
                    event_code: BOOTSTRAP_RUN_EVENT_CODE.StepPaused,
                });
                return Response.json({ status: BOOTSTRAP_STEP_STATUS.Paused });
            }
            if (route.endsWith("/resume")) {
                paused = false;
                state = "live";
                events.push({
                    event_code: BOOTSTRAP_RUN_EVENT_CODE.StepResumed,
                });
                return Response.json({ status: BOOTSTRAP_STEP_STATUS.Ready });
            }
            if (route.endsWith("/retry-failed")) {
                state = "retried";
                events.push({
                    event_code:
                        BOOTSTRAP_RUN_EVENT_CODE.MetadataRetryFailedTerminal,
                });
                return Response.json({
                    runId: 7,
                    updatedCount: retryNoop ? 0 : 2,
                    status: BOOTSTRAP_RUN_STATUS.Metadata,
                });
            }
            throw new Error(`Unexpected controller request ${route}`);
        },
    };
    return { context, calls, controls, evidence, world };
}

test("bootstrap driver uses actual HTTP controls and refuses to replace guarded evidence with setup rows", async () => {
    const fixture = controller();
    const result = await executeCollectionBootstrap(fixture.context);
    assert.deepEqual(result.checks, { metadataCorrect: true, completed: true });
    assert.ok(Object.values(result.reached).every(Boolean));
    assert.deepEqual(fixture.evidence, [{ runId: 7, collectionId: 9 }]);
    assert.deepEqual(fixture.controls, [{ pid: 9001, signal: "SIGKILL" }]);
    const writes = fixture.calls.filter((call) => call.method);
    assert.deepEqual(
        writes.map((call) => new URL(call.url).pathname),
        [
            "/api/ethereum/collections/bootstrap",
            "/api/ethereum/bootstrap-runs/7/steps/metadata/pause",
            "/api/ethereum/bootstrap-runs/7/steps/metadata/resume",
            "/api/ethereum/bootstrap-runs/7/retry-failed",
        ],
    );
    const definition = JSON.parse(writes[0].body);
    assert.deepEqual(definition.scope, {
        mode: "manual_token_ids",
        tokenIds: ["1", "2"],
    });
    assert.equal(definition.imageCache.imageCacheMode, "off");
    assert.equal(definition.metadataMode, "best_effort");
    assert.equal(
        JSON.parse(fixture.world.tokenMetadataDocument("1")).name,
        "Simulation token 1",
    );
});

test("unreached real metadata barrier is a failure, not an exercised pause", async () => {
    const fixture = controller({ missingBarrier: true });
    await assert.rejects(
        executeCollectionBootstrap(fixture.context),
        (error) => {
            assert.equal(error.failureProperty, BOOTSTRAP_PROPERTY.Paused);
            assert.equal(
                error.simulation.bootstrapJourney.reached.paused,
                undefined,
            );
            return true;
        },
    );
    assert.equal(fixture.controls.length, 0);
});

test("restart must retain the real paused step and exact production artifact", async () => {
    for (const options of [{ ignorePause: true }, { wrongArtifact: true }]) {
        const fixture = controller(options);
        await assert.rejects(
            executeCollectionBootstrap(fixture.context),
            (error) => {
                assert.equal(
                    error.failureProperty,
                    BOOTSTRAP_PROPERTY.ReopenedPaused,
                );
                assert.equal(
                    error.simulation.bootstrapJourney.reached.reopenedPaused,
                    undefined,
                );
                return true;
            },
        );
    }
});

test("live collection labels cannot substitute for anchored owners and complete catchup", async () => {
    for (const options of [{ wrongOwner: true }, { coverageHole: true }]) {
        const fixture = controller(options);
        await assert.rejects(
            executeCollectionBootstrap(fixture.context),
            (error) => {
                assert.equal(
                    error.failureProperty,
                    BOOTSTRAP_PROPERTY.BestEffortLive,
                );
                assert.equal(
                    error.simulation.bootstrapJourney.reached.bestEffortLive,
                    undefined,
                );
                return true;
            },
        );
    }
});

test("recovery needs real terminal tasks and actual repaired canonical metadata", async () => {
    for (const [options, expected] of [
        [{ retryNoop: true }, BOOTSTRAP_PROPERTY.RetryAdmitted],
        [{ metadataNoop: true }, BOOTSTRAP_PROPERTY.MetadataRecovered],
    ]) {
        await assert.rejects(
            executeCollectionBootstrap(controller(options).context),
            (error) => {
                assert.equal(error.failureProperty, expected);
                assert.equal(
                    error.simulation.bootstrapJourney.checks.metadataCorrect,
                    undefined,
                );
                return true;
            },
        );
    }
});

test("metadata success cannot hide a reopened run stuck outside Completed", async () => {
    await assert.rejects(
        executeCollectionBootstrap(controller({ completedNoop: true }).context),
        (error) => {
            assert.equal(error.failureProperty, BOOTSTRAP_PROPERTY.Completed);
            const evidence = error.simulation.bootstrapJourney;
            assert.equal(evidence.reached.retryAdmitted, true);
            assert.equal(evidence.reached.metadataRecovered, true);
            assert.equal(evidence.checks.metadataCorrect, true);
            assert.equal(evidence.checks.completed, undefined);
            assert.equal(
                evidence.lastObservedStatus.runStatus,
                BOOTSTRAP_RUN_STATUS.Metadata,
            );
            return true;
        },
    );
});

test("bootstrap control path builders encode external identity once", () => {
    assert.equal(
        buildBootstrapRunDetailPath("chain /x", 7),
        "/api/chain%20%2Fx/bootstrap-runs/7",
    );
    assert.equal(
        buildRetryBootstrapFailedTasksPath("ethereum", 7),
        "/api/ethereum/bootstrap-runs/7/retry-failed",
    );
    assert.equal(
        buildBootstrapStepActionPath("ethereum", 7, "metadata /", "pause /"),
        "/api/ethereum/bootstrap-runs/7/steps/metadata%20%2F/pause%20%2F",
    );
});
