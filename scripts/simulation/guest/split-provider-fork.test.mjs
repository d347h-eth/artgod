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
    executeSplitProviderFork,
    completedSplitHeaderObservations,
    SPLIT_PROVIDER_PHASE as PHASE,
    SPLIT_PROVIDER_EVENT as EVENT,
    SPLIT_PROVIDER_PROPERTY as PROPERTY,
} from "./split-provider-fork.mjs";

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
        assertAlive() {},
        observe: () => ({ provisionalState: "observed, not prescribed" }),
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
        f.context.observe = () => {
            assert.deepEqual(f.world.providerView("a"), {
                branch: "B",
                head: 107,
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
                revision: 0,
                provisionalState: "no equality asserted during conflict",
            };
        };
        const result = await executeSplitProviderFork(config, f.context);
        assert.deepEqual(result.reached, {
            heldA105Validation: true,
            completedDivergentHeaders: true,
            explicitlyHealed: true,
        });
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
                head: 107,
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
        f.world.setProviderView("a", { branch: "B", head: 107 });
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
        f.world.setProviderView("a", { branch: "B", head: 107 });
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
