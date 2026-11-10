import assert from "node:assert/strict";
import {
    assertRestartedRuntime,
    withRetainedRawInput,
} from "./process-faults.mjs";
import {
    PRODUCTION_RUNTIME_PROCESSES,
    PRODUCTION_STARTUP_MAINTENANCE,
} from "./runtime-manifest.mjs";

export const STARTUP_LIFECYCLE_KIND = "startup-maintenance";
export const STARTUP_LIFECYCLE_PROPERTY = Object.freeze({
    Fixture: "nonempty-operator-declaration-fixture",
    Stopped: "complete-runtime-stopped",
    CoverageFixture: "nonempty-completed-validation-coverage",
    Maintenance: "production-startup-maintenance-completed",
    CoverageRetained: "completed-validation-coverage-retained",
    Retained: "maintenance-preserves-retained-input",
    Restarted: "complete-production-runtime-restarted",
    Preserved: "operator-declarations-and-commands-preserved",
});

const DECLARATION_SCOPES = Object.freeze([
    "collections",
    "tradingJobs",
    "priceTiers",
    "tradingCommands",
]);
const isLive = (entry) =>
    entry.child.exitCode === null && entry.child.signalCode === null;

function assertDeclarations(snapshot) {
    assert.ok(
        snapshot && typeof snapshot === "object",
        "Read-only operator declarations are required",
    );
    for (const scope of DECLARATION_SCOPES)
        assert.ok(
            Array.isArray(snapshot[scope]) && snapshot[scope].length > 0,
            `Lifecycle preservation requires nonempty ${scope}; an empty fixture cannot earn coverage`,
        );
}

async function observeValidationCoverage(context) {
    const snapshot = await context.observe();
    assert.ok(
        Array.isArray(snapshot?.orders) &&
            Array.isArray(snapshot?.validationProofs),
        "Read-only canonical orders and saved validation coverage are required",
    );
    return structuredClone({
        orders: snapshot.orders,
        validationProofs: snapshot.validationProofs,
    });
}

function completedCoverage(snapshot) {
    const orders = new Set(snapshot.orders.map((order) => order.id));
    return snapshot.validationProofs.filter(
        (proof) =>
            orders.has(proof.order_id) &&
            proof.pending === 0 &&
            Number.isSafeInteger(proof.proof_revision) &&
            proof.proof_at > 0 &&
            Number.isSafeInteger(proof.proof_block) &&
            Number.isSafeInteger(proof.proof_chain_revision),
    );
}

/**
 * Start with actual user-authored job/tier input through backend HTTP. Capture
 * only declared fields and pending trading commands through observeDeclarations;
 * omit source freshness, heartbeats and other independently changing projections.
 *
 * runOneShot(spec) launches the listed production artifact with its normal env
 * and no CLI overrides. Return {artifact,filename,code,signal,timedOut,outputLimit,
 * stdoutPath,stderrPath}; logs must be retained separately for each execution.
 */
