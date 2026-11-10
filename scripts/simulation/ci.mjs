#!/usr/bin/env node
import { isDeepStrictEqual } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createArtifactRunDirectory } from "./artifacts.mjs";
import {
    CASE_STATUS,
    createCampaignPlan,
    listCampaignModels,
} from "./campaign.mjs";
import { discoverRegressionCorpus } from "./scenario-corpus.mjs";
import { QUALIFICATION_STATUS } from "./qualification-protocol.mjs";
import { ORDER_PROFILE, runCampaign, runRegressions } from "./workbench.mjs";

export const CI_LANE_KIND = Object.freeze({
    Regressions: "regressions",
    Campaign: "campaign",
});
export const CI_RUN_ENV = Object.freeze({
    BaseManifest: "SIMULATION_BASE_MANIFEST",
    Lane: "SIMULATION_CI_LANE",
    Matrix: "SIMULATION_CI_MATRIX",
});
export const CI_BLOCKED_ENV = Object.freeze({
    Lane: CI_RUN_ENV.Lane,
    Matrix: CI_RUN_ENV.Matrix,
    Blocker: "SIMULATION_CI_BLOCKER",
});
export const CI_REGRESSION_SHARDS = 2;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_ARTIFACT_ROOT = path.join(ROOT, "tmp/simulation-ci-lanes");
const persist = (filename, value) =>
    writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

async function owningPlan(includeCampaign, discoverCorpus) {
    if (typeof includeCampaign !== "boolean")
        throw new Error("includeCampaign must be an explicit boolean");
    const corpus = await discoverCorpus();
    if (corpus.length < CI_REGRESSION_SHARDS)
        throw new Error("The corpus must fill both CI regression shards");
    const include = Array.from(
        { length: CI_REGRESSION_SHARDS },
        (_, shard) => ({
            version: 1,
            id: `regressions-${shard + 1}-of-${CI_REGRESSION_SHARDS}`,
            kind: CI_LANE_KIND.Regressions,
            caseIds: corpus
                .filter((_, index) => index % CI_REGRESSION_SHARDS === shard)
                .map((entry) => entry.scenario.qualificationId),
        }),
    );
    const campaigns = new Map();
    if (includeCampaign)
        for (const { id } of listCampaignModels().faultModels) {
            const plan = createCampaignPlan({
                dependencies: ORDER_PROFILE.causal,
                faultModels: [id],
            });
            campaigns.set(id, plan);
            include.push({
                version: 1,
                id: `campaign-${id}`,
                kind: CI_LANE_KIND.Campaign,
                faultModelId: id,
                caseIds: plan.cases.map((entry) => entry.id),
            });
        }
    const ids = include.flatMap((lane) => lane.caseIds);
    if (new Set(ids).size !== ids.length)
        throw new Error("CI lanes must declare distinct exhaustive cases");
    return { corpus, campaigns, matrix: { include } };
}

/** Portable declarations only: no absolute paths, hidden limits or skip lists. */
export async function planCiLanes({
    includeCampaign = false,
    discoverCorpus = discoverRegressionCorpus,
} = {}) {
    return (await owningPlan(includeCampaign, discoverCorpus)).matrix;
}

async function admitCiLane(lane, matrix, discoverCorpus) {
    if (
        !lane ||
        typeof lane !== "object" ||
        Array.isArray(lane) ||
        !Object.values(CI_LANE_KIND).includes(lane.kind)
    )
        throw new Error("An explicit supported CI lane is required");
    const fresh = await owningPlan(true, discoverCorpus);
    const regressionMatrix = {
        include: fresh.matrix.include.filter(
            (entry) => entry.kind === CI_LANE_KIND.Regressions,
        ),
    };
    if (
        !isDeepStrictEqual(matrix, regressionMatrix) &&
        !isDeepStrictEqual(matrix, fresh.matrix)
    )
        throw new Error("CI matrix differs from a fresh exhaustive owner plan");
    const expected = matrix.include.find((entry) => entry.id === lane.id);
    if (!expected || !isDeepStrictEqual(lane, expected))
        throw new Error("CI lane differs from the fresh exhaustive owner plan");
    return { fresh, expected };
}

async function captureCiDeclaration(lane, matrix, artifactRoot) {
    const ciDirectory = await createArtifactRunDirectory(artifactRoot, "lane-");
    await persist(path.join(ciDirectory, "lane.json"), lane);
    await persist(path.join(ciDirectory, "matrix.json"), matrix);
    return ciDirectory;
}

