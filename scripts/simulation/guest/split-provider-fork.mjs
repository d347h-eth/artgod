import assert from "node:assert/strict";
import {
    canonicalCheckUpperBound,
    needsDelayedCanonicalCheck,
} from "../../../indexer/src/domain/canonical-check.ts";

export const SPLIT_PROVIDER_PHASE = Object.freeze({
    Split: "fork-provider-split",
    Healed: "fork-providers-healed",
});
export const SPLIT_PROVIDER_EVENT = Object.freeze({
    Split: "fork-provider-split-exposed",
    Observed: "fork-provider-split-observed",
    Healed: "fork-providers-explicitly-healed",
    RecoveryInputs: "fork-provider-recovery-inputs-published",
});
export const SPLIT_PROVIDER_PROPERTY = Object.freeze({
    Prelude: "split-provider-held-a105-validation",
    Window: "split-provider-supported-recovery-window",
    Observations: "split-provider-completed-divergent-headers",
    Healing: "split-provider-explicit-b106-healing",
    RecoveryInputs: "split-provider-fair-recovery-inputs",
});
export const SPLIT_RECOVERY_PREMISE = Object.freeze({
    DelayedCheck: "retained-a105-check",
    EarlyResync: "earlier-supported-resync",
    EarlyComplete: "earlier-supported-resync-complete",
});
const RETAINED = Object.freeze({ branch: "A", head: 105 });
const CANONICAL = Object.freeze({ branch: "B", head: 106 });
const RECOVERY = Object.freeze({ branch: "B", head: 107 });

function supportedWindow(ledger, reorgDepth) {
    const policy = { observedHeadBlock: CANONICAL.head, reorgDepth };
    assert.ok(
        needsDelayedCanonicalCheck(RETAINED.head, policy) &&
            !needsDelayedCanonicalCheck(RETAINED.head, {
                ...policy,
                observedHeadBlock: RECOVERY.head,
            }),
        "The split must keep A105 ineligible until explicit coherent healing advances its head",
    );
    // findCommonAncestor bounds its proof by the checked height, not the latest
    // RPC head. This fixture must contain a real retained common ancestor inside
    // that window, and rollback must stay above the collection's bootstrap anchor.
    assert.ok(
        ledger.forkBlock < RETAINED.head &&
            ledger.forkBlock >= RETAINED.head - reorgDepth &&
            ledger.forkBlock >= ledger.anchorBlock,
        "The declared common ancestor must support bounded recovery above the anchor; deeper forks require a refusal journey",
    );
    const ancestor = ledger.blockAt(RETAINED.branch, ledger.forkBlock);
    assert.deepEqual(
        ancestor,
        ledger.blockAt(CANONICAL.branch, ledger.forkBlock),
    );
    return {
        reorgDepth,
        checkedBlock: RETAINED.head,
        splitHead: CANONICAL.head,
        eligibilityHead: RECOVERY.head,
        splitCheckUpperBound: canonicalCheckUpperBound(
            CANONICAL.head,
            reorgDepth,
        ),
        recoveryCheckUpperBound: canonicalCheckUpperBound(
            RECOVERY.head,
            reorgDepth,
        ),
        ancestor: {
            number: ancestor.number,
            hash: ancestor.hash,
            parentHash: ancestor.parentHash,
        },
        anchorBlock: ledger.anchorBlock,
    };
}

