import assert from "node:assert/strict";
import test from "node:test";
import {
    CASE_STATUS,
    FORK_EVENT_MODEL,
    aggregateCampaignResults,
    assessCaseResult,
    createCampaignPlan,
    enumerateEventOrders,
    failureForShrinking,
    listCampaignModels,
    renderCase,
    shrinkFailingFaultCase,
} from "./campaign.mjs";
import {
    EXTERNAL_ACTION,
    validateScenario,
} from "./guest/scenario-contract.mjs";

// Independently authored expected orders; never generate the expected set using
// the enumerator whose completeness is being checked.
const ALL_ORDERS = [
    "ERSV",
    "ERVS",
    "ESRV",
    "ESVR",
    "EVRS",
    "EVSR",
    "RESV",
    "REVS",
    "RSEV",
    "RSVE",
    "RVES",
    "RVSE",
    "SERV",
    "SEVR",
    "SREV",
    "SRVE",
    "SVER",
    "SVRE",
    "VERS",
    "VESR",
    "VRES",
    "VRSE",
    "VSER",
    "VSRE",
];

test("finite four-event model enumerates exactly the independent 24-order reference", () => {
    const orders = enumerateEventOrders(["V", "E", "S", "R"]);
    assert.deepEqual(
        orders.map((order) => order.join("")),
        ALL_ORDERS,
    );
    assert.equal(new Set(orders.map((order) => order.join(""))).size, 24);
});

test("causal dependencies admit exactly six independently specified legal orders", () => {
    assert.deepEqual(
        enumerateEventOrders(
            ["E", "R", "S", "V"],
            [
                ["E", "V"],
                ["R", "S"],
            ],
        ).map((order) => order.join("")),
        ["ERSV", "ERVS", "EVRS", "RESV", "REVS", "RSEV"],
    );
    assert.throws(
        () =>
            enumerateEventOrders(
                ["E", "V"],
                [
                    ["E", "V"],
                    ["V", "E"],
                ],
            ),
        /Cyclic/,
    );
    assert.throws(
        () => enumerateEventOrders(["E", "V"], [["E", "unknown"]]),
        /declared events/,
    );
    assert.throws(() => enumerateEventOrders(["E", "E"]), /distinct/);
});

test("rendered cases use the actual guest contract, stable IDs and explicit authored fault scope", () => {
    const plan = createCampaignPlan({
        faultModels: ["held-validation", "header-drop-once"],
    });
    assert.equal(plan.cases.length, 48);
    assert.equal(plan.status, "specified");
    assert.deepEqual(
        createCampaignPlan({
            faultModels: ["held-validation", "header-drop-once"],
        }),
        plan,
    );
    for (const item of plan.cases) {
        const scenario = JSON.parse(renderCase(item));
        assert.equal(scenario.qualificationId, item.id);
        assert.deepEqual(validateScenario(scenario), scenario);
        assert.deepEqual(scenario.schedule, item.schedule);
        assert.equal(
            scenario.world.scripts.filter(
                (script) =>
                    script.after?.barrier === FORK_EVENT_MODEL.preludeBarrier,
            ).length,
            1,
        );
    }
    assert.match(plan.model.evidenceLimit, /no claim/);
    assert.equal(
        listCampaignModels().faultModels[1].faults[0].kind,
        "rpc-error-response",
    );
    assert.throws(
        () => createCampaignPlan({ faultModels: ["random-chaos"] }),
        /Unknown authored/,
    );
    assert.throws(() => createCampaignPlan({ faultModels: [] }), /explicitly/);
});

// Synthetic reporting inputs test the checker only; no result here represents
// an executed VM or evidence that a production scenario passes.
function reportingFixture(item) {
    return {
        caseId: item.id,
        engineReplayStatus: "passed",
        propertyStatus: "passed",
        guestReportedChecks: Object.fromEntries(
            item.scenario.expectedChecks.map((check) => [check, true]),
        ),
        evidence: {
            reachedBarriers: ["old-validation"],
            externalActions: item.schedule.map((action, index) => ({
                action,
                sequence: index + 1,
                ...(action === EXTERNAL_ACTION.CanonicalSwitch
                    ? { committedRevision: 1 }
                    : {}),
                ...(action === EXTERNAL_ACTION.StreamListing
                    ? { deliveredRecipients: 1 }
                    : {}),
            })),
            checkpoints: [{ name: "settled" }],
            world: {
                scripts: item.requiredFaults.map((id) => ({
                    id,
                    used: true,
                    applied: true,
                })),
            },
        },
    };
}

