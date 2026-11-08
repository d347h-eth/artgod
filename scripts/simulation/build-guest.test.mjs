import assert from "node:assert/strict";
import {
    mkdir,
    readFile,
    readdir,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createArtifactRunDirectory, hashFile, pinFile } from "./artifacts.mjs";
import { executeCommand, validateManifest } from "./qemu-replay.mjs";
import {
    assertCoordinatorOnlySourceChanges,
    rebuildGuestCoordinator,
} from "./build-guest.mjs";
import { CPU_MODEL } from "./cpu-model.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE = "scripts/simulation/guest/storage-probe.mjs";
const CONTRACT_SOURCE = "shared/config/rpc-resilience.ts";
const oldSource = "// hash-verified baseline coordinator input\n";
const oldBundle = "// baseline fixture bundle\n";
const newBundle = "// updated fixture bundle\n";
const okay = (stdout = "") => ({
    code: 0,
    signal: null,
    timedOut: false,
    outputLimit: false,
    stdout,
    stderr: "",
});

async function installed(name) {
    const result = await executeCommand("sh", ["-c", `command -v ${name}`], {
        timeoutMs: 5000,
    });
    assert.equal(
        result.code,
        0,
        `The maintained image guard requires installed ${name}`,
    );
    return result.stdout.trim();
}