function healingPremise(initial, current, ledger, window, resyncPhase) {
    assert.ok(Number.isSafeInteger(initial.revision) && initial.revision >= 0);
    assert.ok(
        Number.isSafeInteger(current.revision) &&
            current.revision >= initial.revision,
        "The chain revision cannot regress across the split observations",
    );
    const ancestor = current.headers.find(
        (row) => row.block_number === window.ancestor.number,
    );
    assert.ok(
        ancestor?.block_hash === window.ancestor.hash &&
            ancestor.parent_hash === window.ancestor.parentHash,
        "The common-ancestor premise must still be retained before healing",
    );
    const pendingCheck = current.canonicalChecks.find(
        (row) =>
            row.block_number === RETAINED.head &&
            row.block_hash ===
                ledger.blockAt(RETAINED.branch, RETAINED.head).hash,
    );
    if (pendingCheck)
        return {
            kind: SPLIT_RECOVERY_PREMISE.DelayedCheck,
            revision: current.revision,
            pendingCheck,
            recovery: current.recovery,
        };
    // A104 can legally trigger rollback at split head106. Do not require the
    // old A105 row after that atomic deletion: retain actual revision/debt
    // evidence, without asserting provisional orders or owners during the split.
    assert.ok(
        Number.isSafeInteger(current.revision) &&
            current.revision > initial.revision,
        "A missing A105 check needs an actual earlier supported rollback; head advancement alone cannot restore it",
    );
    const recovery = current.recovery.find(
        (row) =>
            row.phase === resyncPhase &&
            row.revision === current.revision &&
            row.checked_block > ledger.forkBlock &&
            row.checked_block <= RETAINED.head &&
            row.stored_hash ===
                ledger.blockAt(RETAINED.branch, row.checked_block).hash &&
            row.observed_hash ===
                ledger.blockAt(CANONICAL.branch, row.checked_block).hash &&
            row.from_block > ledger.forkBlock &&
            row.from_block <= row.to_block &&
            row.to_block <= row.target_block &&
            row.target_block <= CANONICAL.head,
    );
    if (recovery)
        return {
            kind: SPLIT_RECOVERY_PREMISE.EarlyResync,
            revision: current.revision,
            recovery,
        };
    // The retained resync row may already have cleared. Require actual winning
    // headers and coverage through the original orphan tip before accepting that
    // completed path; a revision increment alone is not a recovery witness.
    assert.equal(
        current.recovery.length,
        0,
        "An unmatched retained recovery cannot establish the supported early path",
    );
    for (let number = ledger.forkBlock + 1; number <= RETAINED.head; number++) {
        const expected = ledger.blockAt(CANONICAL.branch, number);
        assert.ok(
            current.headers.some(
                (row) =>
                    row.block_number === number &&
                    row.block_hash === expected.hash &&
                    row.parent_hash === expected.parentHash,
            ) && current.coverage.some((row) => row.block_number === number),
            "Cleared early recovery requires actual canonical headers and collection coverage",
        );
    }
    assert.ok(
        current.headers
            .filter((row) => row.block_number > ledger.forkBlock)
            .every(
                (row) =>
                    row.block_number <= CANONICAL.head &&
                    row.block_hash ===
                        ledger.blockAt(CANONICAL.branch, row.block_number)
                            .hash &&
                    row.parent_hash ===
                        ledger.blockAt(CANONICAL.branch, row.block_number)
                            .parentHash,
            ),
        "Cleared early recovery cannot retain mixed post-fork header ancestry",
    );
    return {
        kind: SPLIT_RECOVERY_PREMISE.EarlyComplete,
        revision: current.revision,
        headers: current.headers,
        coverage: current.coverage,
    };
}

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
 * stay inside the actual production workers. Business projections may remain
 * provisional while views conflict; healing precedes the E/V/R/S schedule.
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
        reorgDepth,
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
        version: 2,
        config: structuredClone(config),
        reached: {},
    };
    let property = SPLIT_PROVIDER_PROPERTY.Prelude;
    try {
        // Schema/CI planning imports this module without TypeScript loaders.
        // Recovery behavior is loaded only for the actual runtime journey.
        const { REORG_RECOVERY_PHASE } =
            await import("../../../indexer/src/domain/reorg-recovery.ts");
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
        property = SPLIT_PROVIDER_PROPERTY.Window;
        evidence.window = supportedWindow(ledger, reorgDepth);
        const initial = await observe();
        const stored = initial.headers.find(
            (row) => row.block_number === ledger.forkBlock,
        );
        assert.ok(
            stored?.block_hash === evidence.window.ancestor.hash &&
                stored.parent_hash === evidence.window.ancestor.parentHash,
            "Supported recovery requires the actual retained common-ancestor header",
        );
        assert.ok(
            initial.canonicalChecks.some(
                (row) =>
                    row.block_number === RETAINED.head &&
                    row.block_hash ===
                        ledger.blockAt(RETAINED.branch, RETAINED.head).hash,
            ),
            "A105 must retain its actual delayed check before exposing conflicting providers",
        );
        evidence.initialState = initial;
        evidence.reached.supportedWindow = true;
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
        property = SPLIT_PROVIDER_PROPERTY.Window;
        evidence.healingPremise = healingPremise(
            evidence.initialState,
            evidence.splitState,
            ledger,
            evidence.window,
            REORG_RECOVERY_PHASE.Resync,
        );
        evidence.reached.recoveryDependencyRetained = true;
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

/**
 * Supply the head that matures the retained check and start honest tail growth
 * before the coordinator waits for rollback. Starting the producer is external
 * input evidence only; the existing rollback and final canonical oracles still
 * have to succeed. Ordinary campaign action acknowledgement is unchanged.
 */
export function beginSplitProviderRecovery({
    world,
    ledger,
    reorgDepth,
    headProgress,
    now = Date.now,
}) {
    try {
        const window = supportedWindow(ledger, reorgDepth);
        assert.ok(
            headProgress,
            "Weighted fork recovery requires bounded head progress",
        );
        assert.equal(
            headProgress.evidence().started,
            false,
            "Recovery inputs must be published before waiting for the desired rollback",
        );
        const providers = Object.keys(world.snapshot().providers);
        for (const provider of providers)
            assert.deepEqual(
                world.providerView(provider),
                CANONICAL,
                "All endpoints must be explicitly healed before publishing recovery inputs",
            );
        world.switchBranch(RECOVERY.branch, { head: RECOVERY.head });
        headProgress.start();
        headProgress.assertHealthy();
        const currentView = world.providerView(providers[0]);
        const block = ledger.blockAt(currentView.branch, currentView.head);
        const publishedAt = Math.floor(now() / 1000);
        const event = {
            type: SPLIT_PROVIDER_EVENT.RecoveryInputs,
            window,
            providers,
            publishedView: RECOVERY,
            currentView,
            head: {
                hash: block.hash,
                timestamp: block.timestamp,
                publishedAt,
                ageSeconds: publishedAt - block.timestamp,
            },
            producer: headProgress.evidence(),
        };
        world.recordExternal(event);
        return event;
    } catch (error) {
        error.property ??= SPLIT_PROVIDER_PROPERTY.RecoveryInputs;
        throw error;
    }
}