test("report checker refuses green claims without reached barriers, actions and convergence", () => {
    const item = createCampaignPlan().cases[0];
    const result = reportingFixture(item);
    assert.equal(assessCaseResult(item, result).status, CASE_STATUS.Passed);
    for (const mutate of [
        (value) => {
            value.evidence.reachedBarriers = [];
        },
        (value) => {
            value.evidence.externalActions.reverse();
        },
        (value) => {
            value.evidence.checkpoints = [];
        },
        (value) => {
            value.evidence.externalActions.find(
                (entry) => entry.action === EXTERNAL_ACTION.StreamListing,
            ).deliveredRecipients = 0;
        },
        (value) => {
            value.evidence.externalActions.find(
                (entry) => entry.action === EXTERNAL_ACTION.CanonicalSwitch,
            ).committedRevision = 0;
        },
    ]) {
        const candidate = structuredClone(result);
        mutate(candidate);
        const assessed = assessCaseResult(item, candidate);
        assert.equal(assessed.status, CASE_STATUS.Unreached);
        assert.ok(assessed.gaps.length > 0);
        assert.ok(
            assessed.checks.every(
                (check) => check.status === CASE_STATUS.Unreached,
            ),
        );
    }
});

test("unapplied RPC fault cannot qualify a fault model even if its match was selected", () => {
    const item = createCampaignPlan({ faultModels: ["header-drop-once"] })
        .cases[0];
    const execution = reportingFixture(item);
    execution.evidence.world.scripts[0].applied = false;
    const result = assessCaseResult(item, execution);
    assert.equal(result.status, CASE_STATUS.Unreached);
    assert.match(result.gaps.join(" "), /Authored fault not reached/);
});

test("failed properties remain failed alongside independent engine and reached-state gaps", () => {
    const item = createCampaignPlan().cases[0];
    const execution = reportingFixture(item);
    execution.propertyStatus = "failed";
    execution.guestReportedChecks["reorg-recovery"] = false;
    execution.coverage = [
        { check: "reorg-recovery", status: CASE_STATUS.Failed },
    ];
    execution.evidence.checkpoints = [];
    const result = assessCaseResult(item, execution);
    assert.equal(result.engineReplayStatus, "passed");
    assert.equal(result.status, CASE_STATUS.Failed);
    assert.equal(
        result.checks.find((check) => check.check === "reorg-recovery").status,
        CASE_STATUS.Failed,
    );
    assert.ok(result.gaps.length);
    assert.throws(
        () =>
            assessCaseResult(item, { ...execution, unreachable: "Known bug" }),
        /cannot be reclassified/,
    );
    const emulatorFailed = reportingFixture(item);
    emulatorFailed.engineReplayStatus = "failed";
    assert.equal(
        assessCaseResult(item, emulatorFailed).status,
        CASE_STATUS.Unqualified,
    );
});

test("campaign aggregation accounts for missing and unreachable cases rather than silently filtering them", () => {
    const plan = createCampaignPlan({
        dependencies: [
            ["E", "V"],
            ["R", "S"],
        ],
    });
    const result = aggregateCampaignResults(plan, [
        reportingFixture(plan.cases[0]),
        {
            caseId: plan.cases[1].id,
            unreachable: "Declared precondition could not be reached",
        },
    ]);
    assert.equal(result.specified, 6);
    assert.equal(result.executed, 1);
    assert.deepEqual(result.counts, {
        passed: 1,
        failed: 0,
        missing: 4,
        unreached: 0,
        unreachable: 1,
        unqualified: 0,
    });
    assert.equal(result.engineReplayStatus, "incomplete");
    assert.equal(result.propertyStatus, "incomplete");
    assert.throws(
        () => aggregateCampaignResults(plan, [{ caseId: "undeclared" }]),
        /undeclared/,
    );
    assert.throws(
        () =>
            aggregateCampaignResults(plan, [
                reportingFixture(plan.cases[0]),
                reportingFixture(plan.cases[0]),
            ]),
        /Duplicate/,
    );
    assert.throws(
        () =>
            aggregateCampaignResults(plan, [
                { caseId: plan.cases[0].id, unreachable: "" },
            ]),
        /explicit reason/,
    );
});

