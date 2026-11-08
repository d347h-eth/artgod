import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCampaignPlan } from "./campaign.mjs";
import {
    executeScenario,
    runCampaign,
    runRegressions,
    ORDER_PROFILE,
    minimizeCampaignCase,
} from "./workbench.mjs";
import { EXTERNAL_ACTION } from "./guest/scenario-contract.mjs";
import { createArtifactRunDirectory } from "./artifacts.mjs";
import { EXECUTION_INTERRUPTED_CODE } from "./qemu-replay.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const corpus = ["baseline", "fork", "provider-disagreement"].map((name) => ({
    name,
    scenarioFile: path.join(ROOT, `scripts/simulation/scenarios/${name}.json`),
}));
const interruptedFailure = () =>
    Object.assign(new Error("Operator interrupted the active command"), {
        code: EXECUTION_INTERRUPTED_CODE,
    });
const testOutput = () =>
    createArtifactRunDirectory(
        path.join(ROOT, "tmp/workbench-tests"),
        "suite-",
    );
const readJson = async (filename) =>
    JSON.parse(await readFile(filename, "utf8"));
function passedCase(scenario) {
    return {
        caseId: scenario.qualificationId,
        engineReplayStatus: "passed",
        propertyStatus: "passed",
        guestReportedChecks: Object.fromEntries(
            scenario.expectedChecks.map((check) => [check, true]),
        ),
        evidence: {
            reachedBarriers: ["old-validation"],
            checkpoints: [{ name: "settled" }],
            externalActions: scenario.schedule.map((action) => ({
                action,
                ...(action === EXTERNAL_ACTION.CanonicalSwitch
                    ? { committedRevision: 1 }
                    : {}),
                ...(action === EXTERNAL_ACTION.StreamListing
                    ? { deliveredRecipients: 1 }
                    : {}),
            })),
        },
    };
}

test("bounded execution reports omitted cases as missing rather than a campaign pass", async () => {
    const plan = createCampaignPlan({ dependencies: ORDER_PROFILE.causal });
    const report = await runCampaign({
        baseManifestPath: "unused-stub.json",
        plan,
        limit: 1,
        runCase: async ({ scenarioFile }) =>
            passedCase(JSON.parse(await readFile(scenarioFile, "utf8"))),
    });
    assert.equal(report.specified, 6);
    assert.equal(report.executed, 1);
    assert.equal(report.counts.passed, 1);
    assert.equal(report.counts.missing, 5);
    assert.equal(report.propertyStatus, "incomplete");
    const saved = JSON.parse(
        await readFile(path.join(report.directory, "report.json"), "utf8"),
    );
    assert.equal(saved.counts.missing, 5);
});

test("a counterexample and emulator failure are retained while later cases execute", async () => {
    const plan = createCampaignPlan({ dependencies: ORDER_PROFILE.causal });
    let count = 0;
    const report = await runCampaign({
        baseManifestPath: "unused-stub.json",
        plan,
        runCase: async ({ scenarioFile }) => {
            const result = passedCase(
                JSON.parse(await readFile(scenarioFile, "utf8")),
            );
            if (count++ === 0) return { ...result, propertyStatus: "failed" };
            if (count === 2)
                throw new Error("Emulator stopped before protocol completion");
            return result;
        },
    });
    assert.equal(count, 6);
    assert.equal(report.counts.failed, 1);
    assert.equal(report.counts.unqualified, 1);
    assert.equal(report.counts.passed, 4);
    assert.equal(report.propertyStatus, "failed");
    assert.equal(report.engineReplayStatus, "incomplete");
});

test("failed property keeps qualified replay, explicit coverage and original artifact location", async () => {
    const report = await executeScenario({
        baseManifestPath: "unused-stub.json",
        scenarioFile: path.join(
            ROOT,
            "scripts/simulation/scenarios/baseline.json",
        ),
        prepare: async () => ({ manifestPath: "prepared.json" }),
        execute: async () => ({
            directory: "original-artifacts",
            engineReplayStatus: "passed",
            propertyStatus: "failed",
        }),
        readEvidence: async () => ({
            evidence: { error: "coherence failure" },
            coverage: [{ check: "http-projection", status: "failed" }],
        }),
    });
    assert.equal(report.engineReplayStatus, "passed");
    assert.equal(report.propertyStatus, "failed");
    assert.equal(report.directory, "original-artifacts");
    assert.equal(report.coverage[0].status, "failed");
});

