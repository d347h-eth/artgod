import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    CI_LANE_KIND,
    CI_RUN_ENV,
    CI_BLOCKED_ENV,
    planCiLanes,
    runCiLane,
    readCiRunEnvironment,
    readCiBlockedEnvironment,
    recordBlockedCiLane,
    ciLanePassed,
} from "./ci.mjs";
import { discoverRegressionCorpus } from "./scenario-corpus.mjs";
import { createCampaignPlan, listCampaignModels } from "./campaign.mjs";
import { ORDER_PROFILE, runCampaign, runRegressions } from "./workbench.mjs";
import { EXTERNAL_ACTION } from "./guest/scenario-contract.mjs";
import { EXECUTION_INTERRUPTED_CODE } from "./qemu-replay.mjs";
import { createArtifactRunDirectory } from "./artifacts.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TEST_ROOT = path.join(ROOT, "tmp/simulation-ci-tests");
const readJson = async (filename) =>
    JSON.parse(await readFile(filename, "utf8"));
const outputRoot = () => createArtifactRunDirectory(TEST_ROOT, "run-");
function assertFixturePaths(report) {
    for (const name of ["ciDirectory", "directory"])
        if (report[name])
            assert.ok(report[name].startsWith(`${TEST_ROOT}${path.sep}`));
}

// Fake machine results test scheduling/accounting only, never ArtGod behavior.
function passedScenario(scenario) {
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
            externalActions: (scenario.schedule ?? []).map((action) => ({
                action,
                ...(action === EXTERNAL_ACTION.CanonicalSwitch
                    ? { committedRevision: 1 }
                    : {}),
                ...(action === EXTERNAL_ACTION.StreamListing
                    ? { deliveredRecipients: 1 }
                    : {}),
            })),
            world: {
                scripts: (scenario.world?.scripts ?? [])
                    .filter((script) => script.fault)
                    .map((script) => ({ id: script.id, applied: true })),
            },
        },
    };
}

test("two disjoint shards exhaust the discovered corpus and automatically admit new cases", async () => {
    const corpus = await discoverRegressionCorpus();
    for (const selected of [
        corpus,
        [
            ...corpus,
            {
                ...corpus[0],
                scenario: {
                    ...corpus[0].scenario,
                    qualificationId: "additional-ci-case",
                },
            },
        ],
    ]) {
        const matrix = await planCiLanes({
            discoverCorpus: async () => selected,
        });
        assert.equal(matrix.include.length, 2);
        assert.ok(matrix.include.every((lane) => lane.caseIds.length > 0));
        const ids = matrix.include.flatMap((lane) => lane.caseIds);
        assert.equal(new Set(ids).size, selected.length);
        assert.deepEqual(
            [...ids].sort(),
            selected.map((entry) => entry.scenario.qualificationId).sort(),
        );
        assert.ok(!JSON.stringify(matrix).includes(ROOT));
    }
    await assert.rejects(
        planCiLanes({ discoverCorpus: async () => [corpus[0], corpus[0]] }),
        /distinct exhaustive/,
    );
});

test("expanded matrix covers every authored fault model's six causal orders exactly once", async () => {
    const matrix = await planCiLanes({ includeCampaign: true });
    const lanes = matrix.include.filter(
        (lane) => lane.kind === CI_LANE_KIND.Campaign,
    );
    const models = listCampaignModels().faultModels;
    assert.deepEqual(
        lanes.map((lane) => lane.faultModelId),
        models.map(({ id }) => id),
    );
    for (const lane of lanes) {
        const expected = createCampaignPlan({
            dependencies: ORDER_PROFILE.causal,
            faultModels: [lane.faultModelId],
        });
        assert.equal(lane.caseIds.length, 6);
        assert.deepEqual(
            lane.caseIds,
            expected.cases.map((entry) => entry.id),
        );
    }
    const ids = matrix.include.flatMap((lane) => lane.caseIds);
    assert.equal(new Set(ids).size, ids.length);
});