test("complete synthetic report corpus needs every legal case and preserves one counterexample", () => {
    const plan = createCampaignPlan();
    const results = plan.cases.map(reportingFixture);
    assert.equal(
        aggregateCampaignResults(plan, results).propertyStatus,
        "passed",
    );
    results[7].propertyStatus = "failed";
    results[7].guestReportedChecks["reorg-recovery"] = false;
    const summary = aggregateCampaignResults(plan, results);
    assert.equal(summary.engineReplayStatus, "passed");
    assert.equal(summary.propertyStatus, "failed");
    assert.equal(summary.counts.failed, 1);
});

const reproduced = (failureProperty = "order-canonicality") => ({
    engineReplayStatus: "passed",
    propertyStatus: "failed",
    reached: true,
    failureProperty,
});

function failedReportingFixture(item) {
    const execution = reportingFixture(item);
    execution.propertyStatus = "failed";
    execution.guestReportedChecks["reorg-recovery"] = false;
    execution.coverage = [
        { check: "reorg-recovery", status: CASE_STATUS.Failed },
    ];
    execution.evidence.failedCheck = "reorg-recovery";
    execution.evidence.failedProperty = "order-canonicality";
    execution.evidence.checkpoints = [];
    return execution;
}

test("prelude phase activation and one failed check cannot invent a reached shrink history", async () => {
    const item = createCampaignPlan({ faultModels: ["header-drop-once"] })
        .cases[0];
    const early = failedReportingFixture(item);
    early.evidence.reachedBarriers = [];
    early.evidence.externalActions = [];
    early.evidence.world.phase = "fork-held";
    assert.equal(failureForShrinking(item, early).reached, false);
    assert.equal(
        assessCaseResult(item, early).status,
        CASE_STATUS.Failed,
        "Unreached history must remain a failed scenario, not a shrinkable oracle counterexample",
    );
    await assert.rejects(
        shrinkFailingFaultCase(item, async (candidate) =>
            failureForShrinking(candidate, { ...early, caseId: candidate.id }),
        ),
        /reached failed property/,
    );
});

test("a stopped oracle failure after the actual authored history can minimize without final success", async () => {
    const item = createCampaignPlan({ faultModels: ["header-drop-once"] })
        .cases[0];
    const execution = failedReportingFixture(item);
    assert.equal(failureForShrinking(item, execution).reached, true);
    assert.match(
        assessCaseResult(item, execution).gaps.join(" "),
        /Completion checkpoint not reached/,
    );
    const result = await shrinkFailingFaultCase(item, async (candidate) =>
        failureForShrinking(candidate, failedReportingFixture(candidate)),
    );
    assert.equal(result.case.requiredFaults.length, 0);
    assert.equal(result.failureProperty, "order-canonicality");
    assert.equal(result.attempts[0].status, "same-failure");
});

test("shrinking requires every command acknowledgement and actually applied optional faults", () => {
    const item = createCampaignPlan({ faultModels: ["header-drop-once"] })
        .cases[0];
    for (const mutate of [
        (value) => {
            value.evidence.externalActions.pop();
        },
        (value) => {
            value.evidence.externalActions.reverse();
        },
        (value) => {
            value.evidence.externalActions.find(
                (entry) => entry.action === EXTERNAL_ACTION.CanonicalSwitch,
            ).committedRevision = 0;
        },
        (value) => {
            value.evidence.externalActions.find(
                (entry) => entry.action === EXTERNAL_ACTION.StreamListing,
            ).deliveredRecipients = 0;
        },
        (value) => {
            value.evidence.world.scripts[0].applied = false;
        },
        (value) => {
            value.evidence.world.scripts = [];
        },
    ]) {
        const execution = failedReportingFixture(item);
        mutate(execution);
        assert.equal(failureForShrinking(item, execution).reached, false);
    }
    const incompleteCase = structuredClone(item);
    incompleteCase.schedule = [];
    const execution = failedReportingFixture(incompleteCase);
    assert.equal(failureForShrinking(incompleteCase, execution).reached, false);
});

