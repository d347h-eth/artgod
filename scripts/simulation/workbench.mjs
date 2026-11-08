#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createArtifactRunDirectory, pinFile } from "./artifacts.mjs";
import {
    createCampaignPlan,
    renderCase,
    aggregateCampaignResults,
    listCampaignModels,
    shrinkFailingFaultCase,
    failureForShrinking,
    CASE_STATUS,
} from "./campaign.mjs";
import { prepareCase, validateScenario } from "./prepare-case.mjs";
import {
    qualify,
    EXECUTION_INTERRUPTED_CODE,
    isExecutionInterrupted,
} from "./qemu-replay.mjs";
import { discoverRegressionCorpus } from "./scenario-corpus.mjs";
import { readRunEvidence } from "./run-evidence.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const ORDER_PROFILE = Object.freeze({
    causal: [
        ["E", "V"],
        ["R", "S"],
    ],
    all: [],
});
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const persist = (filename, value) => writeFile(filename, json(value));

const interrupted = (value) =>
    isExecutionInterrupted(value) ||
    value?.errorCode === EXECUTION_INTERRUPTED_CODE ||
    value?.report?.errorCode === EXECUTION_INTERRUPTED_CODE;

function failedExecution(failure) {
    return {
        status: "failed",
        engineReplayStatus: "failed",
        propertyStatus: "unqualified",
        ...(failure.report ?? {}),
        ...(failure.directory ? { directory: failure.directory } : {}),
        ...(failure.preparationDirectory
            ? { preparationDirectory: failure.preparationDirectory }
            : {}),
        error: failure.message ?? String(failure),
        ...(interrupted(failure)
            ? { errorCode: EXECUTION_INTERRUPTED_CODE }
            : {}),
    };
}

// The execution owner stops its active child. Retain that marker before the
// scheduler can start another case; do not intercept signals between commands.
function interruptionLedger() {
    let stopped = false;
    const mark = () => {
        stopped = true;
    };
    return {
        mark,
        get stopped() {
            return stopped;
        },
        fields: () =>
            stopped ? { errorCode: EXECUTION_INTERRUPTED_CODE } : {},
    };
}

/** A fresh machine pair per case; no shared guest stores or hidden retries. */
export async function executeScenario({
    baseManifestPath,
    scenarioFile,
    prepare = prepareCase,
    execute = qualify,
    readEvidence = readRunEvidence,
}) {
    const scenario = validateScenario(
        JSON.parse(await readFile(scenarioFile, "utf8")),
    );
    let prepared;
    let report;
    try {
        prepared = await prepare({ baseManifestPath, scenarioFile });
        report = await execute(prepared.manifestPath);
    } catch (failure) {
        report = failedExecution(failure);
    }
    let observed = {};
    let evidenceError;
    if (report.directory) {
        try {
            observed = await readEvidence(report.directory);
        } catch (failure) {
            evidenceError = failure.message;
            if (interrupted(failure))
                report.errorCode = EXECUTION_INTERRUPTED_CODE;
        }
    }
    return {
        caseId: scenario.qualificationId,
        ...report,
        preparedManifest: prepared?.manifestPath,
        preparationDirectory:
            prepared?.directory ?? report.preparationDirectory,
        evidence: observed.evidence,
        coverage: observed.coverage,
        ...(evidenceError ? { evidenceError } : {}),
    };
}

