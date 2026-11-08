import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    DOCKER_OWNER_LABEL,
    runOwnedContainer,
    withOwnedContainer,
} from "./docker.mjs";
import { executeCommand } from "./qemu-replay.mjs";
import { readInputPins } from "./input-pins.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const IMAGE = (await readInputPins()).builderImage;
const okay = (stdout = "") => ({
    code: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
});

async function fixture(problem) {
    const parent = path.join(ROOT, "tmp", "simulation-docker-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "run-"));
    const daemon = new Map();
    const calls = [];
    let name;
    const execute = async (_binary, args) => {
        calls.push(args);
        if (args[0] === "create") {
            name = args[args.indexOf("--name") + 1];
            const token = args[args.indexOf("--label") + 1].slice(
                DOCKER_OWNER_LABEL.length + 1,
            );
            daemon.set(name, {
                token: problem === "foreign" ? "another-owner" : token,
                running: false,
            });
            await writeFile(
                args[args.indexOf("--cidfile") + 1],
                "a".repeat(64),
            );
            if (problem === "lost-create") return { ...okay(), timedOut: true };
            if (problem === "foreign")
                return { ...okay(), code: 125, stderr: "Name already exists" };
            return okay(`${"a".repeat(64)}\n`);
        }
        if (args[0] === "inspect") {
            const record = daemon.get(args.at(-1));
            return record
                ? okay(JSON.stringify({ [DOCKER_OWNER_LABEL]: record.token }))
                : { ...okay(), code: 1, stderr: "No such object" };
        }
        if (args[0] === "start") {
            daemon.get(args.at(-1)).running = true;
            return problem === "timeout"
                ? { ...okay(), timedOut: true }
                : okay("workload output\n");
        }
        if (args[0] === "rm") {
            daemon.delete(args.at(-1));
            return okay();
        }
        if (args[0] === "cp" || args[0] === "export") return okay();
        throw new Error(`Unexpected Docker action ${args[0]}`);
    };
    return {
        directory,
        daemon,
        calls,
        execute,
        get name() {
            return name;
        },
        options: {
            image: IMAGE,
            command: ["node", "--version"],
            artifactParent: directory,
            execute,
        },
    };
}

test("lost create replies and timed-out attached clients still clean the owned daemon container", async () => {
    for (const problem of ["lost-create", "timeout"]) {
        const f = await fixture(problem);
        let failure;
        await assert.rejects(runOwnedContainer(f.options), (error) => {
            failure = error;
            return /timeout/.test(error.message);
        });
        assert.equal(f.daemon.size, 0);
        assert.deepEqual(
            f.calls.filter((args) => args[0] === "rm"),
            [["rm", "--force", f.name]],
        );
        const descriptor = JSON.parse(
            await readFile(
                path.join(failure.artifactsDirectory, "container.json"),
                "utf8",
            ),
        );
        assert.equal(descriptor.cleanup, "removed");
        assert.equal(descriptor.phase, "failed");
        assert.equal(descriptor.containerId, "a".repeat(64));
    }
});

test("foreign ownership prevents execution and deletion even when create returns a conflicting name", async () => {
    const f = await fixture("foreign");
    await assert.rejects(
        runOwnedContainer(f.options),
        /without the matching simulation owner label/,
    );
    assert.equal(f.daemon.size, 1);
    assert.ok(!f.calls.some((args) => ["rm", "start"].includes(args[0])));
});

test("callback failure retains diagnostics and removes only its named owned container", async () => {
    const f = await fixture();
    await assert.rejects(
        withOwnedContainer(f.options, async () => {
            throw new Error("fixture failed during export");
        }),
        /fixture failed during export/,
    );
    assert.equal(f.daemon.size, 0);
    assert.ok(
        f.calls.every(
            (args) => !args.includes("prune") && !args.includes("--all"),
        ),
    );
});

test("mounts default read-only and reject paths outside this worktree before any Docker action", async () => {
    const f = await fixture();
    const source = path.join(f.directory, "mount");
    await mkdir(source);
    await runOwnedContainer({
        ...f.options,
        mounts: [{ source, target: "/fixture" }],
        workdir: "/fixture",
    });
    const created = f.calls.find((args) => args[0] === "create");
    assert.ok(created[created.indexOf("--mount") + 1].endsWith(",readonly"));
    assert.equal(created[created.indexOf("--network") + 1], "none");
    assert.ok(created.includes("--pull=never"));
    assert.ok(created.includes("--read-only"));
    const bad = await fixture();
    await assert.rejects(
        runOwnedContainer({
            ...bad.options,
            mounts: [{ source: "/etc", target: "/fixture" }],
        }),
        /inside this worktree/,
    );
    await assert.rejects(
        runOwnedContainer({
            ...bad.options,
            mounts: [{ source, target: "/proc" }],
        }),
        /ordinary absolute targets/,
    );
    assert.equal(bad.calls.length, 0);
});

test("stopped image copying uses owned metadata and cannot overwrite a retained artifact", async () => {
    const f = await fixture();
    const destination = path.join(f.directory, "existing");
    await writeFile(destination, "retain me");
    await assert.rejects(
        withOwnedContainer(
            { ...f.options, command: ["/bin/true"] },
            (container) => container.copyFrom("/kernel", destination),
        ),
        /cannot overwrite/,
    );
    assert.equal(f.daemon.size, 0);
    assert.equal(await readFile(destination, "utf8"), "retain me");
    assert.ok(!f.calls.some((args) => args[0] === "cp"));
});

test("a real daemon workload ignoring termination is removed after the attached Docker client times out", async () => {
    const f = await fixture();
    let observedRunning = false;
    const execute = async (binary, args, options) => {
        const result = await executeCommand(binary, args, options);
        if (args[0] === "start" && result.timedOut) {
            const state = await executeCommand(
                "docker",
                ["inspect", "--format", "{{.State.Running}}", args.at(-1)],
                { env: process.env, timeoutMs: 15_000 },
            );
            observedRunning = state.stdout.trim() === "true";
        }
        return result;
    };
    let failure;
    await assert.rejects(
        runOwnedContainer({
            image: IMAGE,
            artifactParent: f.directory,
            timeoutMs: 1000,
            execute,
            command: [
                "node",
                "-e",
                "process.on('SIGTERM',()=>{}); console.log('container-ready'); setInterval(()=>{},1000)",
            ],
        }),
        (error) => {
            failure = error;
            return /timeout/.test(error.message);
        },
    );
    assert.equal(observedRunning, true);
    const descriptor = JSON.parse(
        await readFile(
            path.join(failure.artifactsDirectory, "container.json"),
            "utf8",
        ),
    );
    assert.equal(descriptor.cleanup, "removed");
    const absent = await executeCommand(
        "docker",
        ["inspect", descriptor.name],
        { env: process.env, timeoutMs: 15_000 },
    );
    assert.notEqual(absent.code, 0);
    assert.match(absent.stderr, /No such (object|container)/i);
});