// Real tiny ext4/debugfs/e2fsck boundaries; emulator conversion and compilation
// are doubles. These checks do not build or qualify a real guest or start a VM.
async function fixture(options = {}) {
    const directory = await createArtifactRunDirectory(
        path.join(ROOT, "tmp/simulation-builder-tests"),
        "run-",
    );
    const debugfs = await installed("debugfs");
    const e2fsck = await installed("e2fsck");
    const payload = path.join(directory, "payload");
    await mkdir(path.join(payload, "workbench/guest"), { recursive: true });
    await mkdir(path.join(payload, "workbench/runtime"));
    const guestSource = path.join(payload, "workbench/guest/guest.mjs");
    if (options.symlinkBundle) {
        await writeFile(
            path.join(payload, "workbench/guest/other.mjs"),
            oldBundle,
        );
        await symlink("other.mjs", guestSource);
    } else
        await writeFile(
            guestSource,
            options.badBundle ? "corrupt baseline" : oldBundle,
        );
    const init = path.join(payload, "workbench/init");
    await writeFile(init, "#!/bin/sh\nexit 0\n");
    await writeFile(
        path.join(payload, "workbench/runtime/retained.txt"),
        "unchanged production runtime bytes",
    );
    if (options.booted) await mkdir(path.join(payload, "workbench/state"));
    const reference = path.join(directory, "reference-bundle.mjs");
    await writeFile(reference, oldBundle);
    const baselineSource = path.join(directory, "source.mjs");
    await writeFile(baselineSource, oldSource);
    const currentPin = await pinFile(path.join(ROOT, SOURCE), ROOT);
    const sourceInputs = [
        await pinFile(path.join(ROOT, "package.json"), ROOT),
        { ...(await pinFile(baselineSource)), path: SOURCE },
        await pinFile(path.join(ROOT, CONTRACT_SOURCE), ROOT),
    ];
    const current = {
        sourceCommit: "b".repeat(40),
        files: [sourceInputs[0], currentPin, sourceInputs[2]],
    };
    const raw = path.join(directory, "guest.qcow2");
    await writeFile(raw, "");
    const truncate = await executeCommand("truncate", ["-s", "8M", raw]);
    assert.equal(truncate.code, 0);
    const filesystem = await executeCommand("mke2fs", [
        "-q",
        "-t",
        "ext4",
        "-F",
        "-d",
        payload,
        raw,
    ]);
    assert.equal(filesystem.code, 0);
    const pins = { guest: await pinFile(raw) };
    for (const name of ["qemu", "qemuImg", "kernel", "firmware", "scenario"]) {
        const file = path.join(directory, name);
        await writeFile(file, `synthetic ${name}`);
        pins[name] = {
            ...(await pinFile(file)),
            ...(["qemu", "qemuImg"].includes(name)
                ? { version: `${name} fixture version` }
                : {}),
        };
    }
    const base = {
        version: 1,
        sourceSha: "a".repeat(40),
        qualificationId: "coordinator-fixture",
        expectedChecks: ["fixture-check"],
        machine: "pc-i440fx-8.2",
        cpu: CPU_MODEL.Max,
        epoch: "2026-11-08T00:00:00Z",
        timeoutSeconds: 10,
        ...pins,
    };
    const baseManifestPath = path.join(directory, "manifest.json");
    await writeFile(baseManifestPath, JSON.stringify(base));
    const provenance = {
        version: 1,
        boundary: "headless-data-plane",
        sourceCommit: base.sourceSha,
        sourceInputs,
        admittedInputs: {},
        scenario: {
            qualificationId: base.qualificationId,
            expectedChecks: base.expectedChecks,
        },
        payload: [
            { ...(await pinFile(reference)), path: "guest/guest.mjs" },
            { ...(await pinFile(init)), path: "init" },
        ],
    };
    const provenancePath = path.join(directory, "provenance.json");
    await writeFile(provenancePath, JSON.stringify(provenance));
    const calls = [];
    const execute = async (file, args, operation = {}) => {
        calls.push({ file, args });
        let result;
        if (file === "git" && args[0] === "show")
            result = okay(
                options.badBaselineSource ? "wrong source" : oldSource,
            );
        else if ([pins.qemu.path, pins.qemuImg.path].includes(file)) {
            if (args[0] === "--version")
                result = okay(
                    file === pins.qemu.path
                        ? pins.qemu.version
                        : pins.qemuImg.version,
                );
            else if (args[0] === "-machine")
                result = okay("pc-i440fx-8.2 fixed machine\n");
            else if (args[0] === "info")
                result = okay(
                    JSON.stringify({
                        format: "qcow2",
                        "virtual-size": (await stat(args.at(-1))).size,
                    }),
                );
            else if (args[0] === "convert") {
                result = await executeCommand("cp", [
                    "--sparse=always",
                    args.at(-2),
                    args.at(-1),
                ]);
            } else
                throw new Error(
                    "No VM or production build is allowed in this fixture",
                );
        } else if (file === debugfs || file === e2fsck) {
            result = await executeCommand(file, args, operation);
            if (
                options.badReadback &&
                args.includes(
                    "dump /workbench/guest/guest.mjs readback-guest.mjs",
                )
            )
                await writeFile(
                    path.join(operation.cwd, "readback-guest.mjs"),
                    "incorrect readback",
                );
        } else throw new Error(`Unexpected build/service tool ${file}`);
        if (operation.stdoutPath && result.stdout)
            await writeFile(operation.stdoutPath, result.stdout);
        else if (operation.stdoutPath && ![debugfs, e2fsck].includes(file))
            await writeFile(operation.stdoutPath, "");
        if (operation.stderrPath && ![debugfs, e2fsck].includes(file))
            await writeFile(operation.stderrPath, result.stderr);
        return result;
    };
    const compile = async ({ outfile, overrides }) => {
        await writeFile(outfile, overrides ? oldBundle : newBundle);
        if (options.changedDuringCompile && !overrides)
            current.sourceCommit = "c".repeat(40);
        return { metafile: { inputs: { [SOURCE]: {}, "package.json": {} } } };
    };
    return {
        directory,
        base,
        provenance,
        current,
        calls,
        debugfs,
        options: {
            baseManifestPath,
            debugfs,
            e2fsck,
            execute,
            compile,
            captureSource: async () => structuredClone(current),
            outputRoot: path.join(directory, "outputs"),
        },
    };
}