test("Node 24 plan runs without dependency loaders and emits only portable JSON", async () => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const stdout = execFileSync(
        process.execPath,
        ["--no-addons", "scripts/simulation/ci.mjs", "plan", "--campaign"],
        { cwd: ROOT, env, encoding: "utf8" },
    );
    assert.deepEqual(
        JSON.parse(stdout),
        await planCiLanes({ includeCampaign: true }),
    );
});

test("omitted, edited and duplicate lane/matrix declarations fail before execution", async () => {
    const matrix = await planCiLanes({ includeCampaign: true });
    const lane = matrix.include[0];
    let invoked = false;
    const fail = async () => {
        invoked = true;
        throw new Error("Must not execute");
    };
    for (const change of [
        { lane: { ...lane, caseIds: lane.caseIds.slice(1) } },
        { lane: { ...lane, caseIds: [...lane.caseIds].reverse() } },
        { lane: { ...lane, limit: 1 } },
        { lane: { ...lane, id: "$(untrusted-shell-text)" } },
        { matrix: { include: matrix.include.slice(1) } },
        { matrix: { include: [...matrix.include, lane] } },
        { matrix: undefined },
    ])
        await assert.rejects(
            runCiLane({
                baseManifestPath: "unused.json",
                lane,
                matrix,
                regressions: fail,
                campaign: fail,
                ...change,
            }),
            /fresh exhaustive owner plan/,
        );
    const regressionMatrix = await planCiLanes();
    await assert.rejects(
        runCiLane({
            baseManifestPath: "unused.json",
            matrix: regressionMatrix,
            lane: matrix.include.find(
                (entry) => entry.kind === CI_LANE_KIND.Campaign,
            ),
            campaign: fail,
        }),
        /fresh exhaustive owner plan/,
    );
    assert.equal(invoked, false);
});

test("regression shard retains global scope and failed cases while later declared cases execute", async () => {
    const matrix = await planCiLanes({ includeCampaign: true });
    const lane = matrix.include[0];
    let executed = 0;
    let delegated;
    const report = await runCiLane({
        baseManifestPath: "unused.json",
        matrix,
        lane,
        outputRoot: await outputRoot(),
        artifactRoot: await outputRoot(),
        regressions: async (options) => {
            assert.deepEqual(
                options.corpus.map((entry) => entry.scenario.qualificationId),
                lane.caseIds,
            );
            delegated = await runRegressions({
                ...options,
                runCase: async ({ scenarioFile }) => ({
                    ...passedScenario(await readJson(scenarioFile)),
                    propertyStatus: executed++ === 0 ? "failed" : "passed",
                }),
            });
            return delegated;
        },
    });
    assertFixturePaths(report);
    assert.equal(executed, lane.caseIds.length);
    assert.equal(report.propertyStatus, "failed");
    assert.equal(ciLanePassed(report), false);
    assert.deepEqual(
        await readJson(path.join(report.ciDirectory, "matrix.json")),
        matrix,
    );
    assert.deepEqual(
        await readJson(path.join(report.ciDirectory, "lane.json")),
        lane,
    );
    assert.deepEqual(
        await readJson(path.join(report.ciDirectory, "report.json")),
        delegated,
    );
});

test("campaign lane runs its entire selected fault plan and retains failed property accounting", async () => {
    const matrix = await planCiLanes({ includeCampaign: true });
    const lane = matrix.include.find(
        (entry) => entry.kind === CI_LANE_KIND.Campaign,
    );
    let executed = 0;
    const report = await runCiLane({
        baseManifestPath: "unused.json",
        matrix,
        lane,
        outputRoot: await outputRoot(),
        artifactRoot: await outputRoot(),
        campaign: (options) => {
            assert.deepEqual(options.plan.selectedFaultModels, [
                lane.faultModelId,
            ]);
            return runCampaign({
                ...options,
                runCase: async ({ scenarioFile }) => ({
                    ...passedScenario(await readJson(scenarioFile)),
                    propertyStatus: executed++ === 0 ? "failed" : "passed",
                }),
            });
        },
    });
    assertFixturePaths(report);
    assert.equal(executed, 6);
    assert.equal(report.counts.failed, 1);
    assert.equal(report.counts.passed, 5);
    assert.equal(report.propertyStatus, "failed");
    assert.equal(ciLanePassed(report), false);
});

