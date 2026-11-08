#!/usr/bin/env node
import {
    chmod,
    copyFile,
    cp,
    mkdir,
    readdir,
    readFile,
    readlink,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildSqliteNativeBinding } from "../build/build-sqlite-native-binding.mjs";
import { stageDesktopRuntimeDependencies } from "../build/desktop-runtime-dependency-staging.mjs";
import { projectYarnCommand } from "../build/project-yarn-command.mjs";
import { readDesktopRuntimeInputs } from "../build/desktop-runtime-inputs.mjs";
import {
    executeCommand,
    QEMU_ENVIRONMENT,
    preflight,
    preflightManifest,
} from "./qemu-replay.mjs";
import {
    runOwnedContainer,
    withOwnedContainer,
    CONTAINER_MOUNT_TARGET,
} from "./docker.mjs";
import { validateScenario } from "./guest/scenario-contract.mjs";
import { prepareGuestCertificates } from "./guest-certificates.mjs";
import { validateBuildConfiguration } from "./input-pins.mjs";
export { validateBuildConfiguration } from "./input-pins.mjs";
import { prepareScenarioDisk } from "./prepare-case.mjs";
import {
    pinFile as pin,
    createArtifactRunDirectory,
    hashFile,
    assertWorktreeTemporaryPath,
} from "./artifacts.mjs";
import { snapshotSource, assertSameSource } from "./source-snapshot.mjs";
import {
    admitToolCapsule,
    createToolCapsuleExecutor,
} from "./tool-capsule.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const coordinatorSource = (filename) =>
    filename.startsWith("scripts/simulation/") && filename.endsWith(".mjs");

function sourceMap(files) {
    if (!Array.isArray(files) || !files.length)
        throw new Error("An exact nonempty source inventory is required");
    const result = new Map();
    for (const entry of files) {
        if (
            typeof entry.path !== "string" ||
            path.posix.isAbsolute(entry.path) ||
            path.posix.normalize(entry.path) !== entry.path ||
            entry.path.startsWith("../") ||
            result.has(entry.path)
        )
            throw new Error(
                "Source inventory paths must be unique and relative",
            );
        result.set(entry.path, entry);
    }
    return result;
}

/** Reusing runtime bytes never admits a production, configuration or init change. */
export function assertCoordinatorOnlySourceChanges(previous, current) {
    const before = sourceMap(previous);
    const after = sourceMap(current);
    const changed = [];
    for (const filename of [
        ...new Set([...before.keys(), ...after.keys()]),
    ].sort()) {
        if (isDeepStrictEqual(before.get(filename), after.get(filename)))
            continue;
        if (!coordinatorSource(filename))
            throw new Error(`Reused runtime source changed: ${filename}`);
        for (const entry of [before.get(filename), after.get(filename)].filter(
            Boolean,
        ))
            if (
                typeof entry.sha256 !== "string" ||
                !/^[a-f0-9]{64}$/.test(entry.sha256) ||
                !Number.isSafeInteger(entry.sizeBytes) ||
                entry.sizeBytes < 0 ||
                "symlink" in entry
            )
                throw new Error(
                    "Changed coordinator sources must be regular pinned files",
                );
        changed.push(filename);
    }
    return changed;
}

/** One compilation owner for full builds, compatibility controls and coordinator updates. */
export async function bundleCoordinator({
    outfile,
    overrides = new Map(),
    entryPoint = "scripts/simulation/guest/guest.mjs",
}) {
    return build({
        absWorkingDir: ROOT,
        entryPoints: [entryPoint],
        outfile,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node24",
        external: ["better-sqlite3"],
        banner: {
            js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
        },
        metafile: true,
        logLevel: "warning",
        plugins: overrides.size
            ? [
                  {
                      name: "admitted-baseline-coordinator",
                      setup(plugin) {
                          plugin.onResolve({ filter: /\.mjs$/ }, (args) => {
                              const filename = path.resolve(
                                  args.resolveDir || ROOT,
                                  args.path,
                              );
                              if (overrides.has(filename))
                                  return { path: filename };
                          });
                          plugin.onLoad({ filter: /\.mjs$/ }, (args) => {
                              const admitted = overrides.get(args.path);
                              if (admitted)
                                  return {
                                      // esbuild's custom onLoad path does not
                                      // inherit .mjs's implicit strict mode.
                                      // Restore that input semantic explicitly;
                                      // historical source bytes stay pinned raw.
                                      contents: `"use strict";\n${admitted.contents}`,
                                      loader: "js",
                                      resolveDir: path.dirname(args.path),
                                  };
                          });
                      },
                  },
              ]
            : [],
    });
}