async function fixtureInputHashes(directory) {
    const hashes = new Map();
    const visit = async (parent) => {
        for (const entry of await readdir(parent, { withFileTypes: true })) {
            const filename = path.join(parent, entry.name);
            if (entry.isDirectory()) await visit(filename);
            else if (entry.isFile())
                hashes.set(filename, await hashFile(filename));
            else
                throw new Error(
                    "The mutation fixture must contain only regular inputs",
                );
        }
    };
    await visit(directory);
    return hashes;
}

async function assertInputHashesUnchanged(hashes, changed) {
    for (const [filename, before] of hashes) {
        const after = await hashFile(filename);
        if (filename === changed)
            assert.notEqual(after, before, "The intended mutation must occur");
        else assert.equal(after, before, `Original input changed: ${filename}`);
    }
}

async function assertUnpublishedFailure(error) {
    assert.ok(error.artifactsDirectory);
    const retained = await readdir(error.artifactsDirectory);
    assert.ok(!retained.includes("manifest.json"));
    for (const filename of retained.filter((entry) =>
        entry.endsWith(".json"),
    )) {
        const absolute = path.join(error.artifactsDirectory, filename);
        const contents = JSON.parse(await readFile(absolute, "utf8"));
        assert.throws(
            () => validateManifest(contents, absolute),
            /Manifest/,
            `Retained failure evidence ${filename} must not be runnable`,
        );
    }
    const failure = JSON.parse(
        await readFile(
            path.join(error.artifactsDirectory, "failure.json"),
            "utf8",
        ),
    );
    assert.equal(failure.qualified, false);
    assert.equal(failure.error, error.message);
}

test("runtime reuse rejects production, configuration, dependency and init deltas while admitting simulation mjs changes", () => {
    const pin = (name, sha = "a") => ({
        path: name,
        sizeBytes: 1,
        sha256: sha.repeat(64),
    });
    for (const name of [
        "package.json",
        "yarn.lock",
        ".yarnrc.yml",
        ".yarn/patches/fix.patch",
        "indexer/src/order.ts",
        "scripts/build/build.mjs",
        "config/simulation-inputs.json",
        "scripts/simulation/guest/init.sh",
    ])
        assert.throws(
            () =>
                assertCoordinatorOnlySourceChanges(
                    [pin(name)],
                    [pin(name, "b")],
                ),
            /Reused runtime source changed/,
        );
    assert.deepEqual(
        assertCoordinatorOnlySourceChanges(
            [pin("scripts/simulation/guest/cut.mjs")],
            [
                pin("scripts/simulation/guest/cut.mjs", "b"),
                pin("scripts/simulation/portable-run.mjs"),
            ],
        ),
        [
            "scripts/simulation/guest/cut.mjs",
            "scripts/simulation/portable-run.mjs",
        ],
    );
    assert.throws(
        () =>
            assertCoordinatorOnlySourceChanges(
                [pin("scripts/simulation/guest/cut.mjs")],
                [
                    {
                        path: "scripts/simulation/guest/cut.mjs",
                        symlink: "outside",
                    },
                ],
            ),
        /regular pinned files/,
    );
});

