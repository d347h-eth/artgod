import assert from "node:assert/strict";
import test from "node:test";
import { createBaselineLedger } from "../world/ledger.mjs";
import baseline from "../scenarios/baseline.json" with { type: "json" };
import {
    validateScenario,
    DATA_PLANE_JOURNEY,
    SCENARIO_CHECKS,
} from "./scenario-contract.mjs";
import {
    createHeadProgress,
    HEAD_PROGRESS_EVENT,
    HEAD_PROGRESS_PROPERTY,
} from "./head-progress.mjs";

function fixture(maximumHead = 110) {
    const ledger = createBaselineLedger({
        epochSeconds: 1_000_000,
        tailBlockIntervalSeconds: 12,
    });
    let time = ledger.blockAt("B", 107).timestamp * 1000;
    const views = {
        default: { branch: "B", head: 107 },
        a: { branch: "B", head: 107 },
    };
    const events = [];
    let poll;
    let cancelled = false;
    const world = {
        providerView: (id) => ({ ...views[id] }),
        advanceHead: (head) => {
            for (const value of Object.values(views)) value.head = head;
        },
        recordExternal: (event) => events.push(event),
    };
    const progress = createHeadProgress({
        world,
        ledger,
        maximumHead,
        providers: Object.keys(views),
        now: () => time,
        schedule: (callback) => {
            poll = callback;
            return { unref() {} };
        },
        cancel: () => {
            cancelled = true;
        },
    });
    return {
        ledger,
        views,
        events,
        progress,
        setTime: (value) => {
            time = value;
        },
        tick: () => poll(),
        cancelled: () => cancelled,
    };
}

test("the external producer stays off until enabled and never publishes future or rewritten headers", () => {
    const f = fixture();
    const original = structuredClone(f.ledger.blockAt("B", 107));
    assert.equal(f.progress.evidence().started, false);
    f.progress.start();
    assert.equal(f.views.default.head, 107);
    const next = f.ledger.blockAt("B", 108);
    f.setTime(next.timestamp * 1000 - 1);
    f.tick();
    assert.equal(f.views.default.head, 107);
    f.setTime(next.timestamp * 1000);
    f.tick();
    assert.equal(f.views.default.head, 108);
    assert.deepEqual(f.ledger.blockAt("B", 107), original);
    assert.equal(f.events.at(-1).type, HEAD_PROGRESS_EVENT.Advance);
    assert.ok(f.events.at(-1).timestamp <= f.events.at(-1).publishedAt);
});
test("a stable final cut cancels further publication before exact assertions", () => {
    const f = fixture();
    f.progress.start();
    f.setTime(f.ledger.blockAt("B", 109).timestamp * 1000);
    f.tick();
    const cut = f.progress.stop();
    f.setTime(f.ledger.blockAt("B", 110).timestamp * 1000);
    f.tick();
    assert.equal(cut.head, 109);
    assert.equal(f.views.default.head, cut.head);
    assert.equal(f.cancelled(), true);
    assert.equal(f.events.at(-1).type, HEAD_PROGRESS_EVENT.Cut);
    assert.deepEqual(f.progress.stop(), cut);
});
test("exhausting declared history or diverging providers remains an explicit fixture failure", () => {
    const exhausted = fixture(109);
    exhausted.progress.start();
    exhausted.setTime(exhausted.ledger.blockAt("B", 110).timestamp * 1000);
    exhausted.tick();
    exhausted.tick();
    assert.throws(() => exhausted.progress.assertHealthy(), {
        property: HEAD_PROGRESS_PROPERTY.Exhausted,
    });
    const divergent = fixture();
    divergent.views.a.branch = "A";
    assert.throws(() => divergent.progress.start(), {
        property: HEAD_PROGRESS_PROPERTY.Contract,
    });
});

test("progression requires a bounded declared quiet branch and cannot alter provider-fault or refusal journeys", () => {
    const scenario = {
        ...baseline,
        headProgress: { maximumHead: 140 },
        world: {
            tailBlockIntervalSeconds: 12,
            providers: {
                default: { branch: "B", head: 103 },
                a: { branch: "B", head: 103 },
                b: { branch: "B", head: 103 },
            },
        },
    };
    assert.deepEqual(validateScenario(scenario), scenario);
    assert.throws(
        () => validateScenario({ ...scenario, world: undefined }),
        /quiet branch B/,
    );
    assert.throws(
        () =>
            validateScenario({
                ...scenario,
                headProgress: { maximumHead: Infinity },
            }),
        /explicit bounded/,
    );
    for (const journey of [
        DATA_PLANE_JOURNEY.ProviderDisagreement,
        DATA_PLANE_JOURNEY.RefusedProof,
    ])
        assert.throws(
            () =>
                validateScenario({
                    ...scenario,
                    journey,
                    expectedChecks: SCENARIO_CHECKS[journey],
                }),
            /supported fair-recovery journey/,
        );
});
