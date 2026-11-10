import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createArtifactRunDirectory } from "../artifacts.mjs";
import { RUNTIME_PROCESS } from "./runtime-manifest.mjs";
import { RUNTIME_READY_MESSAGE } from "../../../shared/runtime/readiness.ts";
import { RUNTIME_EXIT_FIXTURE_ENV } from "./fixtures/runtime-exit-fixture.mjs";
import {
    RuntimeProcessExit,
    findRuntimeProcessExit,
    RUNTIME_PROCESS_PROPERTY,
    launchRuntime,
} from "./runtime-process.mjs";

test("runtime exit identity survives wrappers and cycle-safe cause traversal without classifying ordinary errors", () => {
    const exit = new RuntimeProcessExit({
        actorId: "domain",
        pid: 154,
        signal: "SIGSEGV",
    });
    const wrapped = new Error("stale cut cannot continue", { cause: exit });
    assert.equal(findRuntimeProcessExit(wrapped), exit);
    assert.equal(exit.property, RUNTIME_PROCESS_PROPERTY.Liveness);
    assert.equal(exit.actorId, "domain");
    assert.equal(exit.signal, "SIGSEGV");
    assert.equal(exit.pid, 154);
    const diagnostic = Object.assign(new Error("Actual oracle failed"), {
        simulation: { processStates: [{ signalCode: "SIGSEGV" }] },
    });
    diagnostic.cause = diagnostic;
    assert.equal(findRuntimeProcessExit(diagnostic), undefined);
});

test("the real launch lifecycle observes readiness then types a harmless owned Node exit 17", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const directory = await createArtifactRunDirectory(
        path.join(root, "tmp/simulation-runtime-process-tests"),
        "exit-",
    );
    const gate = path.join(directory, "exit-gate");
    const entry = await launchRuntime(
        {
            id: RUNTIME_PROCESS.Domain,
            filename: fileURLToPath(
                new URL("./fixtures/runtime-exit-fixture.mjs", import.meta.url),
            ),
            readyMessage: RUNTIME_READY_MESSAGE.DomainWorker,
        },
        {
            root: directory,
            output: directory,
            env: { ...process.env, [RUNTIME_EXIT_FIXTURE_ENV]: gate },
            eventually: async (check) => {
                const deadline = Date.now() + 3000;
                while (Date.now() < deadline) {
                    if (await check()) return;
                    await delay(5);
                }
                throw new Error("Harmless fixture did not become ready");
            },
        },
    );
    const closed = once(entry.child, "exit");
    await writeFile(gate, "exit");
    const [code, signal] = await closed;
    assert.equal(code, 17);
    assert.equal(signal, null);
    assert.throws(
        () => entry.assertAlive(),
        (error) =>
            error instanceof RuntimeProcessExit &&
            error.actorId === RUNTIME_PROCESS.Domain &&
            error.pid === entry.child.pid &&
            error.exitCode === 17 &&
            error.signal === null,
    );
});