export async function executeStartupMaintenance(
    context,
    { timeoutMs = 180_000 } = {},
) {
    for (const name of [
        "restartProcess",
        "runOneShot",
        "observeDeclarations",
        "observe",
    ])
        assert.equal(
            typeof context?.[name],
            "function",
            `Startup lifecycle requires ${name}`,
        );
    assert.ok(
        Array.isArray(context.processes),
        "The production process registry is required",
    );
    const required = PRODUCTION_RUNTIME_PROCESSES;
    const ids = context.processes.map((entry) => entry.id);
    assert.equal(
        new Set(ids).size,
        ids.length,
        "Runtime process identities cannot repeat",
    );
    assert.deepEqual(
        [...ids].sort(),
        required.map((entry) => entry.id).sort(),
        "The complete declared runtime set is required",
    );
    const originals = required.map((spec) => {
        const entry = context.processes.find(
            (candidate) => candidate.id === spec.id,
        );
        assert.ok(
            isLive(entry) && !entry.intentionallyStopped,
            "Every initial production actor must be active",
        );
        assert.equal(
            entry.artifact,
            spec.artifact,
            "Lifecycle must exercise the actual production artifact",
        );
        return {
            id: entry.id,
            pid: entry.child.pid,
            artifact: entry.artifact,
            filename: entry.filename,
            child: entry.child,
        };
    });
    const maintenance = context.startupMaintenance;
    assert.ok(
        Array.isArray(maintenance),
        "The concrete startup maintenance artifacts are required",
    );
    assert.deepEqual(
        maintenance.map(({ id, artifact }) => ({ id, artifact })),
        PRODUCTION_STARTUP_MAINTENANCE,
        "SQLite then NATS maintenance must use their owning production entrypoints",
    );
    let declarations;
    let evidence;
    let phase = STARTUP_LIFECYCLE_PROPERTY.Fixture;
    try {
        declarations = structuredClone(await context.observeDeclarations());
        assertDeclarations(declarations);
        evidence = await withRetainedRawInput(
            context,
            async (boundary) => {
                const { input, before, evidence: current, record } = boundary;
                phase = current.phase = STARTUP_LIFECYCLE_PROPERTY.Stopped;
                for (const identity of [...originals].reverse()) {
                    const entry = context.processes.find(
                        (candidate) => candidate.id === identity.id,
                    );
                    entry.intentionallyStopped = true;
                    await context.stopProcess(identity.child, "SIGKILL");
                    assert.ok(
                        identity.child.exitCode !== null ||
                            identity.child.signalCode !== null,
                        "Every production process must actually exit before maintenance",
                    );
                }
                record(STARTUP_LIFECYCLE_PROPERTY.Stopped, {
                    actors: originals.map(({ id, pid }) => ({ id, pid })),
                });
                phase = current.phase =
                    STARTUP_LIFECYCLE_PROPERTY.CoverageFixture;
                const coverage = (current.coverageRetention = {
                    before: await observeValidationCoverage(context),
                });
                const completed = completedCoverage(coverage.before);
                assert.ok(
                    completed.length > 0,
                    "Startup retention requires nonempty completed validation coverage before maintenance",
                );
                record(STARTUP_LIFECYCLE_PROPERTY.CoverageFixture, {
                    orderIds: completed.map((proof) => proof.order_id),
                });
                phase = current.phase = STARTUP_LIFECYCLE_PROPERTY.Maintenance;
                const outputs = new Set();
                current.maintenance = [];
                for (const spec of maintenance) {
                    assert.ok(
                        typeof spec.filename === "string" &&
                            spec.filename.length > 0,
                        "Startup maintenance needs its actual executable artifact path",
                    );
                    const result = await context.runOneShot(spec);
                    assert.equal(
                        result?.artifact,
                        spec.artifact,
                        "One-shot result must identify the artifact actually executed",
                    );
                    assert.equal(
                        result.filename,
                        spec.filename,
                        "One-shot result must identify the actual entrypoint",
                    );
                    assert.ok(
                        result.code === 0 &&
                            result.signal === null &&
                            result.timedOut === false &&
                            result.outputLimit === false,
                        "Production startup maintenance must finish successfully with an explicit execution result",
                    );
                    for (const name of ["stdoutPath", "stderrPath"]) {
                        assert.ok(
                            typeof result[name] === "string" &&
                                result[name].length > 0 &&
                                !outputs.has(result[name]),
                            "Each production one-shot must retain its own output files",
                        );
                        outputs.add(result[name]);
                    }
                    current.maintenance.push(structuredClone(result));
                }
                record(STARTUP_LIFECYCLE_PROPERTY.Maintenance, {
                    artifacts: maintenance.map((spec) => spec.artifact),
                });
                phase = current.phase =
                    STARTUP_LIFECYCLE_PROPERTY.CoverageRetained;
                coverage.after = await observeValidationCoverage(context);
                const retainedOrders = new Set(
                    coverage.after.orders.map((order) => order.id),
                );
                const retained = completed.filter((proof) =>
                    retainedOrders.has(proof.order_id),
                );
                coverage.retainedOrderIds = retained.map(
                    (proof) => proof.order_id,
                );
                coverage.removedOrderIds = completed
                    .filter((proof) => !retainedOrders.has(proof.order_id))
                    .map((proof) => proof.order_id);
                assert.ok(
                    retained.length > 0,
                    "Startup retention requires completed coverage for at least one retained canonical order",
                );
                for (const proof of retained)
                    assert.deepEqual(
                        coverage.after.validationProofs.find(
                            (candidate) =>
                                candidate.order_id === proof.order_id,
                        ),
                        proof,
                        `Maintenance must preserve saved completed validation coverage unchanged for retained order ${proof.order_id}`,
                    );
                record(STARTUP_LIFECYCLE_PROPERTY.CoverageRetained, {
                    orderIds: coverage.retainedOrderIds,
                    removedOrderIds: coverage.removedOrderIds,
                });
                phase = current.phase = STARTUP_LIFECYCLE_PROPERTY.Retained;
                const pending = await context.queueState(input);
                assert.ok(
                    pending.matchingInputRetained === true &&
                        pending.pending + pending.ackPending > 0,
                    "Startup maintenance must preserve the pending external input",
                );
                assert.equal(pending.stream, before.stream);
                assert.equal(
                    pending.retainedSequence,
                    before.retainedSequence,
                    "Maintenance cannot replace retained work with a fresh publication",
                );
                record(STARTUP_LIFECYCLE_PROPERTY.Retained, { queue: pending });
                phase = current.phase = STARTUP_LIFECYCLE_PROPERTY.Restarted;
                current.restarted = [];
                for (const identity of originals) {
                    const replacement = await context.restartProcess(
                        identity.id,
                    );
                    assertRestartedRuntime(
                        identity,
                        replacement,
                        context.processes,
                    );
                    current.restarted.push({
                        id: identity.id,
                        previousPid: identity.pid,
                        pid: replacement.child.pid,
                        artifact: replacement.artifact,
                    });
                }
                record(STARTUP_LIFECYCLE_PROPERTY.Restarted, {
                    actors: current.restarted,
                });
                // Reopened source workers are real, but the finite test input must
                // close again before asserting durable work convergence.
                await context.closeSources();
            },
            { kind: STARTUP_LIFECYCLE_KIND, timeoutMs },
        );
        phase = evidence.phase = STARTUP_LIFECYCLE_PROPERTY.Preserved;
        const after = structuredClone(await context.observeDeclarations());
        assertDeclarations(after);
        assert.deepEqual(
            after,
            declarations,
            "Startup and process recovery must preserve declared collection/job/tier state and pending trading commands",
        );
        evidence.declarations = {
            before: declarations,
            after,
            counts: Object.fromEntries(
                DECLARATION_SCOPES.map((scope) => [
                    scope,
                    declarations[scope].length,
                ]),
            ),
        };
        evidence.events.push({
            sequence: evidence.events.length + 1,
            event: STARTUP_LIFECYCLE_PROPERTY.Preserved,
        });
        return evidence;
    } catch (error) {
        error.failureProperty ??= phase;
        error.simulation = {
            ...(error.simulation ?? {}),
            failureProperty: error.failureProperty,
            lifecycle: evidence ??
                error.simulation?.processFault ?? {
                    kind: STARTUP_LIFECYCLE_KIND,
                    phase,
                    declarations,
                },
        };
        throw error;
    }
}
