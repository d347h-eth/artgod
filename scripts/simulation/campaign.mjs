import { createHash } from "node:crypto";
import {
    EXTERNAL_ACTION,
    validateScenario,
} from "./guest/scenario-contract.mjs";
import {
    QUALIFICATION_STATUS,
    CHECK_COVERAGE_STATUS,
} from "./qualification-protocol.mjs";
import forkScenario from "./scenarios/fork.json" with { type: "json" };

export const CASE_STATUS = Object.freeze({
    Passed: CHECK_COVERAGE_STATUS.Passed,
    Failed: CHECK_COVERAGE_STATUS.Failed,
    Missing: "missing",
    Unreached: CHECK_COVERAGE_STATUS.Unreached,
    Unreachable: "unreachable",
    Unqualified: "unqualified",
});

// These are authored external commands with coordinator acknowledgements.
// Each actual RPC delivery, worker action and transaction needs its own trace.
export const FORK_EVENT_MODEL = Object.freeze({
    id: "fork-external-v1",
    events: [
        {
            id: "E",
            action: EXTERNAL_ACTION.CanonicalSwitch,
            description:
                "Expose branch B/head 107 and observe committed recovery",
        },
        {
            id: "R",
            action: EXTERNAL_ACTION.RestoreInventory,
            description: "Restore the source's current listing inventory",
        },
        {
            id: "S",
            action: EXTERNAL_ACTION.StreamListing,
            description:
                "Publish the current listing through the external stream",
        },
        {
            id: "V",
            action: EXTERNAL_ACTION.ReleaseValidation,
            description:
                "Release the old reply gate; runtime validation completion remains independently observed",
        },
    ],
    dependencies: [],
    preludeBarrier: "old-validation",
    completionCheckpoint: "settled",
    limits: {
        chains: 1,
        collections: 1,
        tokens: 2,
        branches: 2,
        externalEvents: 4,
        canonicalTail: {
            maximumHead: forkScenario.headProgress.maximumHead,
            blockIntervalSeconds: forkScenario.world.tailBlockIntervalSeconds,
        },
    },
    evidenceLimit:
        "Orders of these four external commands only, followed by the common bounded canonical tail; V releases a fixture reply gate without acknowledging runtime validation completion; no claim of all RPC, OS, SQLite, broker or JavaScript schedules",
});

export const FORK_FAULT_MODELS = Object.freeze([
    { id: "held-validation", faults: [] },
    {
        id: "header-drop-once",
        faults: [
            {
                id: "drop-header",
                kind: "rpc-error-response",
                requires: [],
                script: {
                    id: "drop-header",
                    when: {
                        provider: "default",
                        phase: "fork-held",
                        method: "eth_getBlockByNumber",
                    },
                    fault: {
                        code: -32000,
                        message: "Scripted transient provider unavailability",
                    },
                },
            },
        ],
    },
]);

function validateOrderModel(eventIds, dependencies) {
    if (
        !Array.isArray(eventIds) ||
        !eventIds.length ||
        eventIds.length > 8 ||
        new Set(eventIds).size !== eventIds.length ||
        eventIds.some(
            (id) => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id),
        )
    )
        throw new Error(
            "Order model requires one to eight distinct event identifiers",
        );
    if (!Array.isArray(dependencies))
        throw new Error("Dependencies must be explicit");
    for (const edge of dependencies) {
        if (
            !Array.isArray(edge) ||
            edge.length !== 2 ||
            edge[0] === edge[1] ||
            edge.some((id) => !eventIds.includes(id))
        )
            throw new Error(
                "Dependency must name two different declared events",
            );
    }
}

/** Exhaustive linear extensions of this finite declared partial order only. */
export function enumerateEventOrders(eventIds, dependencies = []) {
    validateOrderModel(eventIds, dependencies);
    const orders = [];
    const sorted = [...eventIds].sort();
    const visit = (prefix, remaining) => {
        if (!remaining.length) {
            orders.push(prefix);
            return;
        }
        for (const event of remaining) {
            if (
                dependencies.some(
                    ([before, after]) =>
                        after === event && !prefix.includes(before),
                )
            )
                continue;
            visit(
                [...prefix, event],
                remaining.filter((id) => id !== event),
            );
        }
    };
    visit([], sorted);
    if (!orders.length)
        throw new Error("Cyclic event dependencies have no legal order");
    return orders;
}

export function listCampaignModels() {
    return {
        version: 1,
        model: structuredClone(FORK_EVENT_MODEL),
        faultModels: structuredClone(FORK_FAULT_MODELS),
    };
}