test("minimize CLI rejects a failed prelude and accepts only an oracle failure after its authored history", async () => {
    const plan = createCampaignPlan({ faultModels: ["header-drop-once"] });
    const campaign = await runCampaign({
        baseManifestPath: "unused-stub.json",
        plan,
        limit: 1,
        runCase: async ({ scenarioFile }) =>
            passedCase(JSON.parse(await readFile(scenarioFile, "utf8"))),
    });
    const failedCase = async (scenarioFile, reached) => {
        const scenario = JSON.parse(await readFile(scenarioFile, "utf8"));
        const execution = passedCase(scenario);
        execution.propertyStatus = "failed";
        execution.guestReportedChecks["reorg-recovery"] = false;
        execution.coverage = [{ check: "reorg-recovery", status: "failed" }];
        execution.evidence.failedCheck = "reorg-recovery";
        execution.evidence.failedProperty = "order-canonicality";
        execution.evidence.checkpoints = [];
        execution.evidence.world = {
            phase: "fork-held",
            scripts: scenario.world.scripts
                .filter((script) => script.fault)
                .map((script) => ({
                    id: script.id,
                    used: true,
                    applied: true,
                })),
        };
        if (!reached) {
            execution.evidence.reachedBarriers = [];
            execution.evidence.externalActions = [];
        }
        return execution;
    };
    let earlyAttempts = 0;
    await assert.rejects(
        minimizeCampaignCase({
            baseManifestPath: "unused-stub.json",
            campaignDirectory: campaign.directory,
            caseId: plan.cases[0].id,
            runCase: async ({ scenarioFile }) => {
                earlyAttempts++;
                return failedCase(scenarioFile, false);
            },
        }),
        /reached failed property/,
    );
    assert.equal(
        earlyAttempts,
        1,
        "No smaller case may be accepted from a failed activation",
    );
    const result = await minimizeCampaignCase({
        baseManifestPath: "unused-stub.json",
        campaignDirectory: campaign.directory,
        caseId: plan.cases[0].id,
        runCase: async ({ scenarioFile }) => failedCase(scenarioFile, true),
    });
    assert.equal(result.failureProperty, "order-canonicality");
    assert.equal(result.case.requiredFaults.length, 0);
    assert.equal(result.evaluations, 2);
});

test("named regressions continue after launch failure and report unverified cases", async () => {
    let count = 0;
    const report = await runRegressions({
        baseManifestPath: "unused-stub.json",
        corpus,
        runCase: async () => {
            if (count++ === 0) throw new Error("Missing pinned QEMU");
            return { engineReplayStatus: "passed", propertyStatus: "passed" };
        },
    });
    assert.equal(count, 3);
    assert.equal(report.engineReplayStatus, "failed");
    assert.equal(report.propertyStatus, "incomplete");
    assert.match(report.cases[0].error, /Missing pinned/);
});

test("invalid campaign limits cannot start a machine", async () => {
    await assert.rejects(
        runCampaign({ baseManifestPath: "unused.json", limit: 0 }),
        /limit/,
    );
    await assert.rejects(
        runCampaign({ baseManifestPath: "unused.json", limit: 999 }),
        /limit/,
    );
});

test("unreadable evidence cannot become a passing regression summary", async () => {
    const report = await runRegressions({
        baseManifestPath: "unused.json",
        corpus,
        runCase: async () => ({
            engineReplayStatus: "passed",
            propertyStatus: "passed",
            evidenceError: "Evidence frame missing",
        }),
    });
    assert.equal(report.engineReplayStatus, "passed");
    assert.equal(report.propertyStatus, "incomplete");
});

