import assert from "node:assert/strict";
import test from "node:test";
import {
    executeStartupMaintenance,
    STARTUP_LIFECYCLE_PROPERTY,
} from "./lifecycle.mjs";
import {
    PRODUCTION_RUNTIME_PROCESSES,
    PRODUCTION_STARTUP_MAINTENANCE,
    RUNTIME_PROCESS,
} from "./runtime-manifest.mjs";
import { processFixture } from "./fixtures/process-control-fixture.mjs";

// Guard/ordering tests only; execution of real maintenance belongs to the VM.
function fixture(options = {}) {
    const f = processFixture();
    const originals = PRODUCTION_RUNTIME_PROCESSES.map((spec, index) => ({
        ...spec,
        filename: `/workbench/runtime/${spec.artifact}`,
        child:
            spec.id === RUNTIME_PROCESS.OffchainIngest
                ? f.original.child
                : f.createChild(10100 + index),
    }));
    f.context.processes.splice(0, 1, ...originals);
    let nextPid = 30000;
    let maintenanceCalls = 0;
    const declarations = {
        collections: [{ collection_id: 1, slug: "simulation-two-tokens" }],
        tradingJobs: [
            {
                job_id: "operator-job",
                status: "paused",
                floor_wei: "120000000000000000",
            },
        ],
        priceTiers: [
            {
                tier_id: "operator-tier",
                name: "simulation-intent",
                floor_config_json: '{"kind":"fixed","valueEth":"0.12"}',
            },
        ],
        tradingCommands: [
            {
                command_id: 1,
                job_id: "operator-job",
                status: "pending",
                requested_revision: 1,
            },
        ],
    };
    if (options.emptyIntent) declarations.priceTiers = [];
    f.context.observeDeclarations = async () => declarations;
    f.context.startupMaintenance = PRODUCTION_STARTUP_MAINTENANCE.map(
        (spec) => ({
            ...spec,
            filename: `/workbench/runtime/${spec.artifact}`,
        }),
    );
    f.context.restartProcess = async (id) => {
        const index = f.context.processes.findIndex((entry) => entry.id === id);
        const before = f.context.processes[index];
        const replacement = {
            ...before,
            intentionallyStopped: false,
            child: f.createChild(++nextPid),
        };
        if (options.wrongRestart && id === RUNTIME_PROCESS.Sync)
            replacement.artifact = "wrong-runtime.mjs";
        f.context.processes.splice(index, 1, replacement);
        if (id === RUNTIME_PROCESS.OffchainIngest) f.finishInput();
        return replacement;
    };
    f.context.runOneShot = async (spec) => {
        assert.ok(
            originals.every((entry) => entry.child.signalCode !== null),
            "Maintenance must run after every original actor exits",
        );
        maintenanceCalls++;
        f.actions.push(["maintenance", spec.id]);
        if (maintenanceCalls === 2 && options.rewriteIntent)
            declarations.tradingJobs[0].floor_wei = "1";
        return {
            artifact: spec.artifact,
            filename: spec.filename,
            code: options.failedMaintenance ? 1 : 0,
            signal: null,
            timedOut: false,
            outputLimit: false,
            stdoutPath: `/workbench/output/${options.duplicateLogs ? "duplicate" : spec.id}.stdout.log`,
            stderrPath: `/workbench/output/${options.duplicateLogs ? "duplicate" : spec.id}.stderr.log`,
        };
    };
    if (options.lostPending) {
        const read = f.context.queueState;
        f.context.queueState = async (input) => ({
            ...(await read(input)),
            ...(maintenanceCalls === 2 ? { matchingInputRetained: false } : {}),
        });
    }
    return { ...f, originals, declarations };
}

test("complete runtime restart invokes real-artifact maintenance in order and preserves nonempty declared intent", async () => {
    const f = fixture();
    const evidence = await executeStartupMaintenance(f.context);
    assert.equal(
        evidence.restarted.length,
        PRODUCTION_RUNTIME_PROCESSES.length,
    );
    assert.deepEqual(
        evidence.maintenance.map((item) => item.artifact),
        PRODUCTION_STARTUP_MAINTENANCE.map((item) => item.artifact),
    );
    assert.deepEqual(evidence.declarations.before, evidence.declarations.after);
    assert.ok(
        Object.values(evidence.declarations.counts).every((count) => count > 0),
    );
    assert.equal(evidence.finalQueue.streamMessages, 0);
    assert.ok(
        evidence.restarted.every((actor) => actor.pid !== actor.previousPid),
    );
    assert.equal(
        f.actions.filter((action) => action[0] === "sources-closed").length,
        2,
    );
});

test("an empty declaration fixture cannot qualify startup preservation", async () => {
    const f = fixture({ emptyIntent: true });
    await assert.rejects(executeStartupMaintenance(f.context), (error) => {
        assert.equal(error.failureProperty, STARTUP_LIFECYCLE_PROPERTY.Fixture);
        return /nonempty priceTiers/.test(error.message);
    });
    assert.equal(f.actions.length, 0);
});

test("startup failure and overwritten one-shot logs retain their failed property", async () => {
    for (const options of [
        { failedMaintenance: true },
        { duplicateLogs: true },
    ]) {
        const f = fixture(options);
        await assert.rejects(executeStartupMaintenance(f.context), (error) => {
            assert.equal(
                error.failureProperty,
                STARTUP_LIFECYCLE_PROPERTY.Maintenance,
            );
            assert.equal(error.simulation.reachedFaultBoundary, true);
            return true;
        });
    }
});

test("startup cleanup cannot silently discard retained raw input", async () => {
    const f = fixture({ lostPending: true });
    await assert.rejects(executeStartupMaintenance(f.context), (error) => {
        assert.equal(
            error.failureProperty,
            STARTUP_LIFECYCLE_PROPERTY.Retained,
        );
        return /preserve the pending external input/.test(error.message);
    });
});

test("a materially changed job remains a failure even when a probe reuses its object", async () => {
    const f = fixture({ rewriteIntent: true });
    await assert.rejects(executeStartupMaintenance(f.context), (error) => {
        assert.equal(
            error.failureProperty,
            STARTUP_LIFECYCLE_PROPERTY.Preserved,
        );
        return /preserve declared/.test(error.message);
    });
});

test("missing actors, wrong runtime and reordered maintenance cannot qualify a complete startup", async () => {
    const missing = fixture();
    missing.context.processes.pop();
    await assert.rejects(
        executeStartupMaintenance(missing.context),
        /complete declared runtime/,
    );
    const wrong = fixture({ wrongRestart: true });
    await assert.rejects(executeStartupMaintenance(wrong.context), (error) => {
        assert.equal(
            error.failureProperty,
            STARTUP_LIFECYCLE_PROPERTY.Restarted,
        );
        return true;
    });
    const reordered = fixture();
    reordered.context.startupMaintenance.reverse();
    await assert.rejects(
        executeStartupMaintenance(reordered.context),
        /SQLite then NATS/,
    );
});
