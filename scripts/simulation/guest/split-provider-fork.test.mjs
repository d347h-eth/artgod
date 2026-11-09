import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData } from "viem";
import { createSimulationWorld } from "../world/world.mjs";
import { CONTRACT_ABI, wireQuantity } from "../world/wire.mjs";
import fork from "../scenarios/fork.json" with { type: "json" };
import {
    validateScenario,
    RUNTIME_PROFILE,
    VALIDATION_RELEASE,
    DATA_PLANE_JOURNEY,
    SCENARIO_CHECKS,
    EXTERNAL_ACTION,
} from "./scenario-contract.mjs";
import {
    beginSplitProviderRecovery,
    executeSplitProviderFork,
    completedSplitHeaderObservations,
    SPLIT_PROVIDER_PHASE as PHASE,
    SPLIT_PROVIDER_EVENT as EVENT,
    SPLIT_PROVIDER_PROPERTY as PROPERTY,
    SPLIT_RECOVERY_PREMISE as PREMISE,
} from "./split-provider-fork.mjs";
import { REORG_RECOVERY_PHASE } from "../../../indexer/src/domain/reorg-recovery.ts";
import { createHeadProgress, HEAD_PROGRESS_EVENT } from "./head-progress.mjs";
import { canonicalCheckUpperBound } from "../../../indexer/src/domain/canonical-check.ts";

const BARRIER = "unit-held-validation";
const HEADER_BARRIER = "unit-held-header";
const config = { canonicalProvider: "a", retainedProvider: "b" };
const header = (world, provider, number = 105) =>
    world.handleRpc(provider, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: [wireQuantity(number), false],
    });

// Only guard tests: actual production selection/budget/recovery needs the VM.
async function fixture({ statusBlock = 105, scripts = [] } = {}) {
    const world = createSimulationWorld({
        epochSeconds: 1_000_000,
        providers: Object.fromEntries(
            ["default", "a", "b"].map((id) => [id, { branch: "A", head: 105 }]),
        ),
        scripts: [
            {
                when: { method: "eth_call", functionName: "getOrderStatus" },
                after: { barrier: BARRIER },
            },
            ...scripts,
        ],
    });
    const pending = world.handleRpc("a", {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
            {
                to: world.ledger.addresses.seaport,
                data: encodeFunctionData({
                    abi: CONTRACT_ABI,
                    functionName: "getOrderStatus",
                    args: [world.ledger.orders.bid.orderHash],
                }),
            },
            wireQuantity(statusBlock),
        ],
    });
    await world.waitForBarrier(BARRIER);
    const context = {
        world,
        ledger: world.ledger,
        rpcProviders: ["a", "b"],
        barrierName: BARRIER,
        reorgDepth: 3,
        assertAlive() {},
        observe: () => ({
            revision: 0,
            headers: [
                {
                    block_number: world.ledger.forkBlock,
                    block_hash: world.ledger.blockAt(
                        "A",
                        world.ledger.forkBlock,
                    ).hash,
                    parent_hash: world.ledger.blockAt(
                        "A",
                        world.ledger.forkBlock,
                    ).parentHash,
                },
            ],
            canonicalChecks: [
                {
                    block_number: 105,
                    block_hash: world.ledger.blockAt("A", 105).hash,
                },
            ],
            recovery: [],
            coverage: [101, 102, 103, 104, 105].map((block_number) => ({
                block_number,
            })),
        }),
        async eventually(predicate, label) {
            await header(world, "a");
            await header(world, "b");
            assert.equal(await predicate(), true, label);
        },
    };
    return {
        world,
        context,
        async close() {
            world.release(BARRIER);
            world.release(HEADER_BARRIER);
            await pending;
            world.close();
        },
    };
}

