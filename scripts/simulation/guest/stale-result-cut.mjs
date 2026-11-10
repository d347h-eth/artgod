import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { MAKER_REVALIDATION_STATUS } from "../../../indexer/src/domain/maker-revalidation.ts";
import {
    MAKER_TRIGGER_SCOPE,
    GLOBAL_MAKER_TRIGGER_REASON,
} from "../../../indexer/src/domain/maker-triggers.ts";
import { ORDER_VALIDATION_BATCH_POLICY } from "../../../indexer/src/domain/order-validation-policy.ts";
import { ORDER_SEAPORT_DATA_SOURCE_KIND } from "../../../indexer/src/domain/orders.ts";
import { OFFCHAIN_OBSERVATION_CHANNEL } from "../../../indexer/src/domain/offchain-jobs.ts";
import { REORG_RECOVERY_PHASE } from "../../../indexer/src/domain/reorg-recovery.ts";
import { OrderValidationSnapshotUnavailable } from "../../../indexer/src/domain/order-validation-failure.ts";
import {
    RESPONSE_GATE_FUNCTION,
    RESPONSE_GATE_EVENT,
} from "../world/contract.mjs";
import { decodeRpcContractCalls } from "../world/wire.mjs";
import { assertSimulationProperty as property } from "./oracle-assertions.mjs";
import { assertCanonicalAcquisition } from "./oracle.mjs";
import { findRuntimeProcessExit } from "./runtime-process.mjs";
import {
    RUNTIME_PROCESS,
    PRODUCTION_RUNTIME_PROCESSES,
} from "./runtime-manifest.mjs";

export const STALE_RESULT_GATE = Object.freeze({
    OldCounter: "stale-old-counter",
    FreshStatus: "stale-fresh-status",
});
export const STALE_RESULT_PROPERTY = Object.freeze({
    Runtime: "stale-cut-production-runtime-liveness",
    Held: "stale-cut-held-a105-counter",
    Maker: "stale-cut-captured-maker-attempt",
    RecoveryRestart: "stale-cut-recovery-worker-restart",
    Rollback: "stale-cut-post-rollback-baseline",
    FreshRequirement: "stale-cut-new-source-requirement-held",
    Rejected: "stale-cut-durable-failed-release",
    Retained: "stale-cut-retained-maker-page",
    Projection: "stale-cut-no-stale-projection-or-proof",
});
export const STALE_RESULT_CUT_UNREACHED_CODE =
    "ARTGOD_STALE_RESULT_CUT_UNREACHED";
export const isStaleResultCutUnreached = (error) =>
    error?.code === STALE_RESULT_CUT_UNREACHED_CODE;
export const isStaleResultCutRuntimeFailure = (error) =>
    !!findRuntimeProcessExit(error) ||
    error?.property === STALE_RESULT_PROPERTY.Runtime;

// Deliberate SQLite storage-wire assertion: SqliteMakerRevalidations.release
// serializes String(error). The message has one production throw site in
// application/offchain/seaport-validation-batch.ts finish(), while the error
// class/name remains owned by domain/order-validation-failure.ts. A generic
// failed release plus unrelated header traffic cannot establish this cut.
export const STALE_RESULT_FINISH_FAILURE = String(
    new OrderValidationSnapshotUnavailable(
        "Validation snapshot changed before commit",
    ),
);

const PAGE_FIELDS = [
    "after_id",
    "upper_order_id",
    "upper_rowid",
    "step",
    "resolved_orders",
    "deferred_orders",
    "pass_generation",
];
const ORDER_FIELDS = [
    "id",
    "state_revision",
    "source_status",
    "fillability_status",
    "validated_at",
];
const PROOF_FIELDS = [
    "proof_revision",
    "proof_at",
    "proof_block",
    "proof_chain_revision",
];
const pick = (row, keys) =>
    Object.fromEntries(keys.map((key) => [key, row?.[key] ?? null]));

/**
 * Observe one stale validation outcome while every new Seaport status reply is
 * withheld outside the application. This is a snapshot/work-rejection
 * test, not evidence that the later database checkpoint fence was reached.
 *
 * Caller quiesces periodic REST producers and retained source input first. The
 * real stream subscriber admits one explicitly authored first bid observation
 * after the committed rollback while resync is still active, establishing a
 * newer source-revision/demand fence before the old reply is released. Full
 * resync and final canonical/HTTP convergence remain the caller's later checks.
 */