test("shrinking needs qualified replay and one consistent explicit failed oracle identity", () => {
    const item = createCampaignPlan().cases[0];
    for (const mutate of [
        (value) => {
            delete value.evidence.failedCheck;
        },
        (value) => {
            delete value.evidence.failedProperty;
        },
        (value) => {
            value.evidence.failedCheck = "http-projection";
        },
        (value) => {
            value.evidence.failedProperty = " ";
        },
        (value) => {
            value.coverage.push({
                check: "http-projection",
                status: CASE_STATUS.Failed,
            });
        },
        (value) => {
            value.coverage = [];
        },
        (value) => {
            value.engineReplayStatus = "failed";
        },
        (value) => {
            value.propertyStatus = "passed";
        },
        (value) => {
            value.guestReportedChecks["reorg-recovery"] = true;
        },
    ]) {
        const execution = failedReportingFixture(item);
        mutate(execution);
        assert.equal(failureForShrinking(item, execution).reached, false);
    }
});

test("fault shrink preserves core event schedule, causal requirements and the same reached failure", async () => {
    const item = createCampaignPlan({ faultModels: ["header-drop-once"] })
        .cases[0];
    item.faults.push({
        id: "dependent",
        requires: ["drop-header"],
        script: {
            id: "dependent",
            when: { phase: "canonical-b", method: "eth_blockNumber" },
            fault: { code: -32000, message: "Second authored failure" },
        },
    });
    item.requiredFaults.push("dependent");
    item.scenario.world.scripts.push(item.faults[1].script);
    const attempted = [];
    const result = await shrinkFailingFaultCase(item, async (candidate) => {
        attempted.push(candidate.requiredFaults);
        return reproduced();
    });
    assert.equal(result.case.faults.length, 0);
    assert.equal(
        result.case.scenario.world.scripts.filter(
            (script) =>
                script.after?.barrier === FORK_EVENT_MODEL.preludeBarrier,
        ).length,
        1,
        "Shrinking optional faults must preserve the real held-validation prelude",
    );
    assert.deepEqual(result.case.schedule, item.schedule);
    assert.deepEqual(result.case.scenario.schedule, item.scenario.schedule);
    assert.deepEqual(
        validateScenario(JSON.parse(renderCase(result.case))),
        result.case.scenario,
    );
    assert.ok(
        result.attempts.some((entry) => entry.status === "causally-required"),
    );
    assert.ok(
        !attempted.some(
            (ids) => ids.includes("dependent") && !ids.includes("drop-header"),
        ),
    );
    assert.notEqual(result.case.id, item.id);
    assert.equal(result.budgetExhausted, false);
});

test("shrink rejects other failures, unreached failures, engine errors and exhausted budgets", async () => {
    const item = createCampaignPlan({ faultModels: ["header-drop-once"] })
        .cases[0];
    for (const candidateResult of [
        reproduced("other-property"),
        { ...reproduced(), reached: false },
        { ...reproduced(), engineReplayStatus: "failed" },
        { ...reproduced(), propertyStatus: "passed" },
    ]) {
        let calls = 0;
        const result = await shrinkFailingFaultCase(item, async () =>
            ++calls === 1 ? reproduced() : candidateResult,
        );
        assert.equal(result.case.faults.length, 1);
    }
    const bounded = await shrinkFailingFaultCase(
        item,
        async () => reproduced(),
        { maxEvaluations: 1 },
    );
    assert.equal(bounded.evaluations, 1);
    assert.equal(bounded.budgetExhausted, true);
    assert.equal(bounded.case.faults.length, 1);
    await assert.rejects(
        shrinkFailingFaultCase(item, async () => ({
            ...reproduced(),
            reached: false,
        })),
        /reached failed property/,
    );
    assert.equal(FORK_EVENT_MODEL.limits.externalEvents, 4);
});