/** Continue after failed scenarios; retain missing cases when interrupted. */
export async function runCampaign({
    baseManifestPath,
    plan = createCampaignPlan(),
    limit = plan.cases.length,
    outputRoot = path.join(ROOT, "tmp/simulation-campaigns"),
    runCase = executeScenario,
}) {
    if (!baseManifestPath)
        throw new Error("An explicit base manifest is required");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > plan.cases.length)
        throw new Error(
            "Campaign limit must be within the specified case count",
        );
    for (const item of plan.cases) validateScenario(item.scenario);
    const directory = await createArtifactRunDirectory(outputRoot, "campaign-");
    await persist(path.join(directory, "plan.json"), plan);
    const executions = [];
    const interruption = interruptionLedger();
    const save = async () => {
        const report = {
            ...aggregateCampaignResults(plan, executions),
            ...interruption.fields(),
        };
        await persist(path.join(directory, "executions.json"), executions);
        await persist(path.join(directory, "report.json"), report);
        return report;
    };
    await save();
    for (const item of plan.cases.slice(0, limit)) {
        if (interruption.stopped) break;
        const scenarioFile = path.join(directory, `${item.id}.json`);
        await writeFile(scenarioFile, renderCase(item), {
            flag: "wx",
            mode: 0o444,
        });
        if (interruption.stopped) break;
        let result;
        try {
            result = await runCase({ baseManifestPath, scenarioFile });
        } catch (error) {
            result = {
                caseId: item.id,
                ...failedExecution(error),
            };
        }
        if (result.caseId !== item.id)
            throw new Error("Executor returned the wrong case identity");
        executions.push(result);
        if (interrupted(result)) interruption.mark();
        // Incremental durable reports survive cancellation of a long campaign.
        await save();
    }
    return { directory, ...(await save()) };
}

export async function runRegressions({
    baseManifestPath,
    outputRoot = path.join(ROOT, "tmp/simulation-regressions"),
    runCase = executeScenario,
    corpus,
}) {
    if (!baseManifestPath)
        throw new Error("An explicit base manifest is required");
    const selected = corpus ?? (await discoverRegressionCorpus());
    if (!selected.length)
        throw new Error("An explicit regression corpus cannot be empty");
    const inputs = [];
    for (const entry of selected) {
        const payload = await readFile(entry.scenarioFile, "utf8");
        const scenario = validateScenario(JSON.parse(payload));
        inputs.push({ entry, payload, scenario });
    }
    const directory = await createArtifactRunDirectory(
        outputRoot,
        "regressions-",
    );
    // A long cohort consumes this captured plan, even while authors edit the
    // original corpus. Keep exact descriptor bytes and admit each pin again.
    const planned = [];
    for (const [index, { entry, payload, scenario }] of inputs.entries()) {
        const scenarioFile = path.join(directory, `scenario-${index}.json`);
        await writeFile(scenarioFile, payload, { flag: "wx", mode: 0o444 });
        planned.push({
            ...entry,
            sourceScenarioFile: path.resolve(entry.scenarioFile),
            scenarioFile,
            scenario,
            scenarioPin: await pinFile(scenarioFile, directory),
            caseId: scenario.qualificationId,
        });
    }
    await persist(path.join(directory, "plan.json"), {
        version: 1,
        baseManifestPath,
        cases: planned,
    });
    const cases = planned.map((entry) => ({
        ...entry,
        status: CASE_STATUS.Missing,
        engineReplayStatus: "unqualified",
        propertyStatus: CASE_STATUS.Unreached,
    }));
    const interruption = interruptionLedger();
    const save = async () => {
        const executed = cases.filter(
            (entry) => entry.status !== CASE_STATUS.Missing,
        );
        const report = {
            directory,
            specified: planned.length,
            executed: executed.length,
            missing: planned.length - executed.length,
            engineReplayStatus: executed.some(
                (entry) => entry.engineReplayStatus === "failed",
            )
                ? "failed"
                : executed.length === planned.length &&
                    executed.every(
                        (entry) => entry.engineReplayStatus === "passed",
                    )
                  ? "passed"
                  : "incomplete",
            propertyStatus: executed.some(
                (entry) => entry.propertyStatus === "failed",
            )
                ? "failed"
                : cases.every((entry) => entry.status === CASE_STATUS.Passed)
                  ? "passed"
                  : "incomplete",
            cases,
            ...interruption.fields(),
        };
        await persist(path.join(directory, "cases.json"), cases);
        await persist(path.join(directory, "report.json"), report);
        return report;
    };
    await save();
    for (const [index, entry] of planned.entries()) {
        if (interruption.stopped) break;
        let result;
        try {
            if (
                JSON.stringify(await pinFile(entry.scenarioFile, directory)) !==
                JSON.stringify(entry.scenarioPin)
            )
                throw new Error(
                    "Captured regression scenario no longer matches its planned byte pin",
                );
            result = await runCase({
                baseManifestPath,
                scenarioFile: entry.scenarioFile,
            });
        } catch (error) {
            result = failedExecution(error);
        }
        if (result.caseId !== undefined && result.caseId !== entry.caseId)
            throw new Error("Executor returned the wrong case identity");
        const status =
            result.propertyStatus === "failed"
                ? CASE_STATUS.Failed
                : result.engineReplayStatus !== "passed"
                  ? CASE_STATUS.Unqualified
                  : result.propertyStatus === "passed" && !result.evidenceError
                    ? CASE_STATUS.Passed
                    : CASE_STATUS.Unreached;
        cases[index] = { ...entry, ...result, status };
        if (interrupted(result)) interruption.mark();
        await save();
    }
    return await save();
}