export function createCampaignPlan({
    dependencies = [],
    faultModels = ["held-validation"],
} = {}) {
    const model = structuredClone(FORK_EVENT_MODEL);
    const template = validateScenario(forkScenario);
    if (
        !template.world?.scripts?.some(
            (script) => script.after?.barrier === model.preludeBarrier,
        )
    )
        throw new Error(
            "The owning fork scenario lacks the required validation prelude",
        );
    model.dependencies = structuredClone(dependencies);
    const orders = enumerateEventOrders(
        model.events.map((event) => event.id),
        dependencies,
    );
    if (
        !Array.isArray(faultModels) ||
        !faultModels.length ||
        new Set(faultModels).size !== faultModels.length
    )
        throw new Error("Select distinct authored fault models explicitly");
    const selected = faultModels.map((id) => {
        const variant = FORK_FAULT_MODELS.find((item) => item.id === id);
        if (!variant) throw new Error(`Unknown authored fault model ${id}`);
        return variant;
    });
    const cases = selected.flatMap((variant) =>
        orders.map((order) => {
            const id = `${model.id}-${variant.id}-${order.join("")}`;
            const schedule = order.map(
                (id) => model.events.find((event) => event.id === id).action,
            );
            const scenario = validateScenario({
                ...structuredClone(template),
                qualificationId: id,
                schedule,
                world: {
                    ...structuredClone(template.world),
                    scripts: [
                        ...structuredClone(template.world.scripts),
                        ...variant.faults.map((fault) =>
                            structuredClone(fault.script),
                        ),
                    ],
                },
            });
            return {
                id,
                modelId: model.id,
                faultModelId: variant.id,
                order,
                schedule,
                requiredFaults: variant.faults.map((fault) => fault.id),
                faults: structuredClone(variant.faults),
                scenario,
            };
        }),
    );
    return {
        version: 1,
        id: model.id,
        model,
        selectedFaultModels: [...faultModels],
        legalOrdersPerFaultModel: orders.length,
        cases,
        status: "specified",
    };
}

/** JSON is suitable for the read-only guest scenario input device. */
export function renderCase(testCase) {
    return `${JSON.stringify(validateScenario(testCase.scenario), null, 2)}\n`;
}

function evidenceFor(execution) {
    const evidence = execution.evidence ?? {};
    const trace = execution.trace ?? evidence.trace ?? [];
    return {
        actions:
            evidence.externalActions ??
            trace.filter((entry) => entry.type === "scenario-action"),
        barriers:
            evidence.reachedBarriers ??
            trace
                .filter((entry) => entry.type === "barrier-reached")
                .map((entry) => entry.name),
        checkpoints: evidence.checkpoints ?? [],
        scripts: evidence.world?.scripts ?? [],
    };
}

// A reported failed check is not evidence that the authored history ran. Keep
// this common to coverage accounting and shrinking so neither can invent reach.
function historyEvidenceGaps(
    testCase,
    execution,
    model,
    { requireCompletion = true } = {},
) {
    const reached = evidenceFor(execution);
    const gaps = [];
    if (!reached.barriers.includes(model.preludeBarrier))
        gaps.push(`Prelude barrier not reached: ${model.preludeBarrier}`);
    const actualActions = reached.actions.map((entry) => entry.action);
    if (
        testCase.schedule.length !== model.events.length ||
        new Set(testCase.schedule).size !== model.events.length ||
        model.events.some(
            (event) => !testCase.schedule.includes(event.action),
        ) ||
        actualActions.length !== testCase.schedule.length ||
        actualActions.some(
            (action, index) => action !== testCase.schedule[index],
        )
    )
        gaps.push(
            "Required external actions did not complete in the declared order",
        );
    for (const entry of reached.actions) {
        if (
            entry.action === EXTERNAL_ACTION.CanonicalSwitch &&
            !(entry.committedRevision > 0)
        )
            gaps.push("Canonical switch lacks observed rollback revision");
        if (
            entry.action === EXTERNAL_ACTION.StreamListing &&
            !(entry.deliveredRecipients > 0)
        )
            gaps.push("Stream publication did not reach a subscriber");
    }
    if (
        requireCompletion &&
        !reached.checkpoints.some(
            (checkpoint) => checkpoint.name === model.completionCheckpoint,
        )
    )
        gaps.push(
            `Completion checkpoint not reached: ${model.completionCheckpoint}`,
        );
    for (const id of testCase.requiredFaults)
        if (
            !reached.scripts.some(
                (script) => script.id === id && script.applied === true,
            )
        )
            gaps.push(`Authored fault not reached: ${id}`);
    return gaps;
}

