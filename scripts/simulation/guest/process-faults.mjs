import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ORDER_SOURCE_STATUS } from "../../../shared/market-data/orders.ts";
import { RUNTIME_PROCESS } from "./runtime-manifest.mjs";

export const PROCESS_FAULT_KIND = Object.freeze({
    OffchainRestart: "offchain-restart",
    BrokerRestart: "broker-restart",
});

export const PROCESS_FAULT_PROPERTY = Object.freeze({
    Paused: "consumer-actually-stopped",
    Retained: "matching-input-durably-retained",
    Restarted: "same-production-runtime-restarted",
    BrokerRetained: "broker-restart-preserves-input",
    Recovered: "retained-input-reaches-production-ingestion",
    Converged: "process-recovery-obligations-drain",
});

const SIGNAL = Object.freeze({
    Pause: "SIGSTOP",
    Resume: "SIGCONT",
    Kill: "SIGKILL",
});

function live(entry) {
    return entry.child.exitCode === null && entry.child.signalCode === null;
}

/** Linux guest process state, used to acknowledge a real stop before input. */
export async function readRuntimeProcessState(child) {
    const pid = child?.pid;
    assert.ok(
        Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid,
        "A tracked production child PID is required",
    );
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const state = /^State:\s+([A-Za-z])/m.exec(status)?.[1];
    assert.ok(state, "Kernel did not report the production child state");
    return state;
}

function assertInput(input) {
    assert.ok(
        input &&
            typeof input.orderId === "string" &&
            /^0x[0-9a-f]{64}$/i.test(input.orderId),
        "External input needs the actual order hash",
    );
    assert.ok(
        Number.isSafeInteger(input.sourceEventAt) && input.sourceEventAt > 0,
        "External input needs its actual source timestamp",
    );
    assert.equal(
        input.expectedSourceStatus,
        ORDER_SOURCE_STATUS.Cancelled,
        "The authored recovery input must request a real source cancellation",
    );
}

function retained(proof) {
    return (
        proof?.matchingInputRetained === true &&
        Number.isSafeInteger(proof.retainedSequence) &&
        proof.retainedSequence > 0 &&
        typeof proof.stream === "string" &&
        typeof proof.consumer === "string" &&
        [proof.pending, proof.ackPending, proof.streamMessages].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
        ) &&
        proof.pending + proof.ackPending > 0
    );
}

/** Reused by single-actor and complete-runtime lifecycle recovery drivers. */
export function assertRestartedRuntime(original, replacement, registry) {
    assert.ok(
        replacement &&
            replacement.child.pid !== original.pid &&
            live(replacement),
        "A new production process must actually start",
    );
    assert.equal(
        replacement.artifact,
        original.artifact,
        "Recovery must use the same production artifact",
    );
    assert.equal(
        replacement.filename,
        original.filename,
        "Recovery must use the same production entrypoint",
    );
    assert.ok(
        registry.includes(replacement) && !replacement.intentionallyStopped,
        "The restarted process must participate in runtime liveness checks",
    );
}

function noObligations(state) {
    return [
        "pendingDemand",
        "pendingOutbox",
        "unfinishedMaker",
        "recovery",
    ].every((key) => {
        assert.ok(
            Array.isArray(state[key]),
            `Read-only observation must include ${key}`,
        );
        return state[key].length === 0;
    });
}

/**
 * Shared retained-input recovery boundary for process faults and startup lifecycle.
 * Only actual child handles and read-only broker/SQLite observations are used.
 * queueState(input) must prove the exact stored external input, including its
 * stream/consumer/retainedSequence; a global queue count is insufficient.
 */