async function coordinatorInputPins(result, overrides = new Map()) {
    const inputs = Object.keys(result.metafile?.inputs ?? {}).sort();
    if (!inputs.length)
        throw new Error(
            "Coordinator compilation must retain its dependency closure",
        );
    return await Promise.all(
        inputs.map(async (input) => {
            const filename = path.resolve(ROOT, input);
            const relative = path.relative(ROOT, filename);
            if (relative.startsWith("..") || path.isAbsolute(relative))
                throw new Error("Coordinator dependency escapes the workspace");
            return overrides.get(filename)?.pin ?? (await pin(filename, ROOT));
        }),
    );
}

function admitCoordinatorDependencies(baseline, current, oldSources, sources) {
    const immutable = (entries) =>
        sourceMap(entries.filter((entry) => !coordinatorSource(entry.path)));
    const oldInputs = immutable(baseline);
    const inputs = immutable(current);
    for (const [filename, expected] of oldInputs)
        if (!isDeepStrictEqual(inputs.get(filename), expected))
            throw new Error(
                `Coordinator dependency or production input closure changed: ${filename}`,
            );
    const admittedSources = sourceMap(oldSources);
    const currentSources = sourceMap(sources);
    const additions = [];
    for (const [filename, actual] of inputs) {
        if (oldInputs.has(filename)) continue;
        // Unchanged repository contracts may join this coordinator's bundle.
        // A newly reached cache/package file has no admitted source attestation.
        if (
            !isDeepStrictEqual(admittedSources.get(filename), actual) ||
            !isDeepStrictEqual(currentSources.get(filename), actual)
        )
            throw new Error(
                `Coordinator dependency or production input closure changed without admitted repository source: ${filename}`,
            );
        additions.push(actual);
    }
    return additions;
}

// No shell interpolation; build tools and container output have bounded retained logs.
async function command(
    binary,
    args,
    {
        cwd = ROOT,
        timeoutMs = 600_000,
        log,
        env = process.env,
        execute = executeCommand,
    } = {},
) {
    const result = await execute(binary, args, {
        cwd,
        env,
        timeoutMs,
        ...(log ? { stdoutPath: `${log}.stdout`, stderrPath: log } : {}),
    });
    if (
        result.code !== 0 ||
        result.signal ||
        result.timedOut ||
        result.outputLimit
    )
        throw new Error(
            `${binary} failed: ${result.timedOut ? "timeout" : result.outputLimit ? "output limit" : (result.signal ?? result.code)}${log ? `; see ${log}` : `; ${result.stderr.slice(-4000)}`}`,
        );
    return result.stdout;
}

async function exportImage(image, destination, run) {
    return await withOwnedContainer(
        { image, artifactParent: path.join(run, "containers") },
        async (container) => {
            await container.exportTo(path.join(run, "rootfs.tar"));
            await command("tar", [
                "--extract",
                "--file",
                path.join(run, "rootfs.tar"),
                "--directory",
                destination,
                "--no-same-owner",
            ]);
        },
    );
}

