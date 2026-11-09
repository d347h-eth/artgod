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
    publishedBusinessWorkDrained,
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
test("business drain freezes a continuously lagging tip before final acquisition and mature checks", () => {
    const f = fixture();
    const work = {
        pendingDemand: [],
        pendingOutbox: [],
        unfinishedMaker: [],
        recovery: [],
    };
    const consumer = { head: 106, unchecked: [] };
    const consume = () => {
        const head = f.views.default.head;
        // This bounded lag is a legal async consumer. It catches the fixed tip
        // only after publication stops; no production timer is mocked here.
        consumer.head = f.progress.evidence().active ? head - 1 : head;
        consumer.unchecked = [consumer.head - 2];
    };
    f.progress.start();
    for (const number of [108, 109]) {
        f.setTime(f.ledger.blockAt("B", number).timestamp * 1000);
        f.tick();
        consume();
        assert.equal(consumer.head, f.views.default.head - 1);
    }
    for (const key of Object.keys(work)) {
        const pending = { ...work, [key]: [{}] };
        assert.equal(publishedBusinessWorkDrained(pending, 0), false);
    }
    assert.equal(publishedBusinessWorkDrained(work, 1), false);
    assert.equal(publishedBusinessWorkDrained(work, 0), true);
    const cut = f.progress.stop();
    assert.equal(cut.head, 109);
    assert.equal(consumer.head, 108);
    assert.ok(consumer.unchecked.some((height) => height <= cut.head - 2));
    f.setTime(f.ledger.blockAt("B", 110).timestamp * 1000);
    f.tick();
    consume();
    assert.equal(f.views.default.head, cut.head);
    assert.equal(consumer.head, cut.head);
    // Stopping publication does not complete retained checks on its own.
    assert.deepEqual(consumer.unchecked, [107]);
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

test("an active producer rejects a coherent head rewind or branch replacement instead of hiding it", () => {
    for (const next of [
        { branch: "B", head: 106 },
        { branch: "A", head: 107 },
    ]) {
        const f = fixture();
        f.progress.start();
        assert.equal(f.events[0].type, HEAD_PROGRESS_EVENT.Start);
        for (const view of Object.values(f.views)) Object.assign(view, next);
        f.tick();
        assert.throws(() => f.progress.assertHealthy(), {
            property: HEAD_PROGRESS_PROPERTY.Contract,
        });
        assert.equal(f.cancelled(), true);
    }
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