test("the fixed fork prologue requires distinct selected endpoints and actual default budgets", () => {
    const scenario = {
        ...fork,
        runtimeProfile: RUNTIME_PROFILE.Default,
        rpcProviders: ["a", "b"],
        splitProviderFork: config,
        headProgress: { maximumHead: 140 },
        world: {
            ...fork.world,
            providers: {
                a: { branch: "A", head: 103 },
                b: { branch: "A", head: 103 },
            },
        },
    };
    assert.deepEqual(validateScenario(scenario), scenario);
    for (const altered of [
        {
            ...scenario,
            splitProviderFork: {
                canonicalProvider: "a",
                retainedProvider: "a",
            },
        },
        {
            ...scenario,
            splitProviderFork: {
                canonicalProvider: "a",
                retainedProvider: "c",
            },
        },
        { ...scenario, splitProviderFork: { ...config, hidden: true } },
        { ...scenario, runtimeProfile: RUNTIME_PROFILE.Unrestricted },
        { ...scenario, headProgress: undefined },
        {
            ...scenario,
            journey: DATA_PLANE_JOURNEY.Baseline,
            expectedChecks: SCENARIO_CHECKS[DATA_PLANE_JOURNEY.Baseline],
        },
        {
            ...scenario,
            world: {
                ...scenario.world,
                providers: { a: scenario.world.providers.a },
            },
        },
        {
            ...scenario,
            validationRelease: VALIDATION_RELEASE.BeforeRollback,
            schedule: [
                EXTERNAL_ACTION.ReleaseValidation,
                EXTERNAL_ACTION.CanonicalSwitch,
                EXTERNAL_ACTION.RestoreInventory,
                EXTERNAL_ACTION.StreamListing,
            ],
        },
    ])
        assert.throws(
            () => validateScenario(altered),
            /Split-provider|split-provider/,
        );
});

test("only one provider changes before real completed divergent reads, then explicit healing precedes core actions", async () => {
    const f = await fixture();
    try {
        const initial = f.context.observe;
        f.context.observe = () => {
            if (f.world.snapshot().phase !== PHASE.Split) return initial();
            assert.deepEqual(f.world.providerView("a"), {
                branch: "B",
                head: 106,
            });
            assert.deepEqual(f.world.providerView("b"), {
                branch: "A",
                head: 105,
            });
            assert.deepEqual(f.world.providerView("default"), {
                branch: "A",
                head: 105,
            });
            return {
                ...initial(),
                revision: 0,
                provisionalState: "no equality asserted during conflict",
            };
        };
        const result = await executeSplitProviderFork(config, f.context);
        assert.deepEqual(result.reached, {
            heldA105Validation: true,
            supportedWindow: true,
            completedDivergentHeaders: true,
            recoveryDependencyRetained: true,
            explicitlyHealed: true,
        });
        assert.equal(result.healingPremise.kind, PREMISE.DelayedCheck);
        assert.equal(result.splitState.revision, 0);
        assert.equal(
            result.observations.canonical.read.blockHash,
            f.world.ledger.blockAt("B", 105).hash,
        );
        assert.equal(
            result.observations.retained.read.blockHash,
            f.world.ledger.blockAt("A", 105).hash,
        );
        for (const provider of ["default", "a", "b"])
            assert.deepEqual(f.world.providerView(provider), {
                branch: "B",
                head: 106,
            });
        assert.deepEqual(
            f.world.trace
                .filter((entry) => Object.values(EVENT).includes(entry.type))
                .map((entry) => entry.type),
            [EVENT.Split, EVENT.Observed, EVENT.Healed],
        );
        assert.equal(
            f.world.trace.some((entry) => entry.type === "scenario-action"),
            false,
        );
        assert.equal(
            f.world.snapshot().barriers.find((entry) => entry.name === BARRIER)
                .released,
            false,
        );
    } finally {
        await f.close();
    }
});

test("an old A104 status reply cannot claim the held A105 validation cut", async () => {
    const f = await fixture({ statusBlock: 104 });
    try {
        await assert.rejects(executeSplitProviderFork(config, f.context), {
            property: PROPERTY.Prelude,
        });
        assert.deepEqual(f.world.providerView("a"), { branch: "A", head: 105 });
    } finally {
        await f.close();
    }
});

test("a released old validation response cannot claim concurrent held work", async () => {
    const f = await fixture();
    try {
        f.world.release(BARRIER);
        await assert.rejects(executeSplitProviderFork(config, f.context), {
            property: PROPERTY.Prelude,
        });
        assert.deepEqual(f.world.providerView("a"), { branch: "A", head: 105 });
    } finally {
        await f.close();
    }
});