export async function withRetainedRawInput(
    context,
    operation,
    { kind, timeoutMs = 180_000 } = {},
) {
    assert.ok(
        typeof kind === "string" && kind.length > 0,
        "An explicit recovery kind is required",
    );
    assert.equal(
        typeof operation,
        "function",
        "A real recovery operation is required",
    );
    assert.ok(
        Number.isSafeInteger(timeoutMs) &&
            timeoutMs > 0 &&
            timeoutMs <= 600_000,
        "Recovery needs a bounded timeout",
    );
    for (const key of [
        "stopProcess",
        "emitExternalInput",
        "queueState",
        "observe",
        "eventually",
        "closeSources",
    ])
        assert.equal(
            typeof context?.[key],
            "function",
            `Recovery requires ${key}`,
        );
    assert.ok(
        Array.isArray(context.processes),
        "The actual runtime registry is required",
    );
    const original = context.processes.find(
        (entry) => entry.id === RUNTIME_PROCESS.OffchainIngest,
    );
    assert.ok(
        original?.artifact && original?.filename && live(original),
        "The real offchain entrypoint must be running",
    );
    const originalChild = original.child;
    const stateOf = context.readProcessState ?? readRuntimeProcessState;
    const evidence = {
        version: 1,
        kind,
        phase: PROCESS_FAULT_PROPERTY.Paused,
        boundaryConfirmed: false,
        events: [],
        original: {
            id: original.id,
            pid: originalChild.pid,
            artifact: original.artifact,
            filename: original.filename,
        },
    };
    const record = (event, detail = {}) =>
        evidence.events.push({
            sequence: evidence.events.length + 1,
            event,
            ...detail,
        });
    let paused = false;
    const resume = () => {
        if (
            paused &&
            originalChild.exitCode === null &&
            originalChild.signalCode === null
        ) {
            assert.equal(
                originalChild.kill(SIGNAL.Resume),
                true,
                "Production consumer could not resume",
            );
            paused = false;
        }
    };
    try {
        assert.equal(
            originalChild.kill(SIGNAL.Pause),
            true,
            "Production raw consumer could not be paused",
        );
        paused = true;
        await context.eventually(
            async () => ["T", "t"].includes(await stateOf(originalChild)),
            "actual raw consumer stopped by the kernel",
            timeoutMs,
        );
        record(PROCESS_FAULT_PROPERTY.Paused, { pid: originalChild.pid });
        evidence.phase = PROCESS_FAULT_PROPERTY.Retained;
        const prior = await context.observe();
        assert.ok(
            Array.isArray(prior.observations),
            "Read-only observation must include prior ingestion evidence",
        );
        const input = await context.emitExternalInput();
        assertInput(input);
        assert.ok(
            prior.orders?.some(
                (order) =>
                    order.id === input.orderId &&
                    order.source_status === ORDER_SOURCE_STATUS.Active,
            ),
            "Recovery must start with a source-active order so cancellation is observable",
        );
        assert.ok(
            !prior.observations.some(
                (observation) =>
                    observation.order_id === input.orderId &&
                    observation.source_event_at === input.sourceEventAt,
            ),
            "External input must be fresh: earlier ingestion cannot prove recovery",
        );
        evidence.input = structuredClone(input);
        let before;
        await context.eventually(
            async () => {
                const observed = await context.queueState(input);
                if (!retained(observed)) return false;
                before = observed;
                return true;
            },
            "matching external input stored in the real pending raw queue",
            timeoutMs,
        );
        evidence.boundaryConfirmed = true;
        record(PROCESS_FAULT_PROPERTY.Retained, {
            queue: structuredClone(before),
        });
        await context.closeSources();
        await operation({ original, input, before, evidence, record, resume });
        evidence.phase = PROCESS_FAULT_PROPERTY.Recovered;
        let recovered;
        await context.eventually(
            async () => {
                const current = await context.observe();
                assert.ok(
                    Array.isArray(current.observations),
                    "Read-only observation must include raw ingestion evidence",
                );
                if (
                    !current.observations.some(
                        (observation) =>
                            observation.order_id === input.orderId &&
                            observation.source_event_at === input.sourceEventAt,
                    )
                )
                    return false;
                if (
                    !current.orders?.some(
                        (order) =>
                            order.id === input.orderId &&
                            order.source_status === input.expectedSourceStatus,
                    )
                )
                    return false;
                recovered = current;
                return true;
            },
            "the retained input reaches the actual production ingestion path",
            timeoutMs,
        );
        record(PROCESS_FAULT_PROPERTY.Recovered, {
            observations: recovered.observations.filter(
                (observation) =>
                    observation.order_id === input.orderId &&
                    observation.source_event_at === input.sourceEventAt,
            ),
        });
        evidence.phase = PROCESS_FAULT_PROPERTY.Converged;
        await context.eventually(
            async () => {
                const current = await context.observe();
                const queue = await context.queueState(input);
                if (!noObligations(current) || queue.streamMessages !== 0)
                    return false;
                evidence.finalState = current;
                evidence.finalQueue = queue;
                return true;
            },
            "all finite retained process-recovery obligations finish",
            timeoutMs,
        );
        record(PROCESS_FAULT_PROPERTY.Converged);
        return evidence;
    } catch (error) {
        error.failureProperty ??= evidence.phase;
        error.simulation = {
            ...(error.simulation ?? {}),
            failureProperty: error.failureProperty,
            reachedFaultBoundary: evidence.boundaryConfirmed,
            processFault: evidence,
        };
        throw error;
    } finally {
        if (
            paused &&
            originalChild.exitCode === null &&
            originalChild.signalCode === null
        ) {
            resume();
            record("teardown-resumed-paused-consumer", {
                pid: originalChild.pid,
            });
        }
    }
}