export function createStaleResultCut({
    world,
    ledger,
    observe,
    eventually,
    assertAlive,
    admitFreshBidRequirement,
    requestTimeoutMs,
    now = Date.now,
}) {
    for (const callback of [
        observe,
        eventually,
        assertAlive,
        admitFreshBidRequirement,
        now,
    ])
        assert.equal(typeof callback, "function");
    assert.ok(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0);
    const orderId = ledger.orders.bid.orderHash;
    const evidence = {
        version: 1,
        orderId,
        reached: {},
        claim: "stale-work-rejection-with-fresh-status-replies-held",
    };
    let original;
    let baseline;
    let stage = STALE_RESULT_PROPERTY.Held;
    const gate = (name) =>
        world.snapshot().responseGates.find((entry) => entry.name === name);
    const unreached = (message, cause) =>
        Object.assign(new Error(message, { cause }), {
            code: STALE_RESULT_CUT_UNREACHED_CODE,
            property: stage,
        });
    const requireCut = (condition, message) => {
        if (!condition) throw unreached(message);
    };
    // A dead native actor is an execution failure, not evidence that the
    // requested external gate merely remained unreachable while actors ran.
    const assertRuntimeAlive = () => {
        try {
            assertAlive();
        } catch (error) {
            // Keep the lifecycle owner's typed cause/property across this cut.
            const exit = findRuntimeProcessExit(error);
            if (exit) {
                error.property ??= exit.property;
                throw error;
            }
            property(STALE_RESULT_PROPERTY.Runtime, () => {
                throw error;
            });
        }
    };
    const attach = (error) => {
        error.property ??= stage;
        error.simulation = {
            ...(error.simulation ?? {}),
            staleResultCut: {
                ...structuredClone(evidence),
                outcome:
                    isStaleResultCutUnreached(error) ||
                    isStaleResultCutRuntimeFailure(error)
                        ? "unreached"
                        : "failed",
                responseGates: world.snapshot().responseGates,
            },
        };
        return error;
    };
    const boundedWait = async (predicate, label) => {
        try {
            await eventually(
                predicate,
                label,
                ORDER_VALIDATION_BATCH_POLICY.snapshotLifetimeMs,
            );
        } catch (error) {
            if (error.property) throw error;
            assertRuntimeAlive();
            throw unreached(label, error);
        }
    };
    const findTarget = (state) => ({
        order: state.orders.find((row) => row.id === orderId),
        proof: state.validationProofs.find((row) => row.order_id === orderId),
        run: state.makerRuns.find((row) => row.run_id === original?.run_id),
    });
    const assertAttemptFresh = () => {
        const time = now();
        requireCut(
            original && time < original.lease_until,
            "The captured maker lease expired before the controlled rejection cut",
        );
        requireCut(
            original && time < original.pass_started_at + requestTimeoutMs,
            "The original RPC transport lifetime cannot be proved at this cut",
        );
        // pass_started_at precedes snapshot creation, giving a conservative
        // lifetime bound without an internal validator hook or fabricated clock.
        requireCut(
            Number.isSafeInteger(original.pass_started_at) &&
                original.pass_started_at > 0 &&
                time >= original.pass_started_at &&
                time - original.pass_started_at <
                    ORDER_VALIDATION_BATCH_POLICY.snapshotLifetimeMs,
            "The captured pass cannot prove a live validation snapshot at this cut",
        );
        requireCut(
            time / 1000 - ledger.blockAt("A", 105).timestamp <=
                ORDER_VALIDATION_BATCH_POLICY.maxBlockAgeSeconds,
            "The old immutable header aged beyond the production validation policy",
        );
    };
    const oldCounter = () => {
        const current = gate(STALE_RESULT_GATE.OldCounter);
        requireCut(
            current &&
                current.released === false &&
                current.aborted === false &&
                current.pending === 1 &&
                current.captures.length === 1,
            "Exactly one old counter reply must still be held",
        );
        const capture = current.captures[0];
        const matching = capture.matchingCalls.filter(
            (call) =>
                call.functionName === RESPONSE_GATE_FUNCTION.Counter &&
                call.target.toLowerCase() === ledger.addresses.seaport &&
                call.args?.[0]?.toLowerCase() === ledger.addresses.bidder,
        );
        requireCut(
            capture.pending &&
                !capture.delivered &&
                !capture.aborted &&
                capture.view.branch === "A" &&
                capture.blockNumber === 105 &&
                capture.blockHash === ledger.blockAt("A", 105).hash &&
                matching.length === 1 &&
                matching[0].success &&
                BigInt(matching[0].result) === 1n,
            "The held bytes must contain the bidder's real A105 counter value one",
        );
        return capture;
    };
    const assertFixedRecoveryHead = () => {
        requireCut(
            ORDER_VALIDATION_BATCH_POLICY.maxHeadAdvance === 2 &&
                Object.values(world.snapshot().providers).every(
                    (view) => view.branch === "B" && view.head === 107,
                ),
            "The controlled finish cut requires fixed B107 providers and the owning two-block advance policy",
        );
    };
    const completedOldSnapshotHeader = (afterSequence) => {
        const candidates = [];
        for (const request of world.trace) {
            if (
                request.type !== "request" ||
                request.method !== "eth_getBlockByNumber" ||
                request.params?.[0] !== "0x69"
            )
                continue;
            const read = world.trace.find(
                (entry) =>
                    entry.type === "read" &&
                    entry.requestIndex === request.requestIndex &&
                    entry.sequence > request.sequence &&
                    entry.blockNumber === 105 &&
                    entry.view.branch === "B" &&
                    entry.blockHash === ledger.blockAt("B", 105).hash,
            );
            const completion = world.trace.find(
                (entry) =>
                    entry.type === "response" &&
                    entry.requestIndex === request.requestIndex &&
                    entry.sequence > (read?.sequence ?? Infinity),
            );
            if (
                request.sequence > afterSequence ||
                completion?.sequence > afterSequence
            )
                candidates.push({ request, read, completion });
        }
        evidence.oldSnapshotHeaderCandidates = structuredClone(candidates);
        return candidates.find(
            (candidate) =>
                candidate.request.sequence > afterSequence &&
                candidate.read &&
                candidate.completion,
        );
    };
    const callsForRequest = (request) => {
        const aggregate = world.trace.find(
            (entry) =>
                entry.type === "read" &&
                entry.requestIndex === request.requestIndex,
        )?.aggregateCalls;
        return aggregate ?? decodeRpcContractCalls(request);
    };
    const assertFreshRepliesBlocked = () => {
        const current = gate(STALE_RESULT_GATE.FreshStatus);
        const armedAt = current?.events.find(
            (entry) => entry.type === RESPONSE_GATE_EVENT.Armed,
        )?.sequence;
        const responses = world.trace.filter((entry) => {
            if (
                entry.type !== "response" ||
                entry.sequence <= armedAt ||
                entry.method !== "eth_call"
            )
                return false;
            const request = world.trace.find(
                (candidate) =>
                    candidate.type === "request" &&
                    candidate.requestIndex === entry.requestIndex,
            );
            return (
                request &&
                callsForRequest(request).some(
                    (call) =>
                        call.functionName ===
                            RESPONSE_GATE_FUNCTION.OrderStatus &&
                        call.target?.toLowerCase() === ledger.addresses.seaport,
                )
            );
        });
        evidence.freshStatusResponses = structuredClone(responses);
        property(STALE_RESULT_PROPERTY.Projection, () => {
            assert.ok(
                current &&
                    current.argument === null &&
                    !current.released &&
                    !current.aborted &&
                    current.captures.every(
                        (capture) => capture.pending && !capture.delivered,
                    ),
                "Every fresh Seaport status reply must remain externally gated",
            );
            assert.equal(
                responses.length,
                0,
                "A decoded fresh Seaport status response escaped before the rejection cut",
            );
        });
        return current;
    };
    const assertSingleCounterAttempt = () => {
        const armedAt = gate(STALE_RESULT_GATE.OldCounter).events.find(
            (entry) => entry.type === RESPONSE_GATE_EVENT.Armed,
        )?.sequence;
        const attempts = [];
        for (const request of world.trace) {
            if (
                request.type !== "request" ||
                request.method !== "eth_call" ||
                request.sequence <= armedAt
            )
                continue;
            let calls;
            try {
                // Reuse the external wire owner's decoders, including a request
                // whose before-gate has not yet produced a decoded read entry.
                calls = callsForRequest(request);
            } catch (error) {
                throw unreached(
                    "RPC call decoding could not prove the sole original counter attempt",
                    error,
                );
            }
            if (
                calls.some(
                    (call) =>
                        call.functionName === RESPONSE_GATE_FUNCTION.Counter &&
                        call.target.toLowerCase() ===
                            ledger.addresses.seaport &&
                        call.args?.[0]?.toLowerCase() ===
                            ledger.addresses.bidder,
                )
            )
                attempts.push({
                    requestIndex: request.requestIndex,
                    sequence: request.sequence,
                    provider: request.provider,
                    selector: request.params?.[1],
                });
        }
        evidence.counterAttempts = attempts;
        requireCut(
            attempts.length === 1 &&
                attempts[0].requestIndex === evidence.counter.requestIndex,
            "A second bidder counter attempt makes consumption of the captured A105 outcome unproved",
        );
    };
    const requireOriginalAttempt = (state) => {
        const target = findTarget(state);
        requireCut(
            target.order &&
                target.run &&
                target.run.lease_owner === original.lease_owner &&
                target.run.lease_version === original.lease_version &&
                target.run.failures === original.failures &&
                target.run.lease_until > now(),
            "The captured attempt ended before the controlled old-reply release",
        );
        requireCut(
            isDeepStrictEqual(
                pick(target.run, PAGE_FIELDS),
                pick(original, PAGE_FIELDS),
            ) && target.run.generation >= original.generation,
            "Recovery changed the captured maker page before the controlled release; this attempt's unchanged lineage is unproved",
        );
        return target;
    };
    const assertNoMutation = (state) => {
        const current = findTarget(state);
        property(STALE_RESULT_PROPERTY.Projection, () => {
            assert.equal(
                state.revision,
                baseline.revision,
                "The rejection cut requires its captured B revision",
            );
            assert.deepEqual(
                pick(current.order, ORDER_FIELDS),
                pick(baseline.order, ORDER_FIELDS),
                "An old reply cannot mutate the target's canonical validation projection",
            );
            assert.deepEqual(
                pick(current.proof, PROOF_FIELDS),
                pick(baseline.proof, PROOF_FIELDS),
                "An old reply cannot publish or replace a validation proof",
            );
            if (baseline.proof?.pending === 1)
                assert.equal(
                    current.proof?.pending,
                    1,
                    "A newer pending requirement cannot be discharged by the old reply",
                );
            if (baseline.proof)
                assert.ok(
                    current.proof &&
                        current.proof.generation >= baseline.proof.generation,
                    "The captured requirement cannot disappear or regress",
                );
        });
        property(STALE_RESULT_PROPERTY.Retained, () => {
            assert.ok(
                current.run,
                "The pending maker obligation cannot disappear during rejection",
            );
            assert.equal(current.run.status, MAKER_REVALIDATION_STATUS.Pending);
            assert.deepEqual(
                pick(current.run, PAGE_FIELDS),
                pick(baseline.run, PAGE_FIELDS),
                "An old result cannot advance or replace its captured maker page",
            );
            assert.ok(
                current.run.generation >= baseline.run.generation,
                "Required maker generations cannot be lost",
            );
        });
        return current;
    };
    world.armResponseGate({
        name: STALE_RESULT_GATE.OldCounter,
        functionName: RESPONSE_GATE_FUNCTION.Counter,
        argument: ledger.addresses.bidder,
    });
    return {
        async captureHeld() {
            stage = STALE_RESULT_PROPERTY.Held;
            try {
                await boundedWait(() => {
                    assertRuntimeAlive();
                    return (
                        (gate(STALE_RESULT_GATE.OldCounter)?.pending ?? 0) > 0
                    );
                }, "The target A105 counter reply was not captured");
                evidence.counter = structuredClone(oldCounter());
                assertSingleCounterAttempt();
                stage = STALE_RESULT_PROPERTY.Maker;
                const state = await observe();
                const candidates = state.makerRuns.filter((row) => {
                    const payload = JSON.parse(row.payload_json);
                    return (
                        row.status === MAKER_REVALIDATION_STATUS.Pending &&
                        payload.chainId === ledger.chainId &&
                        payload.scope === MAKER_TRIGGER_SCOPE.Global &&
                        payload.reason ===
                            GLOBAL_MAKER_TRIGGER_REASON.OrderCounter &&
                        payload.maker.toLowerCase() ===
                            ledger.addresses.bidder &&
                        payload.blockNumber === 105 &&
                        payload.blockHash === ledger.blockAt("A", 105).hash &&
                        row.after_id < orderId &&
                        row.upper_order_id >= orderId
                    );
                });
                requireCut(
                    candidates.length === 1,
                    "Exactly one pending A105 counter maker page must own the target",
                );
                original = structuredClone(candidates[0]);
                requireCut(
                    typeof original.lease_owner === "string" &&
                        original.lease_owner.length > 0 &&
                        original.lease_version > 0,
                    "The target maker page must have an actual acquired lease",
                );
                assertAttemptFresh();
                requireCut(
                    findTarget(state).order,
                    "The target order must exist at the held counter boundary",
                );
                evidence.original = original;
                evidence.before = structuredClone(state);
                evidence.timing = {
                    requestTimeoutMs,
                    passStartedAt: original.pass_started_at,
                    transportDeadline:
                        original.pass_started_at + requestTimeoutMs,
                    capturedAt: now(),
                };
                world.armResponseGate({
                    name: STALE_RESULT_GATE.FreshStatus,
                    functionName: RESPONSE_GATE_FUNCTION.OrderStatus,
                });
                evidence.reached.heldLiveMakerAttempt = true;
                return structuredClone(evidence);
            } catch (error) {
                throw attach(
                    isStaleResultCutUnreached(error) ||
                        isStaleResultCutRuntimeFailure(error)
                        ? error
                        : unreached(error.message, error),
                );
            }
        },
        /** Restart the real recovery actor through a lifecycle port. Readiness
         * changes the authored schedule; it does not establish rollback or
         * rejection, and never restarts the captured domain attempt's clock. */
        async restartRecovery(restartPort) {
            stage = STALE_RESULT_PROPERTY.RecoveryRestart;
            let restart;
            try {
                requireCut(
                    !evidence.recoveryRestart,
                    "The controlled cut permits one explicit recovery-worker restart",
                );
                restart = {
                    property: STALE_RESULT_PROPERTY.RecoveryRestart,
                    startedAt: now(),
                    completed: false,
                };
                evidence.recoveryRestart = restart;
                assert.equal(
                    typeof restartPort,
                    "function",
                    "A real recovery-worker restart port is required",
                );
                requireCut(
                    !baseline,
                    "Recovery restart must precede the post-rollback baseline",
                );
                const guardAttempt = async () => {
                    assertRuntimeAlive();
                    assertAttemptFresh();
                    assertFixedRecoveryHead();
                    oldCounter();
                    assertFreshRepliesBlocked();
                    assertSingleCounterAttempt();
                    const target = requireOriginalAttempt(await observe());
                    requireCut(
                        target.run.pass_started_at === original.pass_started_at,
                        "Recovery restart cannot replace the captured maker pass start",
                    );
                    assertAttemptFresh();
                };
                await guardAttempt();
                const viewSequence = world.trace.findLast(
                    (entry) =>
                        entry.type === "provider-view" &&
                        entry.view?.branch === "B" &&
                        entry.view?.head === 107,
                )?.sequence;
                requireCut(
                    Number.isSafeInteger(viewSequence) && viewSequence >= 0,
                    "Recovery restart needs the actual provided B107 view sequence",
                );
                restart.providedViewSequence = viewSequence;
                restart.providedViews = world.snapshot().providers;
                const head = ledger.blockAt("B", 107);
                restart.head = {
                    branch: "B",
                    number: head.number,
                    hash: head.hash,
                    timestamp: head.timestamp,
                };
                restart.heldCounter = structuredClone(oldCounter());
                restart.originalTiming = structuredClone(evidence.timing);
                // Await the owner so an unready replacement cannot outlive a
                // shorter racing timer and escape the normal process cleanup.
                const receipt = await restartPort();
                restart.readyAt = now();
                const plain = (value) =>
                    value &&
                    typeof value === "object" &&
                    [Object.prototype, null].includes(
                        Object.getPrototypeOf(value),
                    );
                const identity = (value) =>
                    plain(value)
                        ? Object.fromEntries(
                              ["id", "pid", "generation", "artifact"].map(
                                  (key) => {
                                      const field = value[key];
                                      return [
                                          key,
                                          field === null ||
                                          [
                                              "string",
                                              "number",
                                              "boolean",
                                              "undefined",
                                          ].includes(typeof field)
                                              ? field
                                              : { providedType: typeof field },
                                      ];
                                  },
                              ),
                          )
                        : { providedType: typeof value };
                restart.receipt = Object.fromEntries(
                    ["before", "after", "domainBefore", "domainAfter"].map(
                        (key) => [key, identity(receipt?.[key])],
                    ),
                );
                requireCut(
                    plain(receipt),
                    "Recovery restart must return a plain actor-identity receipt",
                );
                const actor = (value, id, label) => {
                    requireCut(
                        plain(value) &&
                            value.id === id &&
                            Number.isSafeInteger(value.pid) &&
                            value.pid > 0 &&
                            Number.isSafeInteger(value.generation) &&
                            value.generation >= 0 &&
                            value.artifact ===
                                PRODUCTION_RUNTIME_PROCESSES.find(
                                    (spec) => spec.id === id,
                                )?.artifact,
                        `Recovery restart requires a valid ${label} production actor identity`,
                    );
                };
                actor(receipt.before, RUNTIME_PROCESS.Reorg, "previous reorg");
                actor(
                    receipt.after,
                    RUNTIME_PROCESS.Reorg,
                    "replacement reorg",
                );
                actor(
                    receipt.domainBefore,
                    RUNTIME_PROCESS.Domain,
                    "previous domain",
                );
                actor(
                    receipt.domainAfter,
                    RUNTIME_PROCESS.Domain,
                    "current domain",
                );
                requireCut(
                    receipt.after.pid !== receipt.before.pid &&
                        receipt.after.generation ===
                            receipt.before.generation + 1 &&
                        receipt.after.artifact === receipt.before.artifact,
                    "Recovery restart must replace the reorg PID and advance exactly one generation of the same artifact",
                );
                requireCut(
                    isDeepStrictEqual(
                        identity(receipt.domainBefore),
                        identity(receipt.domainAfter),
                    ),
                    "Recovery restart cannot replace or change the captured domain actor",
                );
                requireCut(
                    receipt.before.pid !== receipt.domainBefore.pid &&
                        receipt.after.pid !== receipt.domainAfter.pid,
                    "Recovery and domain actor identities must remain distinct",
                );
                await guardAttempt();
                restart.heldCounterAfter = structuredClone(oldCounter());
                restart.providedViewsAfter = world.snapshot().providers;
                restart.completed = true;
                return structuredClone(evidence);
            } catch (error) {
                if (restart) {
                    restart.failedAt = now();
                    restart.failure = {
                        name: error?.name,
                        message: String(error?.message ?? error),
                        ...(typeof error?.code === "string"
                            ? { code: error.code }
                            : {}),
                    };
                }
                // An actual runtime failure is still an execution failure.
                // Preserve generic liveness fallback labels as well as typed
                // exit causes; neither establishes a reached safety cut.
                if (isStaleResultCutRuntimeFailure(error)) throw attach(error);
                const failure =
                    isStaleResultCutUnreached(error) &&
                    error.property === STALE_RESULT_PROPERTY.RecoveryRestart
                        ? error
                        : unreached(String(error?.message ?? error), error);
                if (error?.simulation && failure !== error)
                    failure.simulation = error.simulation;
                throw attach(failure);
            }
        },
        async captureRollback() {
            stage = STALE_RESULT_PROPERTY.Rollback;
            try {
                requireCut(
                    original,
                    "Capture the held maker attempt before its rollback baseline",
                );
                let state;
                await boundedWait(async () => {
                    assertRuntimeAlive();
                    assertAttemptFresh();
                    assertFixedRecoveryHead();
                    state = await observe();
                    const recovery = state.recovery[0];
                    if (
                        !(
                            state.revision === evidence.before.revision + 1 &&
                            state.recovery.length === 1 &&
                            recovery.chain_id === ledger.chainId &&
                            recovery.revision === state.revision &&
                            recovery.phase === REORG_RECOVERY_PHASE.Resync &&
                            typeof recovery.recovery_id === "string" &&
                            recovery.recovery_id.length > 0 &&
                            recovery.range_from >= 104 &&
                            recovery.range_from <= recovery.range_to &&
                            recovery.range_to <= 107 &&
                            recovery.target_block === 107 &&
                            [104, 105].includes(recovery.checked_block) &&
                            recovery.stored_hash ===
                                ledger.blockAt("A", recovery.checked_block)
                                    .hash &&
                            recovery.observed_hash ===
                                ledger.blockAt("B", recovery.checked_block).hash
                        )
                    )
                        return false;
                    // Reuse the independent chain/fill oracle for the retained
                    // shared prefix and exact rollback ownership/fill/transfer
                    // effects. Concurrent B acquisition may append a partial
                    // range; require its identity without assuming completeness.
                    try {
                        assertCanonicalAcquisition({
                            snapshot: {
                                ...state,
                                headers: state.headers.filter(
                                    (row) => row.block_number <= 103,
                                ),
                                coverage: state.coverage.filter(
                                    (row) => row.block_number <= 103,
                                ),
                            },
                            ledger,
                            branch: "B",
                            head: 103,
                        });
                        const appended = state.headers.filter(
                            (row) => row.block_number > 103,
                        );
                        assert.equal(
                            new Set(appended.map((row) => row.block_number))
                                .size,
                            appended.length,
                        );
                        for (const row of appended) {
                            assert.ok(row.block_number <= 107);
                            const expected = ledger.blockAt(
                                "B",
                                row.block_number,
                            );
                            assert.equal(row.block_hash, expected.hash);
                            assert.equal(row.parent_hash, expected.parentHash);
                        }
                        const coverage = state.coverage.map(
                            (row) => row.block_number,
                        );
                        assert.equal(new Set(coverage).size, coverage.length);
                        assert.ok(coverage.every((number) => number <= 107));
                        return true;
                    } catch {
                        return false;
                    }
                }, "Committed B rollback effects and retained resync were not observed during the original live transport");
                oldCounter();
                let target = requireOriginalAttempt(state);
                const beforeAdmission = structuredClone(state);
                evidence.rollback = {
                    observedAt: now(),
                    recovery: structuredClone(state.recovery[0]),
                    state: structuredClone(state),
                };
                stage = STALE_RESULT_PROPERTY.FreshRequirement;
                requireCut(
                    target.order?.seaport_data_source_kind ===
                        ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
                    "The target must retain its genuine first-stream admission boundary",
                );
                const input = await admitFreshBidRequirement({
                    before: beforeAdmission,
                    orderId,
                    assertLive: assertAttemptFresh,
                });
                requireCut(
                    input?.deliveredRecipients > 0 &&
                        Number.isSafeInteger(input.sourceEventAt) &&
                        input.sourceEventAt >
                            Math.max(
                                0,
                                ...beforeAdmission.observations
                                    .filter((row) => row.order_id === orderId)
                                    .map((row) => row.source_event_at ?? 0),
                            ),
                    "The fresh bid requirement needs an actual delivered source input",
                );
                await boundedWait(async () => {
                    assertRuntimeAlive();
                    assertAttemptFresh();
                    assertFixedRecoveryHead();
                    state = await observe();
                    target = findTarget(state);
                    assertFreshRepliesBlocked();
                    return (
                        target.order?.state_revision >
                            beforeAdmission.orders.find(
                                (row) => row.id === orderId,
                            ).state_revision &&
                        target.order.seaport_data_source_kind ===
                            ORDER_SEAPORT_DATA_SOURCE_KIND.Stream &&
                        target.proof?.generation >
                            (beforeAdmission.validationProofs.find(
                                (row) => row.order_id === orderId,
                            )?.generation ?? 0) &&
                        target.proof.pending === 1 &&
                        state.observations.some(
                            (row) =>
                                row.order_id === orderId &&
                                row.channel ===
                                    OFFCHAIN_OBSERVATION_CHANNEL.Stream &&
                                row.source_event_at === input.sourceEventAt,
                        )
                    );
                }, "The actual new bid revision and retained pending demand were not proved");
                evidence.freshInput = structuredClone(input);
                evidence.freshAdmission = {
                    beforeOrder: beforeAdmission.orders.find(
                        (row) => row.id === orderId,
                    ),
                    order: structuredClone(target.order),
                    proof: structuredClone(target.proof),
                };
                evidence.reached.freshSourceRequirementHeld = true;
                oldCounter();
                assertAttemptFresh();
                assertFixedRecoveryHead();
                assertSingleCounterAttempt();
                stage = STALE_RESULT_PROPERTY.Rollback;
                target = requireOriginalAttempt(state);
                baseline = structuredClone({
                    revision: state.revision,
                    order: target.order,
                    proof: target.proof,
                    run: target.run,
                });
                evidence.baseline = baseline;
                evidence.reached.postRollbackBaseline = true;
                return structuredClone(evidence);
            } catch (error) {
                throw attach(
                    error.property ? error : unreached(error.message, error),
                );
            }
        },
        async releaseAndAssertRejected() {
            stage = STALE_RESULT_PROPERTY.Rejected;
            try {
                requireCut(
                    baseline,
                    "A post-rollback baseline is required before releasing old bytes",
                );
                assertAttemptFresh();
                assertFixedRecoveryHead();
                oldCounter();
                const fresh = gate(STALE_RESULT_GATE.FreshStatus);
                requireCut(
                    fresh && !fresh.released && !fresh.aborted,
                    "Fresh status replies must remain gated before the old release",
                );
                assertFreshRepliesBlocked();
                evidence.timing.releasedAt = now();
                world.releaseResponseGate(STALE_RESULT_GATE.OldCounter);
                let finalState;
                await boundedWait(async () => {
                    assertRuntimeAlive();
                    const state = await observe();
                    const current = assertNoMutation(state);
                    assertSingleCounterAttempt();
                    assertAttemptFresh();
                    assertFixedRecoveryHead();
                    const old = gate(STALE_RESULT_GATE.OldCounter).captures[0];
                    assertFreshRepliesBlocked();
                    const failedRelease =
                        current.run.failures === original.failures + 1 &&
                        current.run.lease_version === original.lease_version &&
                        current.run.lease_owner === null &&
                        current.run.lease_until === 0 &&
                        current.run.updated_at >= evidence.timing.releasedAt &&
                        current.run.updated_at <
                            evidence.timing.transportDeadline &&
                        current.run.last_error === STALE_RESULT_FINISH_FAILURE;
                    // Numeric header traffic alone is not caller-exclusive.
                    // Its supporting event is accepted only with the exact
                    // persisted finish-refusal reason, original lease version,
                    // no retry, and completion before the conservative HTTP
                    // deadline. Other legitimate B105 traffic is not excluded.
                    const verification = completedOldSnapshotHeader(
                        old.deliveredAt,
                    );
                    if (
                        !old.delivered ||
                        old.pending ||
                        !failedRelease ||
                        !verification
                    )
                        return false;
                    evidence.oldSnapshotVerification =
                        structuredClone(verification);
                    finalState = state;
                    return true;
                }, "The original attempt's exact snapshot-finish refusal was not proved before its RPC deadline");
                assertSingleCounterAttempt();
                evidence.timing.completedAt = now();
                evidence.failedRelease = structuredClone(
                    findTarget(finalState).run,
                );
                evidence.refusalReason = STALE_RESULT_FINISH_FAILURE;
                evidence.afterRejection = structuredClone(finalState);
                evidence.reached.durableFailedRelease = true;
                evidence.reached.unchangedProjectionAndPage = true;
                evidence.responseGatesAtCut = world.snapshot().responseGates;
                world.releaseResponseGate(STALE_RESULT_GATE.FreshStatus);
                evidence.reached.freshRepliesReleased = true;
                return structuredClone(evidence);
            } catch (error) {
                throw attach(
                    error.property ? error : unreached(error.message, error),
                );
            }
        },
        abort() {
            for (const name of Object.values(STALE_RESULT_GATE)) {
                const current = gate(name);
                if (current && !current.released && !current.aborted)
                    world.abortResponseGate(name);
            }
        },
        evidence: () => structuredClone(evidence),
    };
}