test("completed shared-prefix headers do not establish a divergent provider observation", async () => {
    const f = await fixture();
    try {
        f.context.eventually = async (predicate) => {
            await header(f.world, "a", 103);
            await header(f.world, "b", 103);
            assert.equal(predicate(), false);
            throw new Error("Required divergent observations were unreached");
        };
        await assert.rejects(executeSplitProviderFork(config, f.context), {
            property: PROPERTY.Observations,
        });
        assert.deepEqual(f.world.providerView("b"), { branch: "A", head: 105 });
        assert.equal(
            f.world.trace.some((entry) => entry.type === EVENT.Healed),
            false,
        );
    } finally {
        await f.close();
    }
});

test("old completed observations cannot satisfy a later split's coverage", async () => {
    const f = await fixture();
    try {
        f.world.setPhase(PHASE.Split);
        f.world.setProviderView("a", { branch: "B", head: 106 });
        await header(f.world, "a");
        await header(f.world, "b");
        const afterSequence = f.world.trace.at(-1).sequence;
        assert.equal(
            completedSplitHeaderObservations(f.world.trace, {
                afterSequence,
                config,
                ledger: f.world.ledger,
            }),
            undefined,
        );
        await header(f.world, "a");
        assert.equal(
            completedSplitHeaderObservations(f.world.trace, {
                afterSequence,
                config,
                ledger: f.world.ledger,
            }),
            undefined,
        );
        await header(f.world, "b");
        assert.ok(
            completedSplitHeaderObservations(f.world.trace, {
                afterSequence,
                config,
                ledger: f.world.ledger,
            }),
        );
    } finally {
        await f.close();
    }
});

test("a read whose response is still held cannot satisfy completion coverage", async () => {
    const f = await fixture({
        scripts: [
            {
                when: {
                    phase: PHASE.Split,
                    provider: "b",
                    method: "eth_getBlockByNumber",
                },
                after: { barrier: HEADER_BARRIER },
            },
        ],
    });
    let pending;
    try {
        f.world.setPhase(PHASE.Split);
        f.world.setProviderView("a", { branch: "B", head: 106 });
        const afterSequence = f.world.trace.at(-1).sequence;
        await header(f.world, "a");
        pending = header(f.world, "b");
        await f.world.waitForBarrier(HEADER_BARRIER);
        assert.equal(
            completedSplitHeaderObservations(f.world.trace, {
                afterSequence,
                config,
                ledger: f.world.ledger,
            }),
            undefined,
        );
        f.world.release(HEADER_BARRIER);
        await pending;
        assert.ok(
            completedSplitHeaderObservations(f.world.trace, {
                afterSequence,
                config,
                ledger: f.world.ledger,
            }),
        );
    } finally {
        await f.close();
        if (pending) await pending;
    }
});

test("the supported cut requires an actual pending check and retained ancestor inside the runtime window", async () => {
    for (const alter of [
        (f) => {
            f.context.reorgDepth = 2;
        },
        (f) => {
            f.context.reorgDepth = 4;
        },
        (f) => {
            const observe = f.context.observe;
            f.context.observe = () => ({ ...observe(), canonicalChecks: [] });
        },
        (f) => {
            const observe = f.context.observe;
            f.context.observe = () => ({ ...observe(), headers: [] });
        },
        (f) => {
            f.context.ledger = { ...f.world.ledger, forkBlock: 101 };
        },
        (f) => {
            f.context.ledger = { ...f.world.ledger, anchorBlock: 104 };
        },
    ]) {
        const f = await fixture();
        try {
            alter(f);
            await assert.rejects(executeSplitProviderFork(config, f.context), {
                property: PROPERTY.Window,
            });
            assert.deepEqual(f.world.providerView("a"), {
                branch: "A",
                head: 105,
            });
            assert.equal(
                f.world.trace.some((entry) => entry.type === EVENT.Split),
                false,
            );
        } finally {
            await f.close();
        }
    }
});

test("the old B107 split could consume A105 before healing; the revised split preserves its one check", async () => {
    const f = await fixture();
    try {
        const oldCheckEligible = 105 <= canonicalCheckUpperBound(107, 3);
        assert.equal(oldCheckEligible, true);
        // A response from the retained A provider could complete that one check.
        // Later head growth alone does not manufacture another pending row.
        const oldPending = oldCheckEligible ? [] : [105];
        assert.deepEqual(
            oldPending.filter((n) => n <= canonicalCheckUpperBound(110, 3)),
            [],
        );
        const split = await executeSplitProviderFork(config, f.context);
        assert.equal(105 > split.window.splitCheckUpperBound, true);
        assert.equal(105 <= split.window.recoveryCheckUpperBound, true);
        assert.equal(split.initialState.canonicalChecks[0].block_number, 105);
        assert.notEqual(
            f.world.ledger.blockAt("A", 105).hash,
            f.world.ledger.blockAt("B", 105).hash,
        );
        assert.equal(split.reached.explicitlyHealed, true);
        assert.equal("recovered" in split.reached, false);
    } finally {
        await f.close();
    }
});

