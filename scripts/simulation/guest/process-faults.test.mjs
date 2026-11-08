import assert from "node:assert/strict";
import test from "node:test";
import {
    executeProcessFault,
    PROCESS_FAULT_KIND,
    PROCESS_FAULT_PROPERTY,
    assertRestartedRuntime,
} from "./process-faults.mjs";
import { ORDER_SOURCE_STATUS } from "../../../shared/market-data/orders.ts";

import { processFixture } from "./fixtures/process-control-fixture.mjs";

test("offchain restart requires retained input then the same new live production artifact", async () => {
    const f = processFixture();
    const evidence = await executeProcessFault(
        PROCESS_FAULT_KIND.OffchainRestart,
        f.context,
    );
    assert.equal(evidence.boundaryConfirmed, true);
    assert.equal(evidence.original.pid, 10001);
    assert.ok(
        evidence.events.some(
            (event) =>
                event.event === PROCESS_FAULT_PROPERTY.Restarted &&
                event.pid === 10002,
        ),
    );
    assert.equal(evidence.finalQueue.streamMessages, 0);
    assert.deepEqual(f.actions.slice(0, 4), [
        ["signal", 10001, "SIGSTOP"],
        ["external-input"],
        ["sources-closed"],
        ["stop", 10001, "SIGKILL"],
    ]);
    assert.equal(
        f.state.observations[0].source_event_at,
        f.input.sourceEventAt,
    );
});

test("broker restart keeps consumer paused until the exact stream sequence survives", async () => {
    const f = processFixture();
    const evidence = await executeProcessFault(
        PROCESS_FAULT_KIND.BrokerRestart,
        f.context,
    );
    const proof = evidence.events.find(
        (event) => event.event === PROCESS_FAULT_PROPERTY.BrokerRetained,
    );
    assert.equal(proof.previousPid, 20001);
    assert.equal(proof.pid, 20002);
    assert.equal(proof.queue.retainedSequence, 42);
    assert.ok(
        f.actions.findIndex((action) => action[0] === "broker-restart") <
            f.actions.findIndex(
                (action) => action[0] === "signal" && action[2] === "SIGCONT",
            ),
    );
    assert.ok(
        !f.actions.some(
            (action) => action[0] === "stop" && action[1] === 10001,
        ),
    );
});

test("pause acknowledgement and matching stored input are real preconditions, not global queue counts", async () => {
    for (const options of [{ notPaused: true }, { noRetainedInput: true }]) {
        const f = processFixture(options);
        await assert.rejects(
            executeProcessFault(PROCESS_FAULT_KIND.OffchainRestart, f.context),
            (error) => {
                assert.equal(error.simulation.reachedFaultBoundary, false);
                return /Unreached test boundary/.test(error.message);
            },
        );
        assert.ok(!f.actions.some((action) => action[0] === "stop"));
        assert.deepEqual(f.actions.at(-1), ["signal", 10001, "SIGCONT"]);
    }
});

test("lost input or republication on broker restart stays a failed durable property", async () => {
    for (const options of [
        { lostOnRestart: true },
        { changedSequence: true },
    ]) {
        const f = processFixture(options);
        await assert.rejects(
            executeProcessFault(PROCESS_FAULT_KIND.BrokerRestart, f.context),
            (error) => {
                assert.equal(
                    error.failureProperty,
                    PROCESS_FAULT_PROPERTY.BrokerRetained,
                );
                assert.equal(error.simulation.reachedFaultBoundary, true);
                return true;
            },
        );
        assert.deepEqual(f.actions.at(-1), ["signal", 10001, "SIGCONT"]);
    }
});

test("different or reused production process cannot count as recovery", async () => {
    for (const options of [{ samePid: true }, { wrongArtifact: true }]) {
        const f = processFixture(options);
        await assert.rejects(
            executeProcessFault(PROCESS_FAULT_KIND.OffchainRestart, f.context),
            (error) => {
                assert.equal(
                    error.failureProperty,
                    PROCESS_FAULT_PROPERTY.Restarted,
                );
                return true;
            },
        );
    }
});

test("empty broker does not replace the actual ingestion or durable-demand assertions", async () => {
    for (const [options, property] of [
        [{ missingObservation: true }, PROCESS_FAULT_PROPERTY.Recovered],
        [{ missingCanonicalChange: true }, PROCESS_FAULT_PROPERTY.Recovered],
        [{ pendingDemand: true }, PROCESS_FAULT_PROPERTY.Converged],
    ]) {
        const f = processFixture(options);
        await assert.rejects(
            executeProcessFault(PROCESS_FAULT_KIND.OffchainRestart, f.context),
            (error) => {
                assert.equal(error.failureProperty, property);
                assert.equal(error.simulation.reachedFaultBoundary, true);
                return true;
            },
        );
    }
});

test("shared runtime identity guard requires actual registry membership and liveness", () => {
    const f = processFixture();
    const identity = {
        pid: 9999,
        artifact: f.original.artifact,
        filename: f.original.filename,
    };
    assert.doesNotThrow(() =>
        assertRestartedRuntime(identity, f.original, f.context.processes),
    );
    assert.throws(
        () => assertRestartedRuntime(identity, f.original, []),
        /liveness checks/,
    );
    f.original.intentionallyStopped = true;
    assert.throws(
        () => assertRestartedRuntime(identity, f.original, f.context.processes),
        /liveness checks/,
    );
});

test("a prior raw audit row cannot stand in for recovery of a fresh input", async () => {
    const f = processFixture();
    f.state.observations.push({
        order_id: f.input.orderId,
        source_event_at: f.input.sourceEventAt,
    });
    await assert.rejects(
        executeProcessFault(PROCESS_FAULT_KIND.OffchainRestart, f.context),
        /earlier ingestion cannot prove recovery/,
    );
    assert.ok(!f.actions.some((action) => action[0] === "stop"));
});

test("unsupported process faults fail before touching real runtime handles", async () => {
    const f = processFixture();
    await assert.rejects(
        executeProcessFault("future-native-recovery", f.context),
        /Unsupported/,
    );
    await assert.rejects(
        executeProcessFault(
            { kind: PROCESS_FAULT_KIND.OffchainRestart, timeoutMs: Infinity },
            f.context,
        ),
        /bounded/,
    );
    assert.equal(f.actions.length, 0);
});