test("interrupted lane retains missing cases rather than claiming complete coverage", async () => {
    const matrix = await planCiLanes();
    const lane = matrix.include[0];
    const report = await runCiLane({
        baseManifestPath: "unused.json",
        matrix,
        lane,
        outputRoot: await outputRoot(),
        artifactRoot: await outputRoot(),
        regressions: (options) =>
            runRegressions({
                ...options,
                runCase: async () => ({
                    engineReplayStatus: "failed",
                    propertyStatus: "unqualified",
                    errorCode: EXECUTION_INTERRUPTED_CODE,
                }),
            }),
    });
    assertFixturePaths(report);
    assert.equal(report.executed, 1);
    assert.equal(report.missing, lane.caseIds.length - 1);
    assert.equal(report.propertyStatus, "incomplete");
    assert.equal(report.errorCode, EXECUTION_INTERRUPTED_CODE);
    assert.equal(ciLanePassed(report), false);
});

test("a fully observed campaign lane can pass without weakening case evidence requirements", async () => {
    const matrix = await planCiLanes({ includeCampaign: true });
    const lane = matrix.include.findLast(
        (entry) => entry.kind === CI_LANE_KIND.Campaign,
    );
    const report = await runCiLane({
        baseManifestPath: "unused.json",
        matrix,
        lane,
        outputRoot: await outputRoot(),
        artifactRoot: await outputRoot(),
        campaign: (options) =>
            runCampaign({
                ...options,
                runCase: async ({ scenarioFile }) =>
                    passedScenario(await readJson(scenarioFile)),
            }),
    });
    assertFixturePaths(report);
    assert.equal(report.counts.passed, lane.caseIds.length);
    assert.equal(ciLanePassed(report), true);
});

test("run inputs are required typed environment JSON, and missing reports cannot pass", async () => {
    const matrix = await planCiLanes();
    const environment = {
        [CI_RUN_ENV.BaseManifest]: "tmp/guest/manifest.json",
        [CI_RUN_ENV.Lane]: JSON.stringify(matrix.include[0]),
        [CI_RUN_ENV.Matrix]: JSON.stringify(matrix),
    };
    assert.deepEqual(readCiRunEnvironment(environment), {
        baseManifestPath: environment[CI_RUN_ENV.BaseManifest],
        lane: matrix.include[0],
        matrix,
    });
    for (const name of Object.values(CI_RUN_ENV))
        assert.throws(
            () => readCiRunEnvironment({ ...environment, [name]: "" }),
            /missing/,
        );
    assert.throws(
        () =>
            readCiRunEnvironment({
                ...environment,
                [CI_RUN_ENV.Lane]: "$(echo nope)",
            }),
        SyntaxError,
    );
    assert.equal(
        ciLanePassed({
            engineReplayStatus: "passed",
            propertyStatus: "passed",
            executed: 0,
            specified: 1,
            cases: [],
        }),
        false,
    );
    assert.equal(
        ciLanePassed({
            engineReplayStatus: "passed",
            propertyStatus: "passed",
            executed: 0,
            specified: 0,
            cases: [],
        }),
        false,
    );
});