/** Only an explicitly failed oracle after the complete authored history can shrink. */
export function failureForShrinking(
    testCase,
    execution,
    model = FORK_EVENT_MODEL,
) {
    if (execution?.caseId !== testCase.id)
        throw new Error("Execution case identity mismatch");
    const evidence = execution.evidence ?? {};
    const failedCheck = execution.failedCheck ?? evidence.failedCheck;
    const failureProperty = execution.failedProperty ?? evidence.failedProperty;
    const coverage = execution.coverage ?? evidence.coverage ?? [];
    const failed = coverage.filter(
        (entry) => entry.status === CASE_STATUS.Failed,
    );
    const checks = execution.guestReportedChecks ?? execution.checks ?? {};
    const explicitFailure =
        execution.engineReplayStatus === QUALIFICATION_STATUS.Passed &&
        execution.propertyStatus === QUALIFICATION_STATUS.Failed &&
        execution.unreachable === undefined &&
        typeof failedCheck === "string" &&
        testCase.scenario.expectedChecks.includes(failedCheck) &&
        typeof failureProperty === "string" &&
        failureProperty.trim().length > 0 &&
        failed.length === 1 &&
        failed[0].check === failedCheck &&
        checks[failedCheck] === false;
    return {
        engineReplayStatus: execution.engineReplayStatus,
        propertyStatus: execution.propertyStatus,
        // A stopped failing assertion need not reach the final success checkpoint.
        // Its prelude, core commands, acknowledgements and selected faults must.
        reached:
            explicitFailure &&
            historyEvidenceGaps(testCase, execution, model, {
                requireCompletion: false,
            }).length === 0,
        failureProperty,
    };
}

/** Evaluate reached-state evidence separately from replay and reported truth. */
export function assessCaseResult(
    testCase,
    execution,
    model = FORK_EVENT_MODEL,
) {
    if (!execution)
        return {
            id: testCase.id,
            status: CASE_STATUS.Missing,
            engineReplayStatus: "unqualified",
            propertyStatus: CASE_STATUS.Unreached,
            gaps: ["No execution result"],
        };
    if (execution.caseId !== testCase.id)
        throw new Error("Execution case identity mismatch");
    if (execution.unreachable !== undefined) {
        if (
            typeof execution.unreachable !== "string" ||
            !execution.unreachable.trim()
        )
            throw new Error("Unreachable cases need an explicit reason");
        if (execution.propertyStatus === QUALIFICATION_STATUS.Failed)
            throw new Error(
                "A failed property cannot be reclassified as unreachable",
            );
        return {
            id: testCase.id,
            status: CASE_STATUS.Unreachable,
            engineReplayStatus: execution.engineReplayStatus ?? "unqualified",
            propertyStatus: CASE_STATUS.Unreached,
            gaps: [execution.unreachable],
        };
    }
    const gaps = historyEvidenceGaps(testCase, execution, model);
    const checks = execution.guestReportedChecks ?? execution.checks ?? {};
    const explicitCoverage =
        execution.coverage ?? execution.evidence?.coverage ?? [];
    const checkCoverage = testCase.scenario.expectedChecks.map((check) => {
        const explicit = explicitCoverage.find(
            (entry) => entry.check === check,
        )?.status;
        let status =
            explicit ??
            (checks[check] === true
                ? CASE_STATUS.Passed
                : CASE_STATUS.Unreached);
        if (
            ![
                CASE_STATUS.Passed,
                CASE_STATUS.Failed,
                CASE_STATUS.Unreached,
            ].includes(status)
        )
            throw new Error(`Unknown check coverage status ${status}`);
        if (
            status === CASE_STATUS.Passed &&
            (checks[check] !== true || gaps.length)
        )
            status = CASE_STATUS.Unreached;
        return { check, status };
    });
    const engineReplayStatus = execution.engineReplayStatus ?? "unqualified";
    const propertyStatus = execution.propertyStatus ?? CASE_STATUS.Unreached;
    // A reproduced failed property stays failed even if later checkpoints did
    // not complete. Missing evidence is retained, never used as a bug waiver.
    const status =
        propertyStatus === QUALIFICATION_STATUS.Failed ||
        checkCoverage.some((check) => check.status === CASE_STATUS.Failed)
            ? CASE_STATUS.Failed
            : engineReplayStatus !== QUALIFICATION_STATUS.Passed
              ? CASE_STATUS.Unqualified
              : propertyStatus !== QUALIFICATION_STATUS.Passed ||
                  gaps.length ||
                  checkCoverage.some(
                      (check) => check.status !== CASE_STATUS.Passed,
                  )
                ? CASE_STATUS.Unreached
                : CASE_STATUS.Passed;
    return {
        id: testCase.id,
        status,
        engineReplayStatus,
        propertyStatus,
        gaps,
        checks: checkCoverage,
    };
}

