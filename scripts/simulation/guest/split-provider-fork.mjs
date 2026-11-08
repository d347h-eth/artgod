import assert from "node:assert/strict";

export const SPLIT_PROVIDER_PHASE = Object.freeze({
    Split: "fork-provider-split",
    Healed: "fork-providers-healed",
});
export const SPLIT_PROVIDER_EVENT = Object.freeze({
    Split: "fork-provider-split-exposed",
    Observed: "fork-provider-split-observed",
    Healed: "fork-providers-explicitly-healed",
});
export const SPLIT_PROVIDER_PROPERTY = Object.freeze({
    Prelude: "split-provider-held-a105-validation",
    Observations: "split-provider-completed-divergent-headers",
    Healing: "split-provider-explicit-b107-healing",
});
const RETAINED = Object.freeze({ branch: "A", head: 105 });
const CANONICAL = Object.freeze({ branch: "B", head: 107 });

/** The fixed fork prologue selects two actual configured weighted RPC identities. */
export function validateSplitProviderSelection(value, rpcProviders) {
    assert.ok(
        value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.keys(value).sort().join(",") ===
                "canonicalProvider,retainedProvider",
        "Split-provider fork requires exactly canonicalProvider and retainedProvider",
    );
    const selected = [value.canonicalProvider, value.retainedProvider];
    assert.ok(
        Array.isArray(rpcProviders) &&
            new Set(selected).size === 2 &&
            selected.every(
                (provider) =>
                    typeof provider === "string" &&
                    rpcProviders.includes(provider),
            ),
        "Split-provider fork requires two distinct configured RPC identities",
    );
}

/** Ignore old, shared-prefix, failed and incomplete reads when earning this cut. */
export function completedSplitHeaderObservations(
    trace,
    { afterSequence, config, ledger },
) {
    const find = (provider, view) => {
        for (const request of trace) {
            if (
                request.type !== "request" ||
                request.sequence <= afterSequence ||
                request.phase !== SPLIT_PROVIDER_PHASE.Split ||
                request.provider !== provider ||
                request.method !== "eth_getBlockByNumber"
            )
                continue;
            const read = trace.find(
                (entry) =>
                    entry.type === "read" &&
                    entry.requestIndex === request.requestIndex &&
                    entry.provider === provider &&
                    entry.sequence > request.sequence,
            );
            const completion = trace.find(
                (entry) =>
                    entry.type === "response" &&
                    entry.requestIndex === request.requestIndex &&
                    entry.provider === provider &&
                    entry.sequence > (read?.sequence ?? Infinity),
            );
            if (
                !read ||
                !completion ||
                read.phase !== SPLIT_PROVIDER_PHASE.Split ||
                completion.phase !== SPLIT_PROVIDER_PHASE.Split ||
                read.view.branch !== view.branch ||
                read.view.head !== view.head ||
                completion.view.branch !== view.branch ||
                completion.view.head !== view.head ||
                !Number.isSafeInteger(read.blockNumber) ||
                read.blockNumber <= ledger.forkBlock ||
                read.blockNumber > view.head ||
                read.blockHash !==
                    ledger.blockAt(view.branch, read.blockNumber).hash
            )
                continue;
            return { request, read, completion };
        }
        return undefined;
    };
    const canonical = find(config.canonicalProvider, CANONICAL);
    const retained = find(config.retainedProvider, RETAINED);
    return canonical && retained ? { canonical, retained } : undefined;
}

/**
 * External-only fixed prologue. Runtime routing, admission, retries and rollback
 * stay inside the actual production workers. No expected database state is
 * imposed while views conflict; healing precedes the ordinary E/V/R/S schedule.
 */
export async function executeSplitProviderFork(config, context) {
    const {
        world,
        ledger,
        rpcProviders,
        barrierName,
        observe,
        eventually,
        assertAlive,
        timeoutMs = 120_000,
    } = context;
    validateSplitProviderSelection(config, rpcProviders);
    for (const callback of [observe, eventually, assertAlive])
        assert.equal(typeof callback, "function");
    assert.ok(typeof barrierName === "string" && barrierName.length > 0);
    assert.ok(
        Number.isSafeInteger(timeoutMs) &&
            timeoutMs > 0 &&
            timeoutMs <= 600_000,
    );
    const evidence = {
        version: 1,
        config: structuredClone(config),
        reached: {},
    };
    let property = SPLIT_PROVIDER_PROPERTY.Prelude;
    try {
        assertAlive();
        const barrier = world
            .snapshot()
            .barriers.find((entry) => entry.name === barrierName);
        assert.ok(
            barrier?.pending > 0 && barrier.released === false,
            "Split-provider fork requires an actually held validation response",
        );
        const held = world.trace.find(
            (entry) =>
                entry.type === "barrier-reached" &&
                entry.name === barrierName &&
                world.trace.some(
                    (read) =>
                        read.type === "read" &&
                        read.requestIndex === entry.requestIndex &&
                        read.view.branch === RETAINED.branch &&
                        read.blockNumber === RETAINED.head &&
                        (read.functionName === "getOrderStatus" ||
                            read.aggregateCalls?.some(
                                (call) =>
                                    call.functionName === "getOrderStatus" &&
                                    call.success === true,
                            )),
                ),
        );
        assert.ok(
            held,
            "The held response must contain a real A105 order-status read",
        );
        for (const provider of [
            config.canonicalProvider,
            config.retainedProvider,
        ])
            assert.deepEqual(
                world.providerView(provider),
                RETAINED,
                "Selected endpoints must reach coherent A105 before exposing the split",
            );
        evidence.heldValidation = structuredClone(held);
        evidence.reached.heldA105Validation = true;
        property = SPLIT_PROVIDER_PROPERTY.Observations;
        world.setPhase(SPLIT_PROVIDER_PHASE.Split);
        world.setProviderView(config.canonicalProvider, CANONICAL);
        world.recordExternal({
            type: SPLIT_PROVIDER_EVENT.Split,
            config,
            canonical: CANONICAL,
            retained: RETAINED,
        });
        const afterSequence = world.trace.at(-1).sequence;
        evidence.splitSequence = afterSequence;
        let observations;
        await eventually(
            () => {
                assertAlive();
                observations = completedSplitHeaderObservations(world.trace, {
                    afterSequence,
                    config,
                    ledger,
                });
                return !!observations;
            },
            "actual weighted RPC requests complete against both divergent post-prefix provider views",
            timeoutMs,
        );
        evidence.observations = structuredClone(observations);
        evidence.splitState = await observe();
        evidence.providersWhileSplit = structuredClone(
            world.snapshot().providers,
        );
        evidence.reached.completedDivergentHeaders = true;
        world.recordExternal({
            type: SPLIT_PROVIDER_EVENT.Observed,
            requestIndexes: Object.fromEntries(
                Object.entries(observations).map(([name, value]) => [
                    name,
                    value.request.requestIndex,
                ]),
            ),
        });
        property = SPLIT_PROVIDER_PROPERTY.Healing;
        const providers = Object.keys(world.snapshot().providers);
        for (const provider of providers)
            world.setProviderView(provider, CANONICAL);
        world.setPhase(SPLIT_PROVIDER_PHASE.Healed);
        world.recordExternal({
            type: SPLIT_PROVIDER_EVENT.Healed,
            providers,
            view: CANONICAL,
        });
        evidence.healing = structuredClone(world.trace.at(-1));
        evidence.reached.explicitlyHealed = true;
        return evidence;
    } catch (error) {
        error.property ??= property;
        error.simulation = {
            ...(error.simulation ?? {}),
            splitProviderFork: evidence,
        };
        throw error;
    }
}
