import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pinFile } from "./artifacts.mjs";
import { DOCKER_OWNER_LABEL } from "./docker.mjs";
import { readInputPins } from "./input-pins.mjs";
import { QEMU_ENVIRONMENT } from "./qemu-replay.mjs";
import {
    admitToolCapsule,
    admitToolCapsuleExecution,
    createToolCapsuleExecution,
    createToolCapsuleExecutor,
    prepareToolCapsule,
    restoreToolCapsule,
    validateToolCapsule,
    TOOL_IMAGE_ADDRESSING,
} from "./tool-capsule.mjs";
import { createToolImageArchiveFixture } from "./tool-image-archive-fixture.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const IMAGE = `sha256:${"a".repeat(64)}`;
const okay = (stdout = "") => ({
    code: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
});

async function fixture() {
    const parent = path.join(ROOT, "tmp/simulation-tool-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "run-"));
    const tools = {};
    for (const name of ["qemu", "qemuImg", "firmware"]) {
        const filename = path.join(directory, name);
        await writeFile(filename, `fixture tool bytes ${name}`);
        tools[name] = {
            ...(await pinFile(filename)),
            ...(name === "firmware"
                ? {}
                : { version: `${name} fixture version` }),
        };
    }
    const archive = path.join(directory, "tool-image.tar");
    await writeFile(
        archive,
        "synthetic image archive; no container runtime qualification",
    );
    const descriptor = {
        version: 1,
        architecture: "amd64",
        imageId: IMAGE,
        archive: await pinFile(archive),
        tools,
        build: {
            baseImage: (await readInputPins()).toolBaseImage,
            dockerfileSha256: "b".repeat(64),
        },
    };
    const filename = path.join(directory, "capsule.json");
    await writeFile(filename, JSON.stringify(descriptor));
    const calls = [];
    const containers = new Map();
    const execute = async (binary, args, options) => {
        assert.equal(binary, "docker");
        calls.push(args);
        if (args[0] === "image" && args[1] === "inspect")
            return okay(
                JSON.stringify({
                    Id: IMAGE,
                    Architecture: "amd64",
                    Os: "linux",
                }),
            );
        if (args[0] === "image" && args[1] === "load")
            return okay("loaded synthetic image");
        if (args[0] === "create") {
            const name = args[args.indexOf("--name") + 1];
            containers.set(
                name,
                args[args.indexOf("--label") + 1].slice(
                    DOCKER_OWNER_LABEL.length + 1,
                ),
            );
            await writeFile(
                args[args.indexOf("--cidfile") + 1],
                "c".repeat(64),
            );
            return okay(`${"c".repeat(64)}\n`);
        }
        if (args[0] === "inspect")
            return okay(
                JSON.stringify({
                    [DOCKER_OWNER_LABEL]: containers.get(args.at(-1)),
                }),
            );
        if (args[0] === "start") {
            if (options.stdoutPath) {
                await writeFile(options.stdoutPath, "exact synthetic serial\n");
                await writeFile(
                    options.stderrPath,
                    "synthetic engine diagnostic\n",
                );
                return okay();
            }
            return okay("qemu fixture version\n");
        }
        if (args[0] === "rm") {
            containers.delete(args.at(-1));
            return okay();
        }
        throw new Error(`Unexpected fake operation ${args}`);
    };
    return { directory, filename, descriptor, calls, containers, execute };
}

async function manifestAddressFixture() {
    const f = await fixture();
    const archive = createToolImageArchiveFixture();
    await writeFile(f.descriptor.archive.path, archive.bytes);
    f.descriptor.archive = await pinFile(f.descriptor.archive.path);
    f.descriptor.imageId = archive.recordedImageId;
    await writeFile(f.filename, JSON.stringify(f.descriptor));
    const inspection = {
        Id: archive.runtimeImageId,
        Architecture: "amd64",
        Os: "linux",
        Descriptor: structuredClone(archive.manifestDescriptor),
        RootFS: { Type: "layers", Layers: [...archive.layerDigests] },
    };
    const execute = async (binary, args, options) => {
        if (args[0] !== "image" || args[1] !== "inspect")
            return f.execute(binary, args, options);
        f.calls.push(args);
        if (args.at(-1) === archive.recordedImageId)
            return { ...okay(), code: 1, stderr: "No such image" };
        assert.equal(args.at(-1), archive.runtimeImageId);
        return okay(JSON.stringify(inspection));
    };
    return { ...f, archive, inspection, execute };
}

test("capsule admission binds archive, platform and tool byte pins before any container execution", async () => {
    const f = await fixture();
    assert.equal(
        (
            await admitToolCapsule(f.filename, {
                execute: f.execute,
                manifest: f.descriptor.tools,
            })
        ).imageId,
        IMAGE,
    );
    assert.equal(f.calls.length, 1);
    assert.throws(
        () =>
            validateToolCapsule({ ...f.descriptor, qemuArgs: [] }, f.filename),
        /exactly/,
    );
    const incompatible = structuredClone(f.descriptor.tools);
    incompatible.qemu.sha256 = "d".repeat(64);
    await assert.rejects(
        admitToolCapsule(f.filename, {
            execute: f.execute,
            manifest: incompatible,
        }),
        /does not match/,
    );
    assert.equal(f.calls.length, 1);
    await writeFile(f.descriptor.archive.path, "changed image archive");
    await assert.rejects(
        admitToolCapsule(f.filename, { execute: f.execute }),
        /bytes changed/,
    );
    assert.equal(f.calls.length, 1);
});

test("absent tool images fail clearly without implicit load, pull, build or foreign execution", async () => {
    const f = await fixture();
    await assert.rejects(
        admitToolCapsule(f.filename, {
            execute: async (_binary, args) => {
                assert.deepEqual(args.slice(0, 2), ["image", "inspect"]);
                return { ...okay(), code: 1, stderr: "No such image" };
            },
        }),
        /No such image/,
    );
    const execute = await createToolCapsuleExecutor({
        filename: f.filename,
        manifest: f.descriptor.tools,
        execute: f.execute,
    });
    await assert.rejects(execute("/usr/bin/other-qemu", []), /admitted engine/);
    await assert.rejects(
        execute(f.descriptor.tools.qemu.path, ["--version"], {
            env: { ...QEMU_ENVIRONMENT, EVIL: "value" },
        }),
        /environment/,
    );
    assert.ok(
        !f.calls.some((args) =>
            ["create", "pull", "load", "build"].includes(args[0]),
        ),
    );
});

test("engine adapter preserves raw output and owns a no-network container with only its current run writable", async () => {
    const f = await fixture();
    const execute = await createToolCapsuleExecutor({
        filename: f.filename,
        manifest: f.descriptor.tools,
        execute: f.execute,
    });
    const stdoutPath = path.join(f.directory, "serial.log");
    const stderrPath = path.join(f.directory, "qemu.log");
    await execute(f.descriptor.tools.qemu.path, ["--version"], {
        cwd: f.directory,
        stdoutPath,
        stderrPath,
        env: QEMU_ENVIRONMENT,
    });
    const created = f.calls.find((args) => args[0] === "create");
    assert.equal(created[created.indexOf("--network") + 1], "none");
    const mounts = created.flatMap((arg, index) =>
        arg === "--mount" ? [created[index + 1]] : [],
    );
    assert.deepEqual(mounts, [
        `type=bind,source=${path.resolve(ROOT)},target=${path.resolve(ROOT)},readonly`,
        `type=bind,source=${f.directory},target=${f.directory}`,
    ]);
    assert.deepEqual(created.slice(created.indexOf(IMAGE) + 1), [
        "/usr/bin/env",
        "-i",
        "LANG=C",
        "LC_ALL=C",
        "TZ=UTC",
        "/usr/bin/qemu-system-x86_64",
        "--version",
    ]);
    assert.equal(
        await readFile(stdoutPath, "utf8"),
        "exact synthetic serial\n",
    );
    assert.equal(f.containers.size, 0);
});

test("restoring requires an explicit archive and verifies loaded identity", async () => {
    const f = await fixture();
    const result = await restoreToolCapsule(f.filename, { execute: f.execute });
    assert.deepEqual(result, f.descriptor);
    assert.deepEqual(
        f.calls.map((args) => args.slice(0, 2)),
        [
            ["image", "load"],
            ["image", "inspect"],
        ],
    );
});

test("a config-addressed saved capsule resolves only to its proven manifest and preserves capsule bytes", async () => {
    const f = await manifestAddressFixture();
    const before = await pinFile(f.filename);
    const result = await admitToolCapsuleExecution(f.filename, {
        execute: f.execute,
        manifest: f.descriptor.tools,
    });
    assert.equal(result.capsule.imageId, f.archive.recordedImageId);
    assert.equal(result.identity.recordedImageId, f.archive.recordedImageId);
    assert.equal(result.identity.runtimeImageId, f.archive.runtimeImageId);
    assert.equal(
        result.identity.addressing,
        TOOL_IMAGE_ADDRESSING.SavedManifest,
    );
    assert.deepEqual(
        result.identity.graph.rootfsDiffIds,
        f.archive.layerDigests,
    );
    assert.deepEqual(result.identity.tools, f.descriptor.tools);
    assert.equal(
        (await admitToolCapsule(f.filename, { execute: f.execute })).imageId,
        f.archive.recordedImageId,
    );
    assert.deepEqual(await pinFile(f.filename), before);
    assert.deepEqual(
        f.calls.map((args) => args.at(-1)),
        [
            f.archive.recordedImageId,
            f.archive.runtimeImageId,
            f.archive.recordedImageId,
            f.archive.runtimeImageId,
        ],
    );
    assert.ok(
        f.calls.every((args) => args[0] === "image" && args[1] === "inspect"),
    );
});

test("the engine uses only the proven runtime address and retains identity evidence before start", async () => {
    const f = await manifestAddressFixture();
    const before = await pinFile(f.filename);
    let observedBeforeStart = false;
    const execute = await createToolCapsuleExecutor({
        filename: f.filename,
        manifest: f.descriptor.tools,
        execute: async (binary, args, options) => {
            if (args[0] === "start") {
                const create = f.calls.find((call) => call[0] === "create");
                const directory = path.dirname(
                    create[create.indexOf("--cidfile") + 1],
                );
                const receipt = JSON.parse(
                    await readFile(
                        path.join(directory, "tool-image-admission.json"),
                        "utf8",
                    ),
                );
                assert.equal(receipt.runtimeImageId, f.archive.runtimeImageId);
                observedBeforeStart = true;
            }
            return f.execute(binary, args, options);
        },
    });
    const result = await execute(f.descriptor.tools.qemu.path, ["--version"], {
        cwd: f.directory,
        env: QEMU_ENVIRONMENT,
    });
    const created = f.calls.find((args) => args[0] === "create");
    assert.ok(created.includes(f.archive.runtimeImageId));
    assert.ok(!created.includes(f.archive.recordedImageId));
    assert.ok(created.includes("--pull=never"));
    assert.equal(observedBeforeStart, true);
    const identity = JSON.parse(
        await readFile(
            path.join(result.dockerArtifacts, "tool-image-admission.json"),
            "utf8",
        ),
    );
    assert.equal(identity.recordedImageId, f.archive.recordedImageId);
    assert.equal(identity.runtimeImageId, f.archive.runtimeImageId);
    assert.deepEqual(identity.graph.rootfsDiffIds, f.archive.layerDigests);
    assert.deepEqual(await pinFile(f.filename), before);
    assert.equal(f.containers.size, 0);
    assert.ok(
        !f.calls.some(
            (args) =>
                ["pull", "tag", "load", "build"].includes(args[0]) ||
                ["load", "build"].includes(args[1]),
        ),
    );
});

test("the richer executor returns reportable identity without allowing its address to be changed", async () => {
    const f = await manifestAddressFixture();
    const admitted = await createToolCapsuleExecution({
        filename: f.filename,
        manifest: f.descriptor.tools,
        execute: f.execute,
    });
    assert.equal(admitted.identity.recordedImageId, f.archive.recordedImageId);
    assert.equal(admitted.identity.runtimeImageId, f.archive.runtimeImageId);
    admitted.identity.runtimeImageId = IMAGE;
    const result = await admitted.execute(
        f.descriptor.tools.qemu.path,
        ["--version"],
        {
            cwd: f.directory,
            env: QEMU_ENVIRONMENT,
        },
    );
    const created = f.calls.find((args) => args[0] === "create");
    assert.ok(created.includes(f.archive.runtimeImageId));
    assert.ok(!created.includes(IMAGE));
    const receipt = JSON.parse(
        await readFile(
            path.join(result.dockerArtifacts, "tool-image-admission.json"),
            "utf8",
        ),
    );
    assert.equal(receipt.runtimeImageId, f.archive.runtimeImageId);
});

test("manifest fallback refuses wrong daemon identity, descriptor, ordered rootfs and platform before execution", async () => {
    for (const mutate of [
        (image) => {
            image.Id = IMAGE;
        },
        (image) => {
            image.Architecture = "arm64";
        },
        (image) => {
            image.Os = "windows";
        },
        (image) => {
            delete image.Descriptor;
        },
        (image) => {
            image.Descriptor.digest = IMAGE;
        },
        (image) => {
            image.Descriptor.size++;
        },
        (image) => {
            image.Descriptor.mediaType = "unknown";
        },
        (image) => {
            image.RootFS.Type = "unknown";
        },
        (image) => {
            image.RootFS.Layers.reverse();
        },
        (image) => {
            image.RootFS.Layers.pop();
        },
    ]) {
        const f = await manifestAddressFixture();
        mutate(f.inspection);
        await assert.rejects(
            createToolCapsuleExecutor({
                filename: f.filename,
                manifest: f.descriptor.tools,
                execute: f.execute,
            }),
            /differs/,
        );
        assert.ok(
            !f.calls.some((args) => ["create", "start"].includes(args[0])),
        );
    }
});

test("permission or timeout is not absence and a missing proven manifest never triggers load or image search", async () => {
    for (const response of [
        { ...okay(), code: 1, stderr: "permission denied" },
        { ...okay(), code: 1, timedOut: true, stderr: "No such image" },
        { ...okay(), code: 1, signal: "SIGTERM", stderr: "No such image" },
        { ...okay(), code: 1, outputLimit: true, stderr: "No such image" },
        { ...okay(), code: undefined, stderr: "No such image" },
        { ...okay(), code: 2, stderr: "No such image" },
    ]) {
        const f = await manifestAddressFixture();
        const calls = [];
        await assert.rejects(
            admitToolCapsuleExecution(f.filename, {
                execute: async (_binary, args) => {
                    calls.push(args);
                    return response;
                },
            }),
            /inspection/,
        );
        assert.equal(calls.length, 1);
    }
    const f = await manifestAddressFixture();
    const calls = [];
    await assert.rejects(
        admitToolCapsuleExecution(f.filename, {
            execute: async (_binary, args) => {
                calls.push(args);
                return { ...okay(), code: 1, stderr: "No such image" };
            },
        }),
        /No such image/,
    );
    assert.deepEqual(
        calls.map((args) => args.at(-1)),
        [f.archive.recordedImageId, f.archive.runtimeImageId],
    );
    assert.ok(
        calls.every((args) => args[0] === "image" && args[1] === "inspect"),
    );
});

test("archive mutation during daemon admission cannot authorize a container", async () => {
    const f = await manifestAddressFixture();
    await assert.rejects(
        createToolCapsuleExecutor({
            filename: f.filename,
            manifest: f.descriptor.tools,
            execute: async (binary, args, options) => {
                const result = await f.execute(binary, args, options);
                if (
                    args[1] === "inspect" &&
                    args.at(-1) === f.archive.runtimeImageId
                )
                    await writeFile(
                        f.descriptor.archive.path,
                        "changed after graph proof",
                    );
                return result;
            },
        }),
        /bytes changed/,
    );
    assert.ok(!f.calls.some((args) => ["create", "start"].includes(args[0])));
});

test("tool provisioning keeps package installation inside the pinned Docker build and saves the actual final image", async () => {
    const f = await fixture();
    let context;
    const execute = async (binary, args, options) => {
        if (args[0] === "build") {
            context = args.at(-1);
            await writeFile(args[args.indexOf("--iidfile") + 1], IMAGE);
            return okay();
        }
        if (args[0] === "image" && args[1] === "save") {
            assert.equal(args.at(-1), IMAGE);
            await writeFile(
                args[args.indexOf("--output") + 1],
                "saved synthetic image",
            );
            return okay();
        }
        if (args[0] === "cp") {
            await writeFile(args[2], `synthetic extracted ${args[1]}`);
            return okay();
        }
        return f.execute(binary, args, options);
    };
    const result = await prepareToolCapsule({
        outputRoot: f.directory,
        execute,
    });
    const dockerfile = await readFile(path.join(context, "Dockerfile"), "utf8");
    assert.ok(
        dockerfile.startsWith(
            `FROM ${(await readInputPins()).toolBaseImage}\n`,
        ),
    );
    assert.match(dockerfile, /RUN apt-get update && apt-get install/);
    assert.equal(result.capsule.imageId, IMAGE);
    assert.equal(result.capsule.archive.sha256.length, 64);
});