test("coordinator update patches one fixed ext4 file, preserves init/runtime and publishes explicit inherited origin", async () => {
    const f = await fixture();
    const originalHash = await hashFile(f.base.guest.path);
    const result = await rebuildGuestCoordinator(f.options);
    const provenance = JSON.parse(
        await readFile(path.join(result.run, "provenance.json"), "utf8"),
    );
    for (const key of Object.keys(f.base).filter(
        (key) => !["guest", "sourceSha"].includes(key),
    ))
        assert.deepEqual(result.manifest[key], f.base[key]);
    assert.equal(result.manifest.sourceSha, f.current.sourceCommit);
    assert.equal(provenance.runtimeOrigin.sourceCommit, f.base.sourceSha);
    assert.equal(provenance.runtimeOrigin.baseGuest.sha256, originalHash);
    assert.equal(
        provenance.runtimeOrigin.baseProvenance.sha256,
        await hashFile(path.join(f.directory, "provenance.json")),
    );
    assert.equal(provenance.qualified, false);
    assert.deepEqual(
        provenance.coordinatorUpdate.before,
        provenance.coordinatorUpdate.after,
    );
    assert.equal(
        await readFile(path.join(result.run, "readback-guest.mjs"), "utf8"),
        newBundle,
    );
    assert.equal(
        await hashFile(path.join(result.run, "original-init")),
        await hashFile(path.join(result.run, "readback-init")),
    );
    assert.equal(await hashFile(f.base.guest.path), originalHash);
    const read = await executeCommand(
        f.debugfs,
        [
            "-R",
            "dump /workbench/runtime/retained.txt retained-copy",
            "guest.ext4",
        ],
        { cwd: result.run },
    );
    assert.equal(read.code, 0);
    assert.equal(
        await readFile(path.join(result.run, "retained-copy"), "utf8"),
        "unchanged production runtime bytes",
    );
    assert.equal(
        f.calls.filter(({ file }) => file === f.options.e2fsck).length,
        2,
    );
    assert.ok(
        !f.calls.some(
            ({ file, args }) => file === "docker" || args.includes("-icount"),
        ),
    );
    assert.ok((await readdir(result.run)).includes("manifest.json"));
});

test("unreconstructable source and compiler/dependency drift fail before flattening any guest", async () => {
    for (const kind of ["source", "bundle", "dependency", "concurrent"]) {
        const f = await fixture({
            badBaselineSource: kind === "source",
            changedDuringCompile: kind === "concurrent",
        });
        const original = f.options.compile;
        f.options.compile = async (options) => {
            const built = await original(options);
            if (kind === "bundle" && options.overrides)
                await writeFile(options.outfile, "not the admitted baseline");
            if (kind === "dependency" && !options.overrides)
                built.metafile.inputs["README.md"] = {};
            return built;
        };
        await assert.rejects(rebuildGuestCoordinator(f.options), (error) =>
            /baseline source|baseline coordinator|closure changed|sources changed/.test(
                error.message,
            ),
        );
        assert.ok(!f.calls.some(({ args }) => args[0] === "convert"));
    }
});

test("new coordinator repository contracts require unchanged baseline source admission while existing dependency pins remain mandatory", async () => {
    for (const kind of [
        "admitted",
        "changed",
        "unadmitted",
        "cache",
        "removed",
    ]) {
        const f = await fixture();
        if (kind === "changed") {
            // This only changes the synthetic source declaration, never the file.
            f.current.files.find(
                (entry) => entry.path === CONTRACT_SOURCE,
            ).sha256 = "d".repeat(64);
        }
        const cacheFixture = path.join(
            f.directory,
            "unadmitted-cache-entry.mjs",
        );
        await writeFile(cacheFixture, "// synthetic new cache dependency\n");
        const original = f.options.compile;
        f.options.compile = async (options) => {
            const built = await original(options);
            if (!options.overrides) {
                const addition =
                    kind === "unadmitted"
                        ? "README.md"
                        : kind === "cache"
                          ? path.relative(ROOT, cacheFixture)
                          : CONTRACT_SOURCE;
                built.metafile.inputs[addition] = {};
                if (kind === "removed")
                    delete built.metafile.inputs["package.json"];
            }
            return built;
        };
        if (kind === "admitted") {
            const result = await rebuildGuestCoordinator(f.options);
            const provenance = JSON.parse(
                await readFile(
                    path.join(result.run, "provenance.json"),
                    "utf8",
                ),
            );
            assert.deepEqual(
                provenance.coordinatorUpdate.compatibility
                    .addedRepositoryInputs,
                [await pinFile(path.join(ROOT, CONTRACT_SOURCE), ROOT)],
            );
        } else {
            await assert.rejects(
                rebuildGuestCoordinator(f.options),
                /Reused runtime source changed|closure changed/,
            );
            assert.ok(!f.calls.some(({ args }) => args[0] === "convert"));
        }
    }
});