export function aggregateCampaignResults(plan, executions = []) {
    const byId = new Map();
    for (const execution of executions) {
        if (!plan.cases.some((testCase) => testCase.id === execution.caseId))
            throw new Error(`Result for undeclared case ${execution.caseId}`);
        if (byId.has(execution.caseId))
            throw new Error(`Duplicate case result ${execution.caseId}`);
        byId.set(execution.caseId, execution);
    }
    const cases = plan.cases.map((testCase) =>
        assessCaseResult(testCase, byId.get(testCase.id), plan.model),
    );
    const counts = Object.fromEntries(
        Object.values(CASE_STATUS).map((status) => [
            status,
            cases.filter((entry) => entry.status === status).length,
        ]),
    );
    return {
        version: 1,
        campaignId: plan.id,
        specified: plan.cases.length,
        executed: executions.filter((execution) => !execution.unreachable)
            .length,
        counts,
        engineReplayStatus: cases.every(
            (entry) => entry.engineReplayStatus === QUALIFICATION_STATUS.Passed,
        )
            ? QUALIFICATION_STATUS.Passed
            : "incomplete",
        propertyStatus: counts.failed
            ? QUALIFICATION_STATUS.Failed
            : counts.passed === plan.cases.length
              ? QUALIFICATION_STATUS.Passed
              : "incomplete",
        cases,
        evidenceLimit: plan.model.evidenceLimit,
    };
}

function faultSubsetLegal(faults) {
    const ids = new Set(faults.map((fault) => fault.id));
    return faults.every((fault) =>
        (fault.requires ?? []).every((required) => ids.has(required)),
    );
}

/**
 * Minimize optional explicit RPC faults, preserving the four guest actions and
 * causal fault dependencies. Only the same reached failure with qualified replay
 * is an accepted counterexample; emulator failures/timeouts cannot replace it.
 */
export async function shrinkFailingFaultCase(
    testCase,
    evaluate,
    { maxEvaluations = 16 } = {},
) {
    if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 1)
        throw new Error("A positive bounded shrink budget is required");
    let current = structuredClone(testCase);
    const original = await evaluate(current);
    const isReproduced = (result, property) =>
        result?.engineReplayStatus === QUALIFICATION_STATUS.Passed &&
        result?.propertyStatus === QUALIFICATION_STATUS.Failed &&
        result?.reached === true &&
        typeof result.failureProperty === "string" &&
        result.failureProperty.length > 0 &&
        (property === undefined || result.failureProperty === property);
    if (!isReproduced(original))
        throw new Error(
            "Shrinking requires a reached failed property with qualified replay",
        );
    const failureProperty = original.failureProperty;
    const attempts = [];
    let evaluations = 1;
    let changed = true;
    let budgetExhausted = false;
    outer: while (changed) {
        changed = false;
        for (const fault of current.faults) {
            const faults = current.faults.filter(
                (candidate) => candidate.id !== fault.id,
            );
            if (!faultSubsetLegal(faults)) {
                attempts.push({
                    removed: fault.id,
                    status: "causally-required",
                });
                continue;
            }
            if (evaluations >= maxEvaluations) {
                budgetExhausted = true;
                break outer;
            }
            const candidate = structuredClone(current);
            candidate.faults = faults;
            candidate.requiredFaults = faults.map((item) => item.id);
            candidate.scenario.world.scripts =
                candidate.scenario.world.scripts.filter(
                    (script) => script.id !== fault.id,
                );
            const suffix = createHash("sha256")
                .update(JSON.stringify(candidate.scenario.world.scripts))
                .digest("hex")
                .slice(0, 8);
            candidate.id = `${testCase.id.slice(0, 66)}-min-${suffix}`;
            candidate.scenario.qualificationId = candidate.id;
            validateScenario(candidate.scenario);
            let result;
            try {
                result = await evaluate(candidate);
            } catch (error) {
                result = {
                    engineReplayStatus: QUALIFICATION_STATUS.Failed,
                    propertyStatus: CASE_STATUS.Unreached,
                    error: error.message,
                };
            }
            evaluations++;
            const accepted = isReproduced(result, failureProperty);
            attempts.push({
                removed: fault.id,
                status: accepted ? "same-failure" : "not-same-reached-failure",
                engineReplayStatus: result?.engineReplayStatus,
                propertyStatus: result?.propertyStatus,
            });
            if (accepted) {
                current = candidate;
                changed = true;
                break;
            }
        }
    }
    return {
        version: 1,
        originalCaseId: testCase.id,
        failureProperty,
        evaluations,
        budgetExhausted,
        minimality:
            "single-fault deletion under declared dependencies and evaluation budget; core action order is unchanged",
        attempts,
        case: current,
    };
}
