import assert from "node:assert/strict";
import {
    mkdir,
    mkdtemp,
    readFile,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
    DEFAULT_INPUT_PINS,
    parseProvisionArguments,
    provisionInputs,
    validateInputPins,
} from "./provision-inputs.mjs";
import { validateBuildConfiguration } from "./build-guest.mjs";
import { DOCKER_OWNER_LABEL } from "./docker.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const pins = JSON.parse(await readFile(DEFAULT_INPUT_PINS, "utf8"));

async function fixture(options = {}) {
    const parent = path.join(ROOT, "tmp/simulation-provision-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "run-"));
    const files = {};
    for (const [key, filename] of [
        ["qemu", "qemu"],
        ["qemuImg", "qemu-img"],
        ["firmware", "firmware"],
    ]) {
        files[key] = path.join(directory, filename);
        await writeFile(files[key], `Synthetic ${key} unit-test input`);
    }
    files.scenarioFile = path.join(directory, "scenario.json");
    await writeFile(
        files.scenarioFile,
        await readFile(
            new URL("./scenarios/qualification.json", import.meta.url),
        ),
    );
    const commands = [];
    const owned = [];
    const labels = new Map();
    const execute = async (binary, args, executionOptions) => {
        assert.equal(binary, "docker");
        commands.push([...args]);
        if (executionOptions.stdoutPath)
            assert.ok(executionOptions.stdoutPath.startsWith(directory));
        assert.ok(
            executionOptions.cwd === ROOT ||
                executionOptions.cwd.startsWith(directory),
        );
        if (args[0] === "pull" && options.pullFailure)
            return { code: 1, stdout: "" };
        if (args[0] === "image")
            return { code: 0, stdout: `${options.architecture ?? "amd64"}\n` };
        if (args[0] === "create") {
            const id = (owned.length + 1).toString(16).padStart(64, "0");
            const name = args[args.indexOf("--name") + 1];
            owned.push(name);
            const label = args[args.indexOf("--label") + 1];
            labels.set(name, label.slice(`${DOCKER_OWNER_LABEL}=`.length));
            await writeFile(args[args.indexOf("--cidfile") + 1], id);
            return { code: 0, stdout: `${id}\n` };
        }
        if (args[0] === "inspect")
            return {
                code: 0,
                stdout: JSON.stringify({
                    [DOCKER_OWNER_LABEL]: labels.get(args.at(-1)),
                }),
            };
        if (args[0] === "cp") {
            assert.ok(owned.some((id) => args[1].startsWith(`${id}:`)));
            if (options.copyFailure) return { code: 1, stdout: "" };
            if (options.copySymlink) await symlink(files.qemu, args[2]);
            else await writeFile(args[2], `Synthetic extracted ${args[1]}`);
        }
        if (args[0] === "rm") assert.ok(owned.includes(args.at(-1)));
        return { code: 0, stdout: "" };
    };
    return {
        directory,
        commands,
        owned,
        options: {
            ...files,
            outputRoot: path.join(directory, "outputs"),
            execute,
        },
    };
}

test("portable pin owner rejects mutable images, ambiguous extraction and unknown fields", () => {
    assert.deepEqual(validateInputPins(pins), pins);
    assert.equal(pins.machine, "pc-i440fx-8.2");
    assert.throws(
        () => validateInputPins({ ...pins, runtimeImage: "node:latest" }),
        /immutable/,
    );
    assert.throws(
        () =>
            validateInputPins({
                ...pins,
                kernel: { ...pins.kernel, path: "/x/../kernel" },
            }),
        /normalized/,
    );
    assert.throws(
        () =>
            validateInputPins({
                ...pins,
                kernel: { ...pins.kernel, path: "/kernel\nignored" },
            }),
        /normalized/,
    );
    assert.throws(
        () => validateInputPins({ ...pins, dockerHost: "user-service" }),
        /exactly/,
    );
    assert.throws(
        () => validateInputPins({ ...pins, machine: "pc" }),
        /versioned/,
    );
    assert.throws(
        () => validateInputPins({ ...pins, cpu: "host" }),
        /cpu model/,
    );
    const { cpu, ...missingCpu } = pins;
    assert.throws(() => validateInputPins(missingCpu), /exactly/);
    assert.throws(
        () => validateInputPins({ ...pins, architecture: "arm64" }),
        /amd64/,
    );
});

test("explicit CLI cannot infer service tools, scenario or arbitrary Docker arguments", () => {
    const args = [
        "--qemu",
        "/usr/bin/qemu",
        "--qemu-img",
        "/usr/bin/qemu-img",
        "--firmware",
        "/usr/share/firmware",
        "--scenario",
        "case.json",
    ];
    assert.equal(parseProvisionArguments(args).scenarioFile, "case.json");
    assert.throws(() => parseProvisionArguments([]), /Explicit/);
    assert.throws(
        () => parseProvisionArguments([...args, "--qemu", "other"]),
        /unique/,
    );
    assert.throws(
        () =>
            parseProvisionArguments([...args, "--docker-args", "--privileged"]),
        /unique/,
    );
});

test("provisioning uses only pinned images and fresh stopped containers, then emits actual builder contract", async () => {
    const f = await fixture();
    const result = await provisionInputs(f.options);
    assert.deepEqual(
        validateBuildConfiguration(
            JSON.parse(await readFile(result.buildConfigPath, "utf8")),
        ),
        result.buildConfig,
    );
    assert.equal(
        f.commands.filter((command) => command[0] === "pull").length,
        5,
    );
    assert.equal(result.buildConfig.cpu, pins.cpu);
    assert.equal(
        f.commands.filter((command) => command[0] === "create").length,
        2,
    );
    assert.deepEqual(
        f.commands
            .filter((command) => command[0] === "rm")
            .map((command) => command.at(-1)),
        f.owned,
    );
    for (const command of f.commands.filter(
        (command) => command[0] === "create",
    )) {
        assert.ok(command.includes("--read-only"));
        assert.deepEqual(
            command.slice(
                command.indexOf("--network"),
                command.indexOf("--network") + 2,
            ),
            ["--network", "none"],
        );
    }
    assert.ok(
        !f.commands.some(
            (command) =>
                ["run", "exec", "start"].includes(command[0]) ||
                command.some((argument) =>
                    ["--mount", "--volume", "--privileged"].includes(argument),
                ),
        ),
    );
    assert.equal(
        (await stat(path.join(result.directory, "nats-server"))).mode & 0o777,
        0o755,
    );
    const provenance = JSON.parse(
        await readFile(path.join(result.directory, "provenance.json"), "utf8"),
    );
    assert.equal(provenance.extracted.kernel.path, "kernel");
    assert.match(provenance.extracted.kernel.sha256, /^[a-f0-9]{64}$/);
    assert.match(provenance.qualification, /unqualified/);
});

test("preflight refuses missing explicit files and unsafe output locations before image mutation", async () => {
    const f = await fixture();
    await assert.rejects(
        provisionInputs({ ...f.options, qemu: undefined }),
        /explicit QEMU/,
    );
    assert.equal(f.commands.length, 0);
    await assert.rejects(
        provisionInputs({
            ...f.options,
            outputRoot: "/tmp/escaped-simulation-inputs",
        }),
        /worktree tmp/,
    );
    assert.equal(f.commands.length, 0);
});

test("extraction failure still removes precisely the newly created stopped container", async () => {
    const f = await fixture({ copyFailure: true });
    await assert.rejects(provisionInputs(f.options), /Docker copy failed/);
    assert.equal(f.owned.length, 1);
    assert.deepEqual(f.commands.at(-1), ["rm", "--force", f.owned[0]]);
});

test("extraction does not follow image symlinks into host input paths", async () => {
    const f = await fixture({ copySymlink: true });
    await assert.rejects(provisionInputs(f.options), /never a symlink/);
    assert.deepEqual(f.commands.at(-1), ["rm", "--force", f.owned[0]]);
});

test("unavailable Docker and incorrect image architecture fail without replacement services", async () => {
    const denied = await fixture({ pullFailure: true });
    await assert.rejects(provisionInputs(denied.options), /Docker pull failed/);
    assert.equal(denied.commands.length, 1);
    const wrong = await fixture({ architecture: "arm64" });
    await assert.rejects(
        provisionInputs(wrong.options),
        /architecture mismatch/,
    );
    assert.ok(!wrong.commands.some((command) => command[0] === "create"));
});