/** Builds a fresh synthetic guest; never mounts an operator store into a container or VM. */
export async function buildGuest(configurationPath) {
    const configurationFile = path.resolve(configurationPath);
    const config = validateBuildConfiguration(
        JSON.parse(await readFile(configurationFile, "utf8")),
    );
    const local = (filename) =>
        path.resolve(path.dirname(configurationFile), filename);
    const scenario = validateScenario(
        JSON.parse(await readFile(local(config.scenarioFile), "utf8")),
    );
    for (const key of ["kernel", "firmware", "natsBinary", "qemu", "qemuImg"])
        if (!(await stat(local(config[key]))).isFile())
            throw new Error(`${key} is not a file`);
    const admittedInputs = {};
    for (const key of ["kernel", "firmware", "natsBinary", "qemu", "qemuImg"])
        admittedInputs[key] = await pin(local(config[key]));
    let engineExecute = executeCommand;
    if (config.toolCapsuleFile) {
        admittedInputs.toolCapsuleFile = await pin(
            local(config.toolCapsuleFile),
        );
        const capsule = await admitToolCapsule(local(config.toolCapsuleFile));
        const engineManifest = Object.fromEntries(
            ["qemu", "qemuImg", "firmware"].map((name) => [
                name,
                {
                    ...admittedInputs[name],
                    ...(name !== "firmware"
                        ? { version: capsule.tools[name].version }
                        : {}),
                },
            ]),
        );
        engineExecute = await createToolCapsuleExecutor({
            filename: local(config.toolCapsuleFile),
            manifest: engineManifest,
        });
    }
    const engineCommand = (binary, args, options = {}) =>
        command(binary, args, {
            execute: engineExecute,
            env: QEMU_ENVIRONMENT,
            ...options,
        });
    const assertBuildInputsUnchanged = async () => {
        for (const [key, admitted] of Object.entries(admittedInputs))
            if (
                JSON.stringify(await pin(local(config[key]))) !==
                JSON.stringify(admitted)
            )
                throw new Error(
                    `Guest build input changed after admission: ${key}`,
                );
    };
    // Read-only checks complete before creating the image tree or rebuilding native code.
    for (const image of [
        config.runtimeImage,
        config.builderImage,
        config.busyboxImage,
    ])
        if (
            (
                await command("docker", [
                    "image",
                    "inspect",
                    "--format",
                    "{{.Architecture}}",
                    image,
                ])
            ).trim() !== "amd64"
        )
            throw new Error("This baseline requires x86-64 images");
    const expectedNode = JSON.parse(
        await readFile(path.join(ROOT, "package.json"), "utf8"),
    ).engines.node;
    const containerArtifacts = [];
    for (const image of [config.runtimeImage, config.builderImage]) {
        const probe = await runOwnedContainer({
            image,
            command: ["node", "--version"],
        });
        containerArtifacts.push(probe.dockerArtifacts);
        if (probe.stdout.trim() !== `v${expectedNode}`)
            throw new Error("Guest Node must match the production Node pin");
    }
    const runtimeInputs = await readDesktopRuntimeInputs({ rootDir: ROOT });
    if (
        !(await command(local(config.natsBinary), ["--version"])).includes(
            `v${runtimeInputs.nats.version}`,
        )
    )
        throw new Error("Guest NATS must match the production NATS pin");
    const run = await createArtifactRunDirectory(
        path.join(ROOT, "tmp/simulation"),
        "guest-",
    );
    const rootfs = path.join(run, "rootfs");
    const logs = path.join(run, "logs");
    await mkdir(rootfs);
    await mkdir(logs);
    const frozenScenario = path.join(run, "scenario.json");
    await writeFile(frozenScenario, `${JSON.stringify(scenario, null, 2)}\n`, {
        flag: "wx",
        mode: 0o444,
    });
    const scenarioDisk = await prepareScenarioDisk({
        scenarioFile: frozenScenario,
        directory: path.join(run, "scenario-input"),
    });
    console.log(`Preparing guest in ${path.relative(ROOT, run)}`);
    const runtimeBuild = projectYarnCommand(["build:desktop-runtime"]);
    const runtimeSource = await snapshotSource(ROOT);
    await command(runtimeBuild.command, runtimeBuild.args, {
        log: path.join(logs, "runtime-build.log"),
        env: { ...process.env, TMPDIR: path.join(ROOT, "tmp/tooling") },
    });
    assertSameSource(runtimeSource, await snapshotSource(ROOT));
    containerArtifacts.push(
        (await exportImage(config.runtimeImage, rootfs, run))
            .artifactsDirectory,
    );
    const utility = await withOwnedContainer(
        {
            image: config.busyboxImage,
            artifactParent: path.join(run, "containers"),
        },
        (container) =>
            container.copyFrom(
                "/bin/busybox",
                path.join(rootfs, "bin/busybox"),
            ),
    );
    containerArtifacts.push(utility.artifactsDirectory);
    await chmod(path.join(rootfs, "bin/busybox"), 0o755);
    await command("file", [path.join(rootfs, "bin/busybox")]).then((result) => {
        if (!result.includes("statically linked"))
            throw new Error("Guest BusyBox must be statically linked");
    });

    // Reuse the trusted native-binding owner with a guest-compatible compiler image.
    await buildSqliteNativeBinding({
        rootDir: ROOT,
        temporaryDirectory: path.join(ROOT, "tmp/tooling"),
        packageInstaller: async ({ packageDir }) => {
            const native = await runOwnedContainer({
                image: config.builderImage,
                command: [
                    "node",
                    "/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js",
                    "rebuild",
                    "--release",
                    "--nodedir=/usr/local",
                ],
                mounts: [
                    {
                        source: packageDir,
                        target: CONTAINER_MOUNT_TARGET.NativePackage,
                        readOnly: false,
                    },
                ],
                workdir: CONTAINER_MOUNT_TARGET.NativePackage,
                timeoutMs: 600_000,
                artifactParent: path.join(run, "containers"),
            });
            containerArtifacts.push(native.dockerArtifacts);
        },
    });
    const workbench = path.join(rootfs, "workbench");
    const runtime = path.join(workbench, "runtime");
    await mkdir(runtime, { recursive: true });
    const certificates = path.join(workbench, "certs");
    await mkdir(certificates);
    const certificateEvidence = await prepareGuestCertificates({
        builderImage: config.builderImage,
        directory: certificates,
    });
    containerArtifacts.push(...certificateEvidence.dockerArtifacts);
    for (const name of ["backend", "indexer", "trading"])
        await cp(
            path.join(ROOT, name, "dist-desktop"),
            path.join(runtime, name, "dist-desktop"),
            { recursive: true },
        );
    await cp(
        path.join(ROOT, "database/migrations"),
        path.join(runtime, "database/migrations"),
        { recursive: true },
    );
    await cp(
        path.join(ROOT, "database/migrations"),
        path.join(workbench, "database/migrations"),
        { recursive: true },
    );
    await stageDesktopRuntimeDependencies({
        rootDir: ROOT,
        destinationRootDir: runtime,
        nodeTarget: "linux-x64",
    });
    await mkdir(path.join(runtime, "nats"));
    await copyFile(
        local(config.natsBinary),
        path.join(runtime, "nats/nats-server"),
    );
    const stagedNats = await pin(path.join(runtime, "nats/nats-server"));
    if (
        stagedNats.sha256 !== admittedInputs.natsBinary.sha256 ||
        stagedNats.sizeBytes !== admittedInputs.natsBinary.sizeBytes
    )
        throw new Error(
            "Copied NATS bytes differ from the admitted production binary",
        );
    await chmod(path.join(runtime, "nats/nats-server"), 0o755);
    await mkdir(path.join(workbench, "guest"));
    await symlink(
        "../runtime/indexer/node_modules",
        path.join(workbench, "guest/node_modules"),
    );
    const guestSource = await snapshotSource(ROOT);
    // Both bundles must describe the same source tree, including untracked work.
    assertSameSource(runtimeSource, guestSource);
    const coordinatorBuild = await bundleCoordinator({
        outfile: path.join(workbench, "guest/guest.mjs"),
    });
    const coordinatorInputs = await coordinatorInputPins(coordinatorBuild);
    await copyFile(
        path.join(ROOT, "scripts/simulation/guest/init.sh"),
        path.join(workbench, "init"),
    );
    assertSameSource(guestSource, await snapshotSource(ROOT));
    await chmod(path.join(workbench, "init"), 0o755);
    await mkdir(path.join(rootfs, "proc"), { recursive: true });
    await mkdir(path.join(rootfs, "sys"), { recursive: true });
    await writeFile(
        path.join(rootfs, "etc/hosts"),
        "127.0.0.1 localhost api.opensea.io stream-api.opensea.io\n::1 localhost\n",
    );

    const raw = path.join(run, "guest.ext4");
    await command("truncate", ["-s", "2G", raw]);
    await command("mke2fs", ["-q", "-t", "ext4", "-F", "-d", rootfs, raw], {
        log: path.join(logs, "filesystem.log"),
    });
    const guest = path.join(run, "guest.qcow2");
    await engineCommand(
        local(config.qemuImg),
        ["convert", "-f", "raw", "-O", "qcow2", raw, guest],
        { cwd: run },
    );
    await assertBuildInputsUnchanged();
    const sourceSha = runtimeSource.sourceCommit;
    const manifest = {
        version: 1,
        sourceSha,
        qualificationId: scenario.qualificationId,
        expectedChecks: scenario.expectedChecks,
        machine: config.machine,
        storageProfile: config.storageProfile,
        cpu: config.cpu,
        epoch: config.epoch,
        // TCG executes the complete multi-process runtime much more slowly than
        // native execution. This host watchdog does not alter guest deadlines.
        timeoutSeconds: 1800,
        qemu: {
            ...(await pin(local(config.qemu), run)),
            version: (
                await engineCommand(local(config.qemu), ["--version"])
            ).split(/\r?\n/, 1)[0],
        },
        qemuImg: {
            ...(await pin(local(config.qemuImg), run)),
            version: (
                await engineCommand(local(config.qemuImg), ["--version"])
            ).split(/\r?\n/, 1)[0],
        },
        kernel: await pin(local(config.kernel), run),
        firmware: await pin(local(config.firmware), run),
        guest: await pin(guest, run),
        scenario: await pin(scenarioDisk.diskPath, run),
        ...(config.toolCapsuleFile
            ? { toolCapsule: await pin(local(config.toolCapsuleFile), run) }
            : {}),
    };
    await writeFile(
        path.join(run, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const payload = [];
    async function inventory(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) await inventory(filename);
            else if (entry.isFile())
                payload.push(await pin(filename, workbench));
            else if (entry.isSymbolicLink())
                payload.push({
                    path: path.relative(workbench, filename),
                    symlink: await readlink(filename),
                });
        }
    }
    await inventory(workbench);
    payload.sort((left, right) => left.path.localeCompare(right.path));
    const provenance = {
        version: 1,
        sourceCommit: sourceSha,
        payload,
        sourceInputs: runtimeSource.files,
        coordinatorInputs,
        sourceIdentity:
            "parent commit plus exact tracked and untracked compilation input bytes",
        images: {
            runtime: config.runtimeImage,
            builder: config.builderImage,
            busybox: config.busyboxImage,
        },
        containerArtifacts,
        kernel: manifest.kernel,
        firmware: manifest.firmware,
        scenario,
        admittedInputs,
        boundary: "headless-data-plane",
        qualified: false,
    };
    await writeFile(
        path.join(run, "provenance.json"),
        `${JSON.stringify(provenance, null, 2)}\n`,
    );
    console.log(
        `Guest prepared; execution remains unqualified: ${path.relative(ROOT, path.join(run, "manifest.json"))}`,
    );
    return { run, manifest };
}