/** Preserve the action history and minimize optional reached faults only. */
export async function minimizeCampaignCase({
    baseManifestPath,
    campaignDirectory,
    caseId,
    maxEvaluations = 16,
    runCase = executeScenario,
    outputRoot = path.join(ROOT, "tmp/simulation-minimization"),
}) {
    const plan = JSON.parse(
        await readFile(path.join(campaignDirectory, "plan.json"), "utf8"),
    );
    const original = plan.cases.find((item) => item.id === caseId);
    if (!original)
        throw new Error("Case must belong to the saved campaign plan");
    const directory = await createArtifactRunDirectory(outputRoot, "minimize-");
    const executions = [];
    let interruptedExecution;
    const finishInterrupted = async () => {
        const report = {
            version: 1,
            status: "interrupted",
            engineReplayStatus: "incomplete",
            propertyStatus: "unqualified",
            errorCode: EXECUTION_INTERRUPTED_CODE,
            originalCaseId: original.id,
            executed: executions.length,
            directory,
        };
        await persist(path.join(directory, "report.json"), report);
        return Object.assign(
            new Error("Minimization interrupted; attempts are retained"),
            {
                code: EXECUTION_INTERRUPTED_CODE,
                directory,
                report,
            },
        );
    };
    let result;
    try {
        result = await shrinkFailingFaultCase(
            original,
            async (item) => {
                if (interruptedExecution)
                    throw Object.assign(new Error("Minimization interrupted"), {
                        code: EXECUTION_INTERRUPTED_CODE,
                    });
                const scenarioFile = path.join(
                    directory,
                    `attempt-${executions.length}.json`,
                );
                await writeFile(scenarioFile, renderCase(item), {
                    flag: "wx",
                    mode: 0o444,
                });
                let execution;
                try {
                    execution = await runCase({
                        baseManifestPath,
                        scenarioFile,
                    });
                } catch (failure) {
                    execution = {
                        caseId: item.id,
                        ...failedExecution(failure),
                    };
                }
                executions.push(execution);
                await persist(
                    path.join(directory, "executions.json"),
                    executions,
                );
                if (interrupted(execution)) {
                    interruptedExecution = execution;
                    throw Object.assign(new Error("Minimization interrupted"), {
                        code: EXECUTION_INTERRUPTED_CODE,
                    });
                }
                return {
                    ...execution,
                    ...failureForShrinking(item, execution, plan.model),
                };
            },
            { maxEvaluations },
        );
    } catch (failure) {
        if (interruptedExecution) throw await finishInterrupted();
        throw failure;
    }
    if (interruptedExecution) throw await finishInterrupted();
    await persist(path.join(directory, "report.json"), result);
    await writeFile(
        path.join(directory, "minimal-scenario.json"),
        renderCase(result.case),
        { flag: "wx", mode: 0o444 },
    );
    return { directory, ...result };
}

function options(args, allowed, required = []) {
    const result = {};
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index]?.replace(/^--/, "");
        if (
            !args[index]?.startsWith("--") ||
            !allowed.includes(key) ||
            key in result ||
            !args[index + 1] ||
            args[index + 1].startsWith("--")
        )
            throw new Error(`Invalid or duplicate option ${args[index]}`);
        result[key] = args[index + 1];
    }
    for (const key of required)
        if (!result[key]) throw new Error(`--${key} is required`);
    return result;
}

