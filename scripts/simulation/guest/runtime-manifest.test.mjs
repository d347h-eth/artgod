import assert from "node:assert/strict";
import test from "node:test";
import {
    RUNTIME_READY_MESSAGE,
    isRuntimeReadyLog,
} from "../../../shared/runtime/readiness.ts";
import {
    PRODUCTION_RUNTIME_PROCESSES,
    PRODUCTION_BOOTSTRAP_PROCESSES,
    resolveRuntimeLayout,
} from "./runtime-manifest.mjs";

test("every selected long-running production actor uses its owning structured readiness signal", () => {
    const actors = [
        ...PRODUCTION_RUNTIME_PROCESSES,
        ...PRODUCTION_BOOTSTRAP_PROCESSES,
    ];
    assert.equal(new Set(actors.map(({ id }) => id)).size, actors.length);
    for (const actor of actors) {
        assert.ok(
            Object.values(RUNTIME_READY_MESSAGE).includes(actor.readyMessage),
        );
        assert.ok(
            isRuntimeReadyLog(
                JSON.stringify({
                    level: "info",
                    msg: actor.readyMessage,
                    component: "actual-runtime",
                }),
                actor.readyMessage,
            ),
        );
    }
    const layout = resolveRuntimeLayout("/workbench");
    assert.deepEqual(
        layout.processes.map(({ readyMessage }) => readyMessage),
        PRODUCTION_RUNTIME_PROCESSES.map(({ readyMessage }) => readyMessage),
    );
});

test("quoted errors, another actor and plain output cannot falsely acknowledge production startup", () => {
    const expected = RUNTIME_READY_MESSAGE.DomainWorker;
    for (const line of [
        expected,
        JSON.stringify({ level: "error", msg: expected }),
        JSON.stringify({
            level: "info",
            msg: RUNTIME_READY_MESSAGE.SyncWorker,
        }),
        JSON.stringify({
            level: "info",
            msg: "Worker startup failed",
            error: expected,
        }),
        JSON.stringify({
            level: "info",
            msg: `Earlier log contained ${expected}`,
        }),
        "Applied migration: schema.sql",
    ])
        assert.equal(isRuntimeReadyLog(line, expected), false);
});