/**
 * Reuse an admitted pristine runtime image, replacing only its coordinator.
 * Compiler/cache compatibility is attested by reproducing the old bundle;
 * this does not invent a historical dependency inventory for older builders.
 */
export async function rebuildGuestCoordinator({
    baseManifestPath,
    debugfs,
    e2fsck,
    outputRoot = path.join(ROOT, "tmp/simulation"),
    execute = executeCommand,
    captureSource = () => snapshotSource(ROOT, { execute }),
    compile = bundleCoordinator,
}) {
    for (const [name, value] of Object.entries({ debugfs, e2fsck }))
        if (typeof value !== "string" || !path.isAbsolute(value))
            throw new Error(`An explicit installed ${name} path is required`);
    const baseFile = await assertWorktreeTemporaryPath(baseManifestPath);
    const provenanceFile = await assertWorktreeTemporaryPath(
        path.join(path.dirname(baseFile), "provenance.json"),
    );
    const baseManifestPin = await pin(baseFile);
    const baseProvenancePin = await pin(provenanceFile);
    const admitted = await preflight(baseFile, { execute });
    const base = admitted.manifest;
    const previous = JSON.parse(await readFile(provenanceFile, "utf8"));
    if (
        previous.version !== 1 ||
        previous.boundary !== "headless-data-plane" ||
        previous.sourceCommit !== base.sourceSha ||
        previous.scenario?.qualificationId !== base.qualificationId ||
        !isDeepStrictEqual(
            previous.scenario?.expectedChecks,
            base.expectedChecks,
        )
    )
        throw new Error(
            "The pristine guest and paired build provenance disagree",
        );
    const assets = sourceMap(previous.payload);
    const originalBundle = assets.get("guest/guest.mjs");
    const originalInit = assets.get("init");
    if (!originalBundle?.sha256 || !originalInit?.sha256)
        throw new Error(
            "Base provenance must pin the fixed coordinator and init",
        );
    const before = await captureSource();
    const changes = assertCoordinatorOnlySourceChanges(
        previous.sourceInputs,
        before.files,
    );
    const fixedTools = {
        debugfs: await pin(debugfs),
        e2fsck: await pin(e2fsck),
    };
    const inheritedInputs = Object.fromEntries(
        await Promise.all(
            Object.entries(previous.admittedInputs ?? {}).map(
                async ([name, expected]) => {
                    const actual = await pin(
                        path.resolve(path.dirname(baseFile), expected.path),
                    );
                    if (!isDeepStrictEqual(actual, expected))
                        throw new Error(
                            `Inherited build input changed: ${name}`,
                        );
                    return [name, actual];
                },
            ),
        ),
    );
    const run = await createArtifactRunDirectory(
        outputRoot,
        "guest-coordinator-",
    );
    const logs = path.join(run, "logs");
    await mkdir(logs);
    const operations = [];
    const runTool = async (binary, args, label, executor = execute) => {
        const log = path.join(logs, `${label}.log`);
        operations.push({ binary, args, log, cwd: run });
        await writeFile(
            path.join(run, "operations.json"),
            `${JSON.stringify(operations, null, 2)}\n`,
        );
        await command(binary, args, {
            cwd: run,
            execute: executor,
            timeoutMs: 120_000,
            log,
            env:
                executor === admitted.execute
                    ? QEMU_ENVIRONMENT
                    : { ...process.env, LANG: "C", LC_ALL: "C" },
        });
        return {
            stdout: await readFile(`${log}.stdout`, "utf8"),
            stderr: await readFile(log, "utf8"),
        };
    };
    const assertOrigins = async () => {
        for (const expected of [
            baseManifestPin,
            baseProvenancePin,
            ...Object.values(fixedTools),
            ...Object.values(inheritedInputs),
        ])
            if (!isDeepStrictEqual(await pin(expected.path), expected))
                throw new Error(
                    `Coordinator rebuild input changed: ${expected.path}`,
                );
        await preflight(baseFile, { execute });
    };
    try {
        const oldSources = sourceMap(previous.sourceInputs);
        const overrides = new Map();
        await mkdir(path.join(run, "baseline-sources"));
        for (const [index, filename] of changes.entries()) {
            const expected = oldSources.get(filename);
            if (!expected) continue;
            const contents = await command(
                "git",
                ["show", `${previous.sourceCommit}:${filename}`],
                { execute },
            );
            const retained = path.join(run, "baseline-sources", `${index}.mjs`);
            await writeFile(retained, contents, { flag: "wx" });
            const actual = await pin(retained);
            if (
                actual.sha256 !== expected.sha256 ||
                actual.sizeBytes !== expected.sizeBytes
            )
                throw new Error(
                    `Cannot reconstruct admitted baseline source: ${filename}`,
                );
            overrides.set(path.resolve(ROOT, filename), {
                contents,
                pin: expected,
            });
        }
        const baselinePath = path.join(run, "baseline-coordinator.mjs");
        const baselineBuild = await compile({
            outfile: baselinePath,
            overrides,
        });
        const baselinePin = await pin(baselinePath);
        if (
            baselinePin.sha256 !== originalBundle.sha256 ||
            baselinePin.sizeBytes !== originalBundle.sizeBytes
        )
            throw new Error(
                "Current compiler/dependencies cannot reproduce the admitted baseline coordinator",
            );
        const baselineInputs = await coordinatorInputPins(
            baselineBuild,
            overrides,
        );
        const coordinatorPath = path.join(run, "coordinator.mjs");
        const currentBuild = await compile({ outfile: coordinatorPath });
        const coordinatorInputs = await coordinatorInputPins(currentBuild);
        const addedRepositoryInputs = admitCoordinatorDependencies(
            baselineInputs,
            coordinatorInputs,
            previous.sourceInputs,
            before.files,
        );
        const compiledBundle = await pin(coordinatorPath);
        assertSameSource(before, await captureSource());
        await assertOrigins();
        const sourceInfo = JSON.parse(
            (
                await runTool(
                    base.qemuImg.path,
                    ["info", "--output=json", base.guest.path],
                    "source-image",
                    admitted.execute,
                )
            ).stdout,
        );
        const raw = path.join(run, "guest.ext4");
        await runTool(
            base.qemuImg.path,
            ["convert", "-f", "qcow2", "-O", "raw", base.guest.path, raw],
            "flatten",
            admitted.execute,
        );
        if ((await stat(raw)).size !== sourceInfo["virtual-size"])
            throw new Error(
                "Flattened guest size differs from the admitted image",
            );
        for (const [label, operation] of [
            ["absent-state", "stat /workbench/state"],
            ["absent-output", "stat /workbench/output"],
        ]) {
            const check = await runTool(
                debugfs,
                ["-R", operation, "guest.ext4"],
                label,
            );
            if (
                check.stdout.trim() ||
                !/File not found by ext2_lookup/.test(check.stderr)
            )
                throw new Error(
                    "Coordinator reuse requires a pristine guest without state or output stores",
                );
        }
        const fixedFile = await runTool(
            debugfs,
            ["-R", "stat /workbench/guest/guest.mjs", "guest.ext4"],
            "old-bundle-stat",
        );
        if (!/Type:\s+regular\b/.test(fixedFile.stdout))
            throw new Error(
                "The fixed guest coordinator must be a regular file",
            );
        await runTool(
            debugfs,
            [
                "-R",
                "dump /workbench/guest/guest.mjs original-guest.mjs",
                "guest.ext4",
            ],
            "old-bundle-readback",
        );
        const oldBundle = await pin(path.join(run, "original-guest.mjs"));
        if (
            oldBundle.sha256 !== originalBundle.sha256 ||
            oldBundle.sizeBytes !== originalBundle.sizeBytes
        )
            throw new Error(
                "The pristine guest bundle differs from its build provenance",
            );
        await runTool(
            debugfs,
            ["-R", "dump /workbench/init original-init", "guest.ext4"],
            "old-init-readback",
        );
        if (
            (await hashFile(path.join(run, "original-init"))) !==
            originalInit.sha256
        )
            throw new Error(
                "The admitted guest init differs from its build provenance",
            );
        await runTool(e2fsck, ["-f", "-n", "guest.ext4"], "filesystem-before");
        for (const [label, operation] of [
            ["remove-bundle", "rm /workbench/guest/guest.mjs"],
            [
                "write-bundle",
                "write coordinator.mjs /workbench/guest/guest.mjs",
            ],
            [
                "bundle-mode",
                "set_inode_field /workbench/guest/guest.mjs mode 0100644",
            ],
        ])
            await runTool(
                debugfs,
                ["-w", "-R", operation, "guest.ext4"],
                label,
            );
        await runTool(
            debugfs,
            [
                "-R",
                "dump /workbench/guest/guest.mjs readback-guest.mjs",
                "guest.ext4",
            ],
            "new-bundle-readback",
        );
        const readback = await pin(path.join(run, "readback-guest.mjs"));
        if (
            readback.sha256 !== compiledBundle.sha256 ||
            readback.sizeBytes !== compiledBundle.sizeBytes
        )
            throw new Error(
                "Updated coordinator readback differs from the compiled bytes",
            );
        await runTool(
            debugfs,
            ["-R", "dump /workbench/init readback-init", "guest.ext4"],
            "new-init-readback",
        );
        if (
            (await hashFile(path.join(run, "readback-init"))) !==
            originalInit.sha256
        )
            throw new Error("Coordinator update changed the inherited init");
        await runTool(e2fsck, ["-f", "-n", "guest.ext4"], "filesystem-after");
        const guest = path.join(run, "guest.qcow2");
        await runTool(
            base.qemuImg.path,
            ["convert", "-f", "raw", "-O", "qcow2", raw, guest],
            "standalone",
            admitted.execute,
        );
        const manifest = {
            ...base,
            sourceSha: before.sourceCommit,
            guest: await pin(guest, run),
        };
        const candidate = path.join(run, "admission-candidate.json");
        const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
        // Retain evidence without publishing a runnable manifest before the
        // final source/origin checks; failed candidates must remain unusable.
        await writeFile(
            candidate,
            `${JSON.stringify({ version: 1, published: false, candidate: manifest }, null, 2)}\n`,
            { flag: "wx" },
        );
        await preflightManifest(manifest, path.join(run, "manifest.json"), {
            execute,
        });
        for (const expected of [baselinePin, compiledBundle, readback])
            if (!isDeepStrictEqual(await pin(expected.path), expected))
                throw new Error(
                    "Coordinator compilation/readback artifact changed before publication",
                );
        for (const expected of coordinatorInputs)
            if (
                !isDeepStrictEqual(
                    await pin(path.resolve(ROOT, expected.path), ROOT),
                    expected,
                )
            )
                throw new Error(
                    `Coordinator input changed after compilation: ${expected.path}`,
                );
        const after = await captureSource();
        assertSameSource(before, after);
        await assertOrigins();
        const inputPaths = new Set(
            coordinatorInputs.map((entry) => entry.path),
        );
        const provenance = {
            ...previous,
            sourceCommit: before.sourceCommit,
            sourceInputs: before.files,
            sourceIdentity:
                "admitted inherited runtime bytes plus exact current coordinator compilation inputs",
            runtimeOrigin: {
                baseManifest: baseManifestPin,
                baseGuest: base.guest,
                baseProvenance: baseProvenancePin,
                sourceCommit:
                    previous.runtimeOrigin?.sourceCommit ??
                    previous.sourceCommit,
                assembledBaseSourceCommit: previous.sourceCommit,
            },
            coordinatorInputs,
            coordinatorUpdate: {
                before,
                after,
                compiledBundle,
                readback,
                tools: fixedTools,
                appliedCoordinatorChanges: changes.filter((filename) =>
                    inputPaths.has(filename),
                ),
                hostToolOrTestChanges: changes.filter(
                    (filename) => !inputPaths.has(filename),
                ),
                compatibility: {
                    kind: "baseline-bundle-byte-identity",
                    originalBundle,
                    reconstructedBundle: baselinePin,
                    baselineInputs,
                    addedRepositoryInputs,
                },
                filesystemIntegrity: "read-only-e2fsck-passed",
            },
            payload: previous.payload.map((entry) =>
                entry.path === "guest/guest.mjs"
                    ? {
                          path: entry.path,
                          sizeBytes: readback.sizeBytes,
                          sha256: readback.sha256,
                      }
                    : entry,
            ),
            containerArtifacts: [],
            qualified: false,
        };
        await writeFile(
            path.join(run, "provenance.json"),
            `${JSON.stringify(provenance, null, 2)}\n`,
            { flag: "wx" },
        );
        // Publish only after image, source and inherited-input admission finishes.
        await writeFile(path.join(run, "manifest.json"), encoded, {
            flag: "wx",
        });
        return { run, manifest };
    } catch (error) {
        await writeFile(
            path.join(run, "failure.json"),
            `${JSON.stringify({ qualified: false, error: error.message }, null, 2)}\n`,
        ).catch(() => {});
        error.artifactsDirectory = run;
        throw error;
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    if (
        process.argv.length === 9 &&
        process.argv[2] === "--rebuild-coordinator" &&
        process.argv[3] === "--base-manifest" &&
        process.argv[5] === "--debugfs" &&
        process.argv[7] === "--e2fsck"
    ) {
        await rebuildGuestCoordinator({
            baseManifestPath: process.argv[4],
            debugfs: process.argv[6],
            e2fsck: process.argv[8],
        })
            .then((result) => console.log(JSON.stringify(result, null, 2)))
            .catch((error) => {
                console.error(
                    `${error.message}${error.artifactsDirectory ? `; artifacts: ${error.artifactsDirectory}` : ""}`,
                );
                process.exitCode = 1;
            });
    } else if (process.argv.length !== 4 || process.argv[2] !== "--config") {
        console.error(
            "Usage: build-guest.mjs --config INPUT.json | --rebuild-coordinator --base-manifest BASE.json --debugfs /path/to/debugfs --e2fsck /path/to/e2fsck",
        );
        process.exitCode = 1;
    } else
        await buildGuest(process.argv[3]).catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}