function campaignOptions(args, baseRequired) {
    const selected = options(
        args,
        ["base-manifest", "orders", "faults", "limit"],
        baseRequired ? ["base-manifest"] : [],
    );
    const orderProfile = selected.orders ?? "causal";
    if (!Object.hasOwn(ORDER_PROFILE, orderProfile))
        throw new Error("--orders must be causal or all");
    const faultModels =
        selected.faults === "all"
            ? listCampaignModels().faultModels.map((entry) => entry.id)
            : [selected.faults ?? "held-validation"];
    const plan = createCampaignPlan({
        dependencies: ORDER_PROFILE[orderProfile],
        faultModels,
    });
    const limit =
        selected.limit === undefined
            ? plan.cases.length
            : Number(selected.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > plan.cases.length)
        throw new Error("--limit must be within the specified case count");
    return { baseManifestPath: selected["base-manifest"], plan, limit };
}

export async function main(args) {
    const [command, ...rest] = args;
    let result;
    if (command === "models") {
        options(rest, []);
        result = listCampaignModels();
    } else if (command === "plan") result = campaignOptions(rest, false).plan;
    else if (command === "campaign")
        result = await runCampaign(campaignOptions(rest, true));
    else if (command === "regressions") {
        const selected = options(rest, ["base-manifest"], ["base-manifest"]);
        result = await runRegressions({
            baseManifestPath: selected["base-manifest"],
        });
    } else if (command === "run") {
        const selected = options(
            rest,
            ["base-manifest", "scenario"],
            ["base-manifest", "scenario"],
        );
        result = await executeScenario({
            baseManifestPath: selected["base-manifest"],
            scenarioFile: selected.scenario,
        });
    } else if (command === "replay" || command === "inspect") {
        const selected = options(
            rest,
            command === "replay" ? ["run", "relocation"] : ["run"],
            ["run"],
        );
        result =
            command === "inspect"
                ? await readRunEvidence(selected.run)
                : await (
                      await import("./replay-run.mjs")
                  ).replayRun({
                      runDirectory: selected.run,
                      relocationFile: selected.relocation,
                  });
    } else if (command === "export") {
        const selected = options(rest, ["run", "storage"], ["run"]);
        result = await (
            await import("./portable-run.mjs")
        ).exportReplayBundle({
            runDirectory: selected.run,
            storage: selected.storage,
        });
    } else if (command === "export-failures") {
        const selected = options(rest, ["run-root", "max-bundles"]);
        const portable = await import("./portable-run.mjs");
        result = await portable.exportFailedRuns({
            ...(selected["run-root"] ? { runRoot: selected["run-root"] } : {}),
            ...(selected["max-bundles"] === undefined
                ? {}
                : { maxBundles: Number(selected["max-bundles"]) }),
        });
        if (
            result.entries.some(
                (entry) =>
                    entry.engineReplayStatus === "passed" &&
                    entry.propertyStatus === "failed" &&
                    entry.status === portable.BUNDLE_EXPORT_STATUS.Unqualified,
            )
        )
            process.exitCode = 1;
    } else if (command === "extract") {
        const selected = options(
            rest,
            ["run", "debugfs", "mode"],
            ["run", "debugfs"],
        );
        result = await (
            await import("./extract-run.mjs")
        ).extractRun({
            runDirectory: selected.run,
            debugfs: selected.debugfs,
            mode: selected.mode,
        });
    } else if (command === "minimize") {
        const selected = options(
            rest,
            ["base-manifest", "campaign", "case", "budget"],
            ["base-manifest", "campaign", "case"],
        );
        result = await minimizeCampaignCase({
            baseManifestPath: selected["base-manifest"],
            campaignDirectory: selected.campaign,
            caseId: selected.case,
            maxEvaluations:
                selected.budget === undefined ? 16 : Number(selected.budget),
        });
    } else
        throw new Error(
            "Usage: workbench.mjs models|plan|run|regressions|campaign|replay|inspect|export|export-failures|extract|minimize [explicit options]; see docs/development/08-simulation-workbench-execution.md",
        );
    process.stdout.write(json(result));
    if (
        ["run", "regressions", "campaign", "replay"].includes(command) &&
        (result.engineReplayStatus !== "passed" ||
            result.propertyStatus !== "passed" ||
            result.evidenceError ||
            interrupted(result))
    )
        process.exitCode = 1;
    return result;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