/** Validate against today's owners before admitting any execution or paths. */
export async function runCiLane({
    baseManifestPath,
    lane,
    matrix,
    outputRoot,
    artifactRoot = DEFAULT_ARTIFACT_ROOT,
    discoverCorpus = discoverRegressionCorpus,
    regressions = runRegressions,
    campaign = runCampaign,
}) {
    if (typeof baseManifestPath !== "string" || !baseManifestPath.trim())
        throw new Error("An explicit base manifest path is required");
    const { fresh, expected } = await admitCiLane(lane, matrix, discoverCorpus);
    const ciDirectory = await captureCiDeclaration(lane, matrix, artifactRoot);
    const options = {
        baseManifestPath,
        ...(outputRoot === undefined ? {} : { outputRoot }),
    };
    let report;
    try {
        report =
            expected.kind === CI_LANE_KIND.Regressions
                ? await regressions({
                      ...options,
                      corpus: fresh.corpus.filter((entry) =>
                          expected.caseIds.includes(
                              entry.scenario.qualificationId,
                          ),
                      ),
                  })
                : await campaign({
                      ...options,
                      plan: fresh.campaigns.get(expected.faultModelId),
                  });
    } catch (error) {
        await persist(path.join(ciDirectory, "error.json"), {
            error: error.message,
            ...(error.directory ? { directory: error.directory } : {}),
        });
        error.ciDirectory = ciDirectory;
        throw error;
    }
    await persist(path.join(ciDirectory, "report.json"), report);
    const caseIds = report.cases?.map((entry) => entry.caseId ?? entry.id);
    if (
        report.specified !== expected.caseIds.length ||
        !isDeepStrictEqual(caseIds, expected.caseIds) ||
        !Number.isSafeInteger(report.executed) ||
        report.executed < 0 ||
        report.executed > report.specified
    )
        throw new Error(
            "CI execution report does not account for its declared lane",
        );
    // Preserve owner failure, unreached and missing accounting unchanged.
    return { ...report, ciLane: expected, ciDirectory };
}

/** A failed prerequisite leaves every assigned case missing; it executes nothing. */
export async function recordBlockedCiLane({
    lane,
    matrix,
    blocker,
    artifactRoot = DEFAULT_ARTIFACT_ROOT,
    discoverCorpus = discoverRegressionCorpus,
}) {
    if (typeof blocker !== "string" || !blocker.trim() || blocker.length > 4096)
        throw new Error(
            "A nonempty CI blocker text of at most 4096 characters is required",
        );
    const { expected } = await admitCiLane(lane, matrix, discoverCorpus);
    const ciDirectory = await captureCiDeclaration(lane, matrix, artifactRoot);
    const report = {
        version: 1,
        specified: expected.caseIds.length,
        executed: 0,
        missing: expected.caseIds.length,
        engineReplayStatus: CASE_STATUS.Unqualified,
        propertyStatus: "incomplete",
        blocker,
        cases: expected.caseIds.map((caseId) => ({
            caseId,
            status: CASE_STATUS.Missing,
            engineReplayStatus: CASE_STATUS.Unqualified,
            propertyStatus: CASE_STATUS.Unreached,
        })),
    };
    await persist(path.join(ciDirectory, "report.json"), report);
    return { ...report, ciLane: expected, ciDirectory };
}

export function ciLanePassed(report) {
    return (
        Number.isSafeInteger(report.specified) &&
        report.specified > 0 &&
        report.engineReplayStatus === QUALIFICATION_STATUS.Passed &&
        report.propertyStatus === QUALIFICATION_STATUS.Passed &&
        report.executed === report.specified &&
        report.cases?.length === report.specified &&
        report.cases.every(
            (entry) => entry.status === QUALIFICATION_STATUS.Passed,
        )
    );
}

function requireEnvironment(environment, names) {
    for (const name of names)
        if (typeof environment[name] !== "string" || !environment[name].trim())
            throw new Error(`Required CI input ${name} is missing`);
}

function readCiDeclarationEnvironment(environment) {
    if (environment[CI_RUN_ENV.Lane].length > 64 * 1024)
        throw new Error("CI lane JSON exceeds its bounded input size");
    if (environment[CI_RUN_ENV.Matrix].length > 256 * 1024)
        throw new Error("CI matrix JSON exceeds its bounded input size");
    return {
        lane: JSON.parse(environment[CI_RUN_ENV.Lane]),
        matrix: JSON.parse(environment[CI_RUN_ENV.Matrix]),
    };
}

export function readCiRunEnvironment(environment = process.env) {
    requireEnvironment(environment, Object.values(CI_RUN_ENV));
    return {
        baseManifestPath: environment[CI_RUN_ENV.BaseManifest],
        ...readCiDeclarationEnvironment(environment),
    };
}

export function readCiBlockedEnvironment(environment = process.env) {
    requireEnvironment(environment, Object.values(CI_BLOCKED_ENV));
    return {
        ...readCiDeclarationEnvironment(environment),
        blocker: environment[CI_BLOCKED_ENV.Blocker],
    };
}

/** Node 24's built-in TypeScript stripping suffices; no project install is needed. */
export async function main(args, environment = process.env) {
    if (args[0] === "plan" && args.length <= 2) {
        if (args[1] !== undefined && args[1] !== "--campaign")
            throw new Error("plan accepts only optional --campaign");
        return planCiLanes({ includeCampaign: args[1] === "--campaign" });
    }
    if (args.length === 1 && args[0] === "run")
        return runCiLane(readCiRunEnvironment(environment));
    if (args.length === 1 && args[0] === "blocked")
        return recordBlockedCiLane(readCiBlockedEnvironment(environment));
    throw new Error("Usage: ci.mjs plan [--campaign] | run | blocked");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main(process.argv.slice(2))
        .then((result) => {
            process.stdout.write(`${JSON.stringify(result)}\n`);
            if (
                ["run", "blocked"].includes(process.argv[2]) &&
                !ciLanePassed(result)
            )
                process.exitCode = 1;
        })
        .catch((error) => {
            process.stderr.write(`${error.stack ?? error.message}\n`);
            process.exitCode = 1;
        });