test("interrupted preparation preserves its marker and preparation artifacts without inventing a VM run", async () => {
    let executions = 0;
    let evidenceReads = 0;
    const failure = new AggregateError(
        [
            new Error("Docker preparation failed", {
                cause: interruptedFailure(),
            }),
        ],
        "Preparation cleanup completed",
    );
    failure.preparationDirectory = "retained-preparation";
    const report = await executeScenario({
        baseManifestPath: "unused.json",
        scenarioFile: corpus[0].scenarioFile,
        prepare: async () => {
            throw failure;
        },
        execute: async () => {
            executions++;
        },
        readEvidence: async () => {
            evidenceReads++;
        },
    });
    assert.equal(executions, 0);
    assert.equal(evidenceReads, 0);
    assert.equal(report.errorCode, EXECUTION_INTERRUPTED_CODE);
    assert.equal(report.preparationDirectory, "retained-preparation");
    assert.equal(report.directory, undefined);
    assert.equal(report.propertyStatus, "unqualified");
});

test("an interrupted machine keeps its original directory and readable evidence", async () => {
    const failure = interruptedFailure();
    failure.report = {
        directory: "interrupted-machine",
        engineReplayStatus: "failed",
        propertyStatus: "unqualified",
        errorCode: EXECUTION_INTERRUPTED_CODE,
    };
    const report = await executeScenario({
        baseManifestPath: "unused.json",
        scenarioFile: corpus[0].scenarioFile,
        prepare: async () => ({
            manifestPath: "prepared.json",
            directory: "preparation",
        }),
        execute: async () => {
            throw failure;
        },
        readEvidence: async (directory) => {
            assert.equal(directory, "interrupted-machine");
            return {
                evidence: { checkpoints: [{ name: "before-interruption" }] },
            };
        },
    });
    assert.equal(report.errorCode, EXECUTION_INTERRUPTED_CODE);
    assert.equal(report.directory, "interrupted-machine");
    assert.equal(report.preparationDirectory, "preparation");
    assert.equal(report.evidence.checkpoints[0].name, "before-interruption");
});

test("a campaign retains an interrupted case and leaves all later cases missing", async () => {
    const plan = createCampaignPlan({ dependencies: ORDER_PROFILE.causal });
    let count = 0;
    const report = await runCampaign({
        baseManifestPath: "unused.json",
        outputRoot: await testOutput(),
        plan,
        runCase: async ({ scenarioFile }) => {
            count++;
            const scenario = await readJson(scenarioFile);
            if (count === 1) return passedCase(scenario);
            return {
                caseId: scenario.qualificationId,
                directory: "interrupted-machine",
                errorCode: EXECUTION_INTERRUPTED_CODE,
                engineReplayStatus: "failed",
                propertyStatus: "unqualified",
            };
        },
    });
    assert.equal(count, 2);
    assert.equal(report.errorCode, EXECUTION_INTERRUPTED_CODE);
    assert.equal(report.executed, 2);
    assert.equal(report.counts.missing, 4);
    const executions = await readJson(
        path.join(report.directory, "executions.json"),
    );
    assert.equal(executions[1].directory, "interrupted-machine");
    assert.equal(executions[1].errorCode, EXECUTION_INTERRUPTED_CODE);
    assert.equal(
        (await readJson(path.join(report.directory, "report.json"))).counts
            .missing,
        4,
    );
});