test("healing publishes eligibility and starts the immutable producer before any rollback-dependent wait", async () => {
    const f = await fixture();
    let progress;
    try {
        await executeSplitProviderFork(config, f.context);
        const revision = f.context.observe().revision;
        let poll;
        const time = f.world.ledger.blockAt("B", 110).timestamp * 1000;
        progress = createHeadProgress({
            world: f.world,
            ledger: f.world.ledger,
            maximumHead: 140,
            providers: Object.keys(f.world.snapshot().providers),
            now: () => time,
            schedule: (callback) => {
                poll = callback;
                return { unref() {} };
            },
            cancel() {},
        });
        const original = structuredClone(f.world.ledger.blockAt("B", 105));
        const event = beginSplitProviderRecovery({
            world: f.world,
            ledger: f.world.ledger,
            reorgDepth: f.context.reorgDepth,
            headProgress: progress,
            now: () => time,
        });
        assert.equal(
            revision,
            0,
            "supplying dependencies must not await or fabricate a rollback",
        );
        assert.equal(event.producer.started, true);
        assert.equal(event.producer.active, true);
        assert.equal(event.head.ageSeconds, 0);
        assert.equal(typeof poll, "function");
        assert.equal(f.world.providerView("a").head, 110);
        assert.ok(
            105 <= canonicalCheckUpperBound(f.world.providerView("a").head, 3),
        );
        assert.deepEqual(f.world.ledger.blockAt("B", 105), original);
        const start = f.world.trace.find(
            (entry) => entry.type === HEAD_PROGRESS_EVENT.Start,
        );
        const supplied = f.world.trace.find(
            (entry) => entry.type === EVENT.RecoveryInputs,
        );
        assert.ok(start.sequence < supplied.sequence);
        assert.ok(
            f.world.trace
                .filter((entry) => entry.type === HEAD_PROGRESS_EVENT.Advance)
                .every((entry) => entry.timestamp <= entry.publishedAt),
        );
        assert.equal("committedRevision" in event, false);
        assert.throws(
            () =>
                beginSplitProviderRecovery({
                    world: f.world,
                    ledger: f.world.ledger,
                    reorgDepth: 3,
                    headProgress: progress,
                }),
            { property: PROPERTY.RecoveryInputs },
        );
        assert.equal(
            f.world.providerView("a").head,
            110,
            "a repeated action cannot reset the progressed head",
        );
    } finally {
        progress?.stop();
        await f.close();
    }
});

test("missing head progress or unhealed endpoints cannot claim fair recovery inputs", async () => {
    const f = await fixture();
    try {
        assert.throws(
            () =>
                beginSplitProviderRecovery({
                    world: f.world,
                    ledger: f.world.ledger,
                    reorgDepth: 3,
                }),
            { property: PROPERTY.RecoveryInputs },
        );
        const progress = createHeadProgress({
            world: f.world,
            ledger: f.world.ledger,
            maximumHead: 140,
            providers: Object.keys(f.world.snapshot().providers),
            now: () => f.world.ledger.blockAt("B", 110).timestamp * 1000,
            schedule() {
                throw new Error("unhealed views must not start the producer");
            },
            cancel() {},
        });
        assert.throws(
            () =>
                beginSplitProviderRecovery({
                    world: f.world,
                    ledger: f.world.ledger,
                    reorgDepth: 3,
                    headProgress: progress,
                }),
            { property: PROPERTY.RecoveryInputs },
        );
        assert.equal(progress.evidence().started, false);
        assert.deepEqual(f.world.providerView("a"), { branch: "A", head: 105 });
    } finally {
        await f.close();
    }
});

