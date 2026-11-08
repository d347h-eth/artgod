import assert from "node:assert/strict";
import { ORDER_SOURCE_STATUS } from "../../../../shared/market-data/orders.ts";
import {
    PRODUCTION_RUNTIME_PROCESSES,
    RUNTIME_PROCESS,
} from "../runtime-manifest.mjs";

// These doubles verify the fault driver's guards and evidence accounting only.
// Real process, broker and SQLite behavior require the separate VM scenarios.
export function processFixture(options = {}) {
    const actions = [];
    const input = {
        orderId: `0x${"1".repeat(64)}`,
        sourceEventAt: 1_800_000_001,
        expectedSourceStatus: ORDER_SOURCE_STATUS.Cancelled,
    };
    const state = {
        observations: [],
        orders: [
            { id: input.orderId, source_status: ORDER_SOURCE_STATUS.Active },
        ],
        pendingDemand: [],
        pendingOutbox: [],
        unfinishedMaker: [],
        recovery: [],
    };
    let pending = false;
    let restartedBroker = false;
    const finishInput = () => {
        pending = false;
        if (!options.missingObservation)
            state.observations.push({
                order_id: input.orderId,
                source_event_at: input.sourceEventAt,
                channel: "stream",
            });
        if (!options.missingCanonicalChange)
            state.orders[0].source_status = ORDER_SOURCE_STATUS.Cancelled;
        if (options.pendingDemand)
            state.pendingDemand.push({ order_id: input.orderId });
    };
    const child = (pid) => ({
        pid,
        exitCode: null,
        signalCode: null,
        paused: false,
        kill(signal) {
            actions.push(["signal", pid, signal]);
            if (signal === "SIGSTOP") this.paused = true;
            else if (signal === "SIGCONT") {
                this.paused = false;
                if (restartedBroker) finishInput();
            }
            return true;
        },
    });
    const spec = PRODUCTION_RUNTIME_PROCESSES.find(
        (entry) => entry.id === RUNTIME_PROCESS.OffchainIngest,
    );
    const original = {
        ...spec,
        filename: `/workbench/runtime/${spec.artifact}`,
        child: child(10001),
    };
    const processes = [original];
    const broker = { child: child(20001), url: "nats://127.0.0.1:4222" };
    const context = {
        processes,
        broker,
        async readProcessState(target) {
            assert.equal(target, original.child);
            return options.notPaused ? "R" : target.paused ? "T" : "R";
        },
        async stopProcess(target, signal) {
            actions.push(["stop", target.pid, signal]);
            target.signalCode = signal;
        },
        async restartProcess(id) {
            assert.equal(id, original.id);
            const replacement = {
                ...original,
                child: child(options.samePid ? 10001 : 10002),
                intentionallyStopped: false,
            };
            if (options.wrongArtifact) replacement.artifact = "other.mjs";
            processes.splice(0, 1, replacement);
            finishInput();
            return replacement;
        },
        async restartBroker() {
            actions.push(["broker-restart"]);
            broker.child = child(20002);
            restartedBroker = true;
            return broker;
        },
        async emitExternalInput() {
            actions.push(["external-input"]);
            pending = true;
            return input;
        },
        async closeSources() {
            actions.push(["sources-closed"]);
        },
        async queueState(actualInput) {
            assert.deepEqual(actualInput, input);
            return {
                stream: "SIMULATION",
                consumer: "offchain-ingest-1",
                pending: pending ? 1 : 0,
                ackPending: 0,
                streamMessages: pending ? 1 : 0,
                matchingInputRetained:
                    pending &&
                    !options.noRetainedInput &&
                    !(options.lostOnRestart && restartedBroker),
                retainedSequence:
                    options.changedSequence && restartedBroker ? 43 : 42,
            };
        },
        async observe() {
            return structuredClone(state);
        },
        async eventually(check, label) {
            if (!(await check()))
                throw new Error(`Unreached test boundary: ${label}`);
        },
    };
    return {
        context,
        actions,
        state,
        input,
        original,
        broker,
        createChild: child,
        finishInput,
    };
}