test("regressions save the full plan before execution and an incremental missing ledger after interruption", async () => {
    const outputRoot = await testOutput();
    let count = 0;
    let directory;
    const report = await runRegressions({
        baseManifestPath: "unused.json",
        outputRoot,
        corpus,
        runCase: async () => {
            const entries = await readdir(outputRoot);
            assert.equal(entries.length, 1);
            directory = path.join(outputRoot, entries[0]);
            const saved = await readJson(path.join(directory, "report.json"));
            assert.equal(saved.specified, 3);
            assert.equal(saved.executed, count);
            assert.equal(saved.missing, 3 - count);
            assert.equal(
                (await readJson(path.join(directory, "plan.json"))).cases
                    .length,
                3,
            );
            assert.equal(
                (await readJson(path.join(directory, "cases.json"))).filter(
                    (entry) => entry.status === "missing",
                ).length,
                3 - count,
            );
            if (count++ === 0)
                return {
                    engineReplayStatus: "passed",
                    propertyStatus: "passed",
                };
            const failure = new Error("Wrapped interruption", {
                cause: interruptedFailure(),
            });
            failure.preparationDirectory = "interrupted-preparation";
            throw failure;
        },
    });
    assert.equal(count, 2);
    assert.equal(report.directory, directory);
    assert.equal(report.errorCode, EXECUTION_INTERRUPTED_CODE);
    assert.equal(report.executed, 2);
    assert.equal(report.missing, 1);
    assert.equal(
        report.cases[1].preparationDirectory,
        "interrupted-preparation",
    );
    assert.equal(report.cases[2].status, "missing");
    assert.equal(
        report.cases[2].caseId,
        (await readJson(corpus[2].scenarioFile)).qualificationId,
    );
    assert.equal(report.propertyStatus, "incomplete");
});

test("an ordinary timeout remains a failure and does not stop later regression cases", async () => {
    let count = 0;
    const report = await runRegressions({
        baseManifestPath: "unused.json",
        outputRoot: await testOutput(),
        corpus,
        runCase: async () => {
            if (count++ === 0)
                throw new Error("Execution exceeded its timeout");
            return { engineReplayStatus: "passed", propertyStatus: "passed" };
        },
    });
    assert.equal(count, 3);
    assert.equal(report.missing, 0);
    assert.equal(report.errorCode, undefined);
    assert.equal(report.cases[0].errorCode, undefined);
    assert.equal(report.cases[0].status, "unqualified");
    assert.equal(report.engineReplayStatus, "failed");
    assert.equal(report.propertyStatus, "incomplete");
});

test("interrupted minimization retains attempts without claiming a minimal counterexample", async () => {
    const plan = createCampaignPlan({ faultModels: ["header-drop-once"] });
    const campaign = await runCampaign({
        baseManifestPath: "unused.json",
        plan,
        limit: 1,
        outputRoot: await testOutput(),
        runCase: async ({ scenarioFile }) =>
            passedCase(await readJson(scenarioFile)),
    });
    let count = 0;
    let interruption;
    await assert.rejects(
        minimizeCampaignCase({
            baseManifestPath: "unused.json",
            campaignDirectory: campaign.directory,
            caseId: plan.cases[0].id,
            runCase: async ({ scenarioFile }) => {
                count++;
                if (count === 2) {
                    const failure = interruptedFailure();
                    failure.directory = "interrupted-shrink-machine";
                    throw failure;
                }
                const scenario = await readJson(scenarioFile);
                const execution = passedCase(scenario);
                execution.propertyStatus = "failed";
                execution.guestReportedChecks["reorg-recovery"] = false;
                execution.coverage = [
                    { check: "reorg-recovery", status: "failed" },
                ];
                Object.assign(execution.evidence, {
                    failedCheck: "reorg-recovery",
                    failedProperty: "order-canonicality",
                    checkpoints: [],
                    world: {
                        scripts: scenario.world.scripts
                            .filter((script) => script.fault)
                            .map((script) => ({
                                id: script.id,
                                used: true,
                                applied: true,
                            })),
                    },
                });
                return execution;
            },
        }),
        (error) => {
            assert.equal(error.code, EXECUTION_INTERRUPTED_CODE);
            interruption = error;
            return true;
        },
    );
    assert.equal(count, 2);
    const report = await readJson(
        path.join(interruption.directory, "report.json"),
    );
    assert.equal(report.status, "interrupted");
    assert.equal(report.executed, 2);
    assert.equal(report.minimality, undefined);
    const executions = await readJson(
        path.join(interruption.directory, "executions.json"),
    );
    assert.equal(executions[1].directory, "interrupted-shrink-machine");
    assert.equal(executions[1].errorCode, EXECUTION_INTERRUPTED_CODE);
    assert.equal(
        (await readdir(interruption.directory)).includes(
            "minimal-scenario.json",
        ),
        false,
    );
});