test("booted stores, wrong fixed bundle, symlinks and damaged readback never publish a usable manifest", async () => {
    for (const options of [
        { booted: true },
        { badBundle: true },
        { symlinkBundle: true },
        { badReadback: true },
    ]) {
        const f = await fixture(options);
        await assert.rejects(rebuildGuestCoordinator(f.options), (error) => {
            assert.ok(
                /pristine guest|regular file|readback differs/.test(
                    error.message,
                ),
            );
            return true;
        });
        const outputs = await readdir(f.options.outputRoot);
        assert.equal(outputs.length, 1);
        assert.ok(
            !(
                await readdir(path.join(f.options.outputRoot, outputs[0]))
            ).includes("manifest.json"),
        );
    }
});

test("a failed read-only filesystem check rejects publication before and after the coordinator patch without changing original inputs", async () => {
    for (const failureAt of [1, 2]) {
        const f = await fixture();
        const originals = await fixtureInputHashes(f.directory);
        const execute = f.options.execute;
        let checks = 0;
        f.options.execute = async (file, args, operation) => {
            const result = await execute(file, args, operation);
            if (file !== f.options.e2fsck) return result;
            assert.deepEqual(args, ["-f", "-n", "guest.ext4"]);
            checks++;
            return checks === failureAt
                ? {
                      ...result,
                      code: 4,
                      stderr: "synthetic filesystem inconsistency",
                  }
                : result;
        };
        let failure;
        await assert.rejects(rebuildGuestCoordinator(f.options), (error) => {
            failure = error;
            assert.match(error.message, /e2fsck failed: 4/);
            return true;
        });
        assert.equal(checks, failureAt);
        await assertUnpublishedFailure(failure);
        await assertInputHashesUnchanged(originals);
        assert.ok(
            !f.calls.some(
                ({ args }) =>
                    args[0] === "convert" &&
                    args[args.indexOf("-O") + 1] === "qcow2",
            ),
            "No standalone output may be converted after a failed filesystem check",
        );
        const files = await readdir(failure.artifactsDirectory);
        assert.equal(files.includes("readback-guest.mjs"), failureAt === 2);
    }
});

test("late paired-provenance or pinned-input mutation cannot publish a coordinator manifest or modify other originals", async () => {
    for (const kind of ["provenance", "input"]) {
        const f = await fixture();
        const originals = await fixtureInputHashes(f.directory);
        const changed =
            kind === "provenance"
                ? path.join(f.directory, "provenance.json")
                : f.base.kernel.path;
        const execute = f.options.execute;
        let mutated = false;
        f.options.execute = async (file, args, operation) => {
            const result = await execute(file, args, operation);
            if (
                file === f.base.qemuImg.path &&
                args[0] === "convert" &&
                args[args.indexOf("-O") + 1] === "qcow2"
            ) {
                assert.equal(mutated, false);
                mutated = true;
                await writeFile(changed, "changed after standalone conversion");
            }
            return result;
        };
        let failure;
        await assert.rejects(rebuildGuestCoordinator(f.options), (error) => {
            failure = error;
            assert.match(error.message, /input changed|pin/i);
            return true;
        });
        assert.ok(mutated, "The late admission boundary must be exercised");
        await assertUnpublishedFailure(failure);
        await assertInputHashesUnchanged(originals, changed);
        assert.ok(
            (await readdir(failure.artifactsDirectory)).includes("guest.qcow2"),
            "A converted candidate must still fail closed before publication",
        );
        if (kind === "provenance") {
            const evidence = JSON.parse(
                await readFile(
                    path.join(
                        failure.artifactsDirectory,
                        "admission-candidate.json",
                    ),
                    "utf8",
                ),
            );
            assert.equal(evidence.published, false);
            assert.equal(evidence.candidate.sourceSha, f.current.sourceCommit);
        }
    }
});
