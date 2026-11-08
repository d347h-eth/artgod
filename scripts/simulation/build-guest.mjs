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
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildSqliteNativeBinding } from "../build/build-sqlite-native-binding.mjs";
import { stageDesktopRuntimeDependencies } from "../build/desktop-runtime-dependency-staging.mjs";
import { projectYarnCommand } from "../build/project-yarn-command.mjs";
import { readDesktopRuntimeInputs } from "../build/desktop-runtime-inputs.mjs";
import { executeCommand, QEMU_ENVIRONMENT } from "./qemu-replay.mjs";
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
import { pinFile as pin, createArtifactRunDirectory } from "./artifacts.mjs";
import { snapshotSource, assertSameSource } from "./source-snapshot.mjs";
import {
    admitToolCapsule,
    createToolCapsuleExecutor,
} from "./tool-capsule.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
    await build({
        absWorkingDir: ROOT,
        entryPoints: ["scripts/simulation/guest/guest.mjs"],
        outfile: path.join(workbench, "guest/guest.mjs"),
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node24",
        external: ["better-sqlite3"],
        banner: {
            js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
        },
        logLevel: "warning",
    });
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

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    if (process.argv.length !== 4 || process.argv[2] !== "--config") {
        console.error(
            "Usage: yarn node scripts/simulation/build-guest.mjs --config <explicit-local-config.json>",
        );
        process.exitCode = 1;
    } else
        await buildGuest(process.argv[3]).catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}