test("prematurely consumed A105 or a changed ancestor cannot earn the pre-healing recovery premise", async () => {
    for (const alter of [
        (state) => ({ ...state, canonicalChecks: [] }),
        (state) => ({
            ...state,
            canonicalChecks: [],
            revision: state.revision + 1,
        }),
        (state) => ({
            ...state,
            headers: state.headers.map((row) => ({
                ...row,
                parent_hash: "corrupt",
            })),
        }),
    ]) {
        const f = await fixture();
        try {
            const observe = f.context.observe;
            f.context.observe = () =>
                f.world.snapshot().phase === PHASE.Split
                    ? alter(observe())
                    : observe();
            await assert.rejects(
                executeSplitProviderFork(config, f.context),
                (error) => {
                    assert.equal(error.property, PROPERTY.Window);
                    const evidence = error.simulation.splitProviderFork;
                    assert.equal(
                        evidence.reached.completedDivergentHeaders,
                        true,
                    );
                    assert.equal(
                        evidence.reached.recoveryDependencyRetained,
                        undefined,
                    );
                    assert.equal(evidence.reached.explicitlyHealed, undefined);
                    return true;
                },
            );
            assert.equal(
                f.world.trace.some((entry) => entry.type === EVENT.Healed),
                false,
            );
        } finally {
            await f.close();
        }
    }
});

test("a genuine earlier supported rollback can retain resync debt while providers still conflict", async () => {
    const f = await fixture();
    try {
        const observe = f.context.observe;
        const recovery = {
            phase: REORG_RECOVERY_PHASE.Resync,
            revision: 1,
            checked_block: 104,
            stored_hash: f.world.ledger.blockAt("A", 104).hash,
            observed_hash: f.world.ledger.blockAt("B", 104).hash,
            from_block: 104,
            to_block: 106,
            target_block: 106,
        };
        f.context.observe = () => {
            const state = observe();
            return f.world.snapshot().phase === PHASE.Split
                ? {
                      ...state,
                      revision: 1,
                      canonicalChecks: [],
                      recovery: [recovery],
                      coverage: state.coverage.filter(
                          (row) => row.block_number <= 103,
                      ),
                  }
                : state;
        };
        const result = await executeSplitProviderFork(config, f.context);
        assert.equal(result.healingPremise.kind, PREMISE.EarlyResync);
        assert.equal(result.healingPremise.revision, 1);
        assert.deepEqual(result.healingPremise.recovery, recovery);
        assert.equal(result.reached.explicitlyHealed, true);
        assert.equal("owners" in result.healingPremise, false);
    } finally {
        await f.close();
    }
});

test("a cleared earlier resync needs actual canonical headers and coverage, not only an advanced revision", async () => {
    const f = await fixture();
    try {
        const observe = f.context.observe;
        f.context.observe = () => {
            const state = observe();
            if (f.world.snapshot().phase !== PHASE.Split) return state;
            return {
                ...state,
                revision: 1,
                canonicalChecks: [],
                headers: [
                    ...state.headers,
                    ...[104, 105, 106].map((number) => {
                        const block = f.world.ledger.blockAt("B", number);
                        return {
                            block_number: number,
                            block_hash: block.hash,
                            parent_hash: block.parentHash,
                        };
                    }),
                ],
                coverage: [...state.coverage, { block_number: 106 }],
            };
        };
        const result = await executeSplitProviderFork(config, f.context);
        assert.equal(result.healingPremise.kind, PREMISE.EarlyComplete);
        assert.equal(result.healingPremise.revision, 1);
        assert.equal(result.reached.explicitlyHealed, true);
    } finally {
        await f.close();
    }
});

test("an unrelated or mismatched retained recovery cannot replace a lost delayed check", async () => {
    const f = await fixture();
    try {
        const observe = f.context.observe;
        f.context.observe = () => {
            const state = observe();
            return f.world.snapshot().phase === PHASE.Split
                ? {
                      ...state,
                      revision: 1,
                      canonicalChecks: [],
                      recovery: [
                          {
                              phase: REORG_RECOVERY_PHASE.Resync,
                              revision: 1,
                              checked_block: 104,
                              stored_hash: f.world.ledger.blockAt("A", 104)
                                  .hash,
                              observed_hash: f.world.ledger.blockAt("A", 104)
                                  .hash,
                              from_block: 104,
                              to_block: 106,
                              target_block: 106,
                          },
                      ],
                  }
                : state;
        };
        await assert.rejects(executeSplitProviderFork(config, f.context), {
            property: PROPERTY.Window,
        });
    } finally {
        await f.close();
    }
});