test("blocked lanes retain their full missing scope without a manifest or process-execution permission", async () => {
    const matrix = await planCiLanes({ includeCampaign: true });
    const lane = matrix.include[0];
    const env = {
        ...process.env,
        [CI_BLOCKED_ENV.Lane]: JSON.stringify(lane),
        [CI_BLOCKED_ENV.Matrix]: JSON.stringify(matrix),
        [CI_BLOCKED_ENV.Blocker]:
            "Guest build failed before substrate qualification",
        FIXTURE_ARTIFACT_ROOT: await outputRoot(),
    };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    delete env[CI_RUN_ENV.BaseManifest];
    let stdout;
    try {
        execFileSync(
            process.execPath,
            [
                "--permission",
                "--allow-fs-read=*",
                `--allow-fs-write=${path.join(ROOT, "tmp")}`,
                "--input-type=module",
                "-e",
                `import { recordBlockedCiLane, readCiBlockedEnvironment, ciLanePassed } from './scripts/simulation/ci.mjs';
                 const report = await recordBlockedCiLane({ ...readCiBlockedEnvironment(), artifactRoot: process.env.FIXTURE_ARTIFACT_ROOT });
                 process.stdout.write(JSON.stringify(report));
                 if (!ciLanePassed(report)) process.exitCode = 1;`,
            ],
            { cwd: ROOT, env, encoding: "utf8" },
        );
        assert.fail("An entirely missing CI lane cannot exit successfully");
    } catch (error) {
        assert.equal(error.status, 1);
        stdout = error.stdout;
    }
    const regression = JSON.parse(stdout);
    const campaignLane = matrix.include.find(
        (entry) => entry.kind === CI_LANE_KIND.Campaign,
    );
    const campaign = await recordBlockedCiLane({
        lane: campaignLane,
        matrix,
        blocker: "Substrate qualification did not pass",
        artifactRoot: await outputRoot(),
    });
    for (const report of [regression, campaign]) {
        assertFixturePaths(report);
        assert.equal(report.executed, 0);
        assert.equal(report.missing, report.ciLane.caseIds.length);
        assert.equal(report.specified, report.missing);
        assert.equal(report.engineReplayStatus, "unqualified");
        assert.equal(report.propertyStatus, "incomplete");
        assert.equal(ciLanePassed(report), false);
        assert.deepEqual(
            report.cases.map((entry) => entry.caseId),
            report.ciLane.caseIds,
        );
        assert.ok(
            report.cases.every(
                (entry) =>
                    entry.status === "missing" &&
                    entry.propertyStatus === "unreached",
            ),
        );
        assert.deepEqual(
            await readJson(path.join(report.ciDirectory, "matrix.json")),
            matrix,
        );
        const retained = await readJson(
            path.join(report.ciDirectory, "report.json"),
        );
        assert.deepEqual(retained.cases, report.cases);
        assert.equal(retained.blocker, report.blocker);
    }
});

test("blocked declarations reject missing blocker text and altered global scope before writing a ledger", async () => {
    const matrix = await planCiLanes();
    const lane = matrix.include[0];
    const environment = {
        [CI_BLOCKED_ENV.Lane]: JSON.stringify(lane),
        [CI_BLOCKED_ENV.Matrix]: JSON.stringify(matrix),
        [CI_BLOCKED_ENV.Blocker]: "M0 failed",
    };
    assert.deepEqual(readCiBlockedEnvironment(environment), {
        lane,
        matrix,
        blocker: "M0 failed",
    });
    for (const name of Object.values(CI_BLOCKED_ENV))
        assert.throws(
            () => readCiBlockedEnvironment({ ...environment, [name]: "" }),
            /missing/,
        );
    const artifactRoot = await outputRoot();
    for (const blocker of [undefined, " ", 1, "x".repeat(4097)])
        await assert.rejects(
            recordBlockedCiLane({ lane, matrix, blocker, artifactRoot }),
            /blocker text/,
        );
    for (const change of [
        { lane: { ...lane, caseIds: [] } },
        { matrix: { include: [lane] } },
        { matrix: undefined },
    ])
        await assert.rejects(
            recordBlockedCiLane({
                lane,
                matrix,
                blocker: "M0 failed",
                artifactRoot,
                ...change,
            }),
            /fresh exhaustive owner plan/,
        );
    assert.deepEqual(await readdir(artifactRoot), []);
});