/** Hard-kill/restart actual workers or the broker, without an invented ACK cut. */
export async function executeProcessFault(plan, context) {
    const kind = typeof plan === "string" ? plan : plan?.kind;
    const timeoutMs =
        typeof plan === "object" ? (plan.timeoutMs ?? 180_000) : 180_000;
    assert.ok(
        Object.values(PROCESS_FAULT_KIND).includes(kind),
        "Unsupported authored process fault",
    );
    assert.ok(
        Number.isSafeInteger(timeoutMs) &&
            timeoutMs > 0 &&
            timeoutMs <= 600_000,
        "Process fault needs a bounded timeout",
    );
    assert.equal(
        typeof context?.[
            kind === PROCESS_FAULT_KIND.OffchainRestart
                ? "restartProcess"
                : "restartBroker"
        ],
        "function",
        "The selected real restart callback is required",
    );
    return withRetainedRawInput(
        context,
        async ({ original, input, before, evidence, record, resume }) => {
            if (kind === PROCESS_FAULT_KIND.OffchainRestart) {
                evidence.phase = PROCESS_FAULT_PROPERTY.Restarted;
                original.intentionallyStopped = true;
                await context.stopProcess(original.child, SIGNAL.Kill);
                assert.ok(
                    !live(original),
                    "Killed production consumer is still running",
                );
                const replacement = await context.restartProcess(original.id);
                assertRestartedRuntime(
                    evidence.original,
                    replacement,
                    context.processes,
                );
                record(PROCESS_FAULT_PROPERTY.Restarted, {
                    previousPid: evidence.original.pid,
                    pid: replacement.child.pid,
                    artifact: replacement.artifact,
                });
            } else {
                evidence.phase = PROCESS_FAULT_PROPERTY.BrokerRetained;
                const broker = context.broker;
                assert.ok(
                    broker?.child && live(broker),
                    "The real broker must be running before the fault",
                );
                const beforeBroker = { pid: broker.child.pid, url: broker.url };
                await context.stopProcess(broker.child, SIGNAL.Kill);
                const replacement = await context.restartBroker();
                assert.ok(
                    replacement?.child &&
                        replacement.child.pid !== beforeBroker.pid &&
                        live(replacement),
                    "A new broker must actually start",
                );
                assert.equal(
                    replacement.url,
                    beforeBroker.url,
                    "Production workers must reconnect to their original broker address",
                );
                let after;
                await context.eventually(
                    async () => {
                        const observed = await context.queueState(input);
                        if (!retained(observed)) return false;
                        after = observed;
                        return true;
                    },
                    "the same external input survives the real broker restart",
                    timeoutMs,
                );
                assert.equal(
                    after.stream,
                    before.stream,
                    "Restart must preserve the selected stream",
                );
                assert.equal(
                    after.consumer,
                    before.consumer,
                    "Restart must preserve the selected durable consumer",
                );
                assert.equal(
                    after.retainedSequence,
                    before.retainedSequence,
                    "Retained input must survive without republication",
                );
                record(PROCESS_FAULT_PROPERTY.BrokerRetained, {
                    previousPid: beforeBroker.pid,
                    pid: replacement.child.pid,
                    queue: structuredClone(after),
                });
                resume();
            }
        },
        { kind, timeoutMs },
    );
}
