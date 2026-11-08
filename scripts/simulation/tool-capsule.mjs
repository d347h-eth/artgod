#!/usr/bin/env node
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    assertWorktreeTemporaryPath,
    createArtifactRunDirectory,
    hashFile,
    pinFile,
} from "./artifacts.mjs";
import { runOwnedContainer, withOwnedContainer } from "./docker.mjs";
import { readInputPins } from "./input-pins.mjs";
import { executeCommand, preflight, QEMU_ENVIRONMENT } from "./qemu-replay.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const CAPSULE_TOOL_PATHS = Object.freeze({
    qemu: "/usr/bin/qemu-system-x86_64",
    qemuImg: "/usr/bin/qemu-img",
    firmware: "/usr/share/qemu/qboot.rom",
});
const TOOL_NAMES = Object.keys(CAPSULE_TOOL_PATHS);

function exact(value, keys, label) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    )
        throw new Error(`${label} requires exactly ${keys.join(", ")}`);
}

function assertPin(pin, label, version = false) {
    exact(
        pin,
        ["path", "sha256", "sizeBytes", ...(version ? ["version"] : [])],
        label,
    );
    if (
        typeof pin.path !== "string" ||
        !pin.path ||
        /[\x00-\x1f]/.test(pin.path) ||
        !/^[a-f0-9]{64}$/.test(pin.sha256 ?? "") ||
        !Number.isSafeInteger(pin.sizeBytes) ||
        pin.sizeBytes <= 0 ||
        (version &&
            (typeof pin.version !== "string" ||
                !pin.version ||
                /[\r\n]/.test(pin.version)))
    )
        throw new Error(`Invalid ${label} byte pin`);
}

export function validateToolCapsule(value, filename) {
    exact(
        value,
        ["version", "architecture", "imageId", "archive", "tools", "build"],
        "Tool capsule",
    );
    if (
        value.version !== 1 ||
        value.architecture !== "amd64" ||
        !/^sha256:[a-f0-9]{64}$/.test(value.imageId ?? "")
    )
        throw new Error(
            "Tool capsule requires version 1, amd64 and an immutable image ID",
        );
    exact(value.tools, TOOL_NAMES, "Capsule tools");
    exact(value.build, ["baseImage", "dockerfileSha256"], "Capsule build");
    if (
        !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(
            value.build.baseImage ?? "",
        ) ||
        !/^[a-f0-9]{64}$/.test(value.build.dockerfileSha256 ?? "")
    )
        throw new Error(
            "Capsule build provenance must pin its base and Dockerfile",
        );
    const result = structuredClone(value);
    assertPin(value.archive, "Capsule archive");
    result.archive.path = path.resolve(
        path.dirname(filename),
        value.archive.path,
    );
    for (const name of TOOL_NAMES) {
        assertPin(value.tools[name], name, name !== "firmware");
        result.tools[name].path = path.resolve(
            path.dirname(filename),
            value.tools[name].path,
        );
    }
    return result;
}

function assertSuccess(result, operation) {
    if (
        !result ||
        result.code !== 0 ||
        result.signal ||
        result.timedOut ||
        result.outputLimit
    )
        throw new Error(
            `${operation} failed: ${result?.timedOut ? "timeout" : result?.outputLimit ? "output limit" : (result?.signal ?? result?.code)}${result?.stderr ? `; ${result.stderr.slice(-2000)}` : ""}`,
        );
    return result;
}

async function assertCapsuleBytes(capsule) {
    for (const [name, pin] of Object.entries({
        archive: capsule.archive,
        ...capsule.tools,
    })) {
        const metadata = await stat(pin.path);
        if (
            !metadata.isFile() ||
            metadata.size !== pin.sizeBytes ||
            (await hashFile(pin.path)) !== pin.sha256
        )
            throw new Error(`Pinned capsule ${name} bytes changed`);
    }
}

/** Read-only admission never pulls, loads or rebuilds an absent tool image. */
export async function admitToolCapsule(
    filename,
    { execute = executeCommand, manifest } = {},
) {
    const absolute = path.resolve(filename);
    const capsule = validateToolCapsule(
        JSON.parse(await readFile(absolute, "utf8")),
        absolute,
    );
    await assertCapsuleBytes(capsule);
    if (manifest)
        for (const name of TOOL_NAMES) {
            if (
                manifest[name].sha256 !== capsule.tools[name].sha256 ||
                manifest[name].sizeBytes !== capsule.tools[name].sizeBytes ||
                (name !== "firmware" &&
                    manifest[name].version !== capsule.tools[name].version)
            )
                throw new Error(
                    `Manifest ${name} does not match the tool capsule`,
                );
        }
    const inspected = assertSuccess(
        await execute(
            "docker",
            ["image", "inspect", "--format", "{{json .}}", capsule.imageId],
            { cwd: ROOT, env: process.env, timeoutMs: 15_000 },
        ),
        "Capsule image inspection",
    );
    const image = JSON.parse(inspected.stdout);
    if (
        image.Id !== capsule.imageId ||
        image.Architecture !== "amd64" ||
        image.Os !== "linux"
    )
        throw new Error(
            "Loaded tool image identity/platform differs from its capsule",
        );
    return capsule;
}

/** Only the two admitted engine binaries can cross this external process boundary. */
export async function createToolCapsuleExecutor({
    filename,
    manifest,
    execute = executeCommand,
}) {
    const capsule = await admitToolCapsule(filename, { execute, manifest });
    for (const name of ["firmware", "kernel", "guest", "scenario"])
        if (
            manifest[name] &&
            !path.resolve(manifest[name].path).startsWith(`${ROOT}${path.sep}`)
        )
            throw new Error(
                `Capsule ${name} input must be inside the mounted worktree`,
            );
    const files = new Map(
        ["qemu", "qemuImg"].map((name) => [
            manifest[name].path,
            CAPSULE_TOOL_PATHS[name],
        ]),
    );
    return async (file, args, options = {}) => {
        if (
            !files.has(file) ||
            !Array.isArray(args) ||
            args.some(
                (arg) => typeof arg !== "string" || /[\x00-\x1f]/.test(arg),
            )
        )
            throw new Error(
                "Capsule executor accepts only the admitted engine binaries and argument strings",
            );
        if (options.env && !isDeepStrictEqual(options.env, QEMU_ENVIRONMENT))
            throw new Error(
                "Capsule engine environment must match the fixed replay profile",
            );
        const cwd = path.resolve(options.cwd ?? ROOT);
        if (cwd !== ROOT) await assertWorktreeTemporaryPath(cwd);
        for (const target of [options.stdoutPath, options.stderrPath])
            if (target) await assertWorktreeTemporaryPath(target);
        await assertCapsuleBytes(capsule);
        const workload = [
            "/usr/bin/env",
            "-i",
            ...Object.entries(QEMU_ENVIRONMENT).map(
                ([key, value]) => `${key}=${value}`,
            ),
            files.get(file),
            ...args,
        ];
        const result = await runOwnedContainer({
            image: capsule.imageId,
            command: workload,
            mounts: [
                { source: ROOT, target: ROOT },
                ...(cwd === ROOT
                    ? []
                    : [{ source: cwd, target: cwd, readOnly: false }]),
            ],
            workdir: cwd,
            timeoutMs: options.timeoutMs ?? 15_000,
            execute: async (binary, dockerArgs, dockerOptions) =>
                execute(binary, dockerArgs, {
                    ...dockerOptions,
                    ...(dockerArgs[0] === "start"
                        ? {
                              ...(options.stdoutPath
                                  ? { stdoutPath: options.stdoutPath }
                                  : {}),
                              ...(options.stderrPath
                                  ? { stderrPath: options.stderrPath }
                                  : {}),
                          }
                        : {}),
                }),
        });
        await assertCapsuleBytes(capsule);
        return result;
    };
}

/** Explicit provisioning builds packages inside a disposable image, never on the host. */
export async function prepareToolCapsule({
    outputRoot = path.join(ROOT, "tmp/simulation-tools"),
    execute = executeCommand,
} = {}) {
    const pins = await readInputPins();
    const directory = await createArtifactRunDirectory(outputRoot, "tools-");
    const context = path.join(directory, "context");
    await mkdir(context);
    const dockerfile = `FROM ${pins.toolBaseImage}\nRUN apt-get update && apt-get install -y --no-install-recommends qemu-system-x86 qemu-system-data qemu-utils && rm -rf /var/lib/apt/lists/*\nENV LANG=C LC_ALL=C TZ=UTC\nENTRYPOINT []\nCMD ["/usr/bin/true"]\n`;
    const dockerfilePath = path.join(context, "Dockerfile");
    await writeFile(dockerfilePath, dockerfile);
    let sequence = 0;
    const command = async (args, timeoutMs = 600_000) => {
        const prefix = path.join(directory, `docker-${++sequence}`);
        const result = await execute("docker", args, {
            cwd: ROOT,
            env: process.env,
            timeoutMs,
            stdoutPath: `${prefix}.stdout`,
            stderrPath: `${prefix}.stderr`,
        });
        return assertSuccess(result, `Docker ${args[0]}`);
    };
    const iid = path.join(directory, "image.id");
    await command([
        "build",
        "--platform",
        "linux/amd64",
        "--network",
        "default",
        "--iidfile",
        iid,
        "--file",
        dockerfilePath,
        context,
    ]);
    const imageId = (await readFile(iid, "utf8")).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
        throw new Error("Docker returned an invalid tool image ID");
    const archive = path.join(directory, "tool-image.tar");
    await command(["image", "save", "--output", archive, imageId]);
    const tools = {};
    await withOwnedContainer(
        {
            image: imageId,
            artifactParent: path.join(directory, "containers"),
            execute,
        },
        async (container) => {
            for (const name of TOOL_NAMES) {
                const destination = path.join(
                    directory,
                    path.basename(CAPSULE_TOOL_PATHS[name]),
                );
                await container.copyFrom(CAPSULE_TOOL_PATHS[name], destination);
                await chmod(destination, name === "firmware" ? 0o444 : 0o555);
                tools[name] = await pinFile(destination, directory);
            }
        },
    );
    for (const name of ["qemu", "qemuImg"]) {
        const version = await runOwnedContainer({
            image: imageId,
            command: [CAPSULE_TOOL_PATHS[name], "--version"],
            artifactParent: path.join(directory, "containers"),
            execute,
        });
        tools[name].version = version.stdout.split(/\r?\n/, 1)[0];
    }
    const capsule = {
        version: 1,
        architecture: "amd64",
        imageId,
        archive: await pinFile(archive, directory),
        tools,
        build: {
            baseImage: pins.toolBaseImage,
            dockerfileSha256: await hashFile(dockerfilePath),
        },
    };
    const filename = path.join(directory, "tool-capsule.json");
    await writeFile(filename, `${JSON.stringify(capsule, null, 2)}\n`);
    await admitToolCapsule(filename, { execute });
    return { directory, filename, capsule };
}

/** Restore only an explicitly selected, byte-verified saved image. */
export async function restoreToolCapsule(
    filename,
    { execute = executeCommand } = {},
) {
    const absolute = path.resolve(filename);
    const capsule = validateToolCapsule(
        JSON.parse(await readFile(absolute, "utf8")),
        absolute,
    );
    await assertCapsuleBytes(capsule);
    assertSuccess(
        await execute(
            "docker",
            ["image", "load", "--input", capsule.archive.path],
            { cwd: ROOT, env: process.env, timeoutMs: 600_000 },
        ),
        "Capsule image load",
    );
    return await admitToolCapsule(absolute, { execute });
}

/** Select a new engine for a new execution; this never modifies an existing run. */
export async function bindToolCapsule({
    manifestFile,
    capsuleFile,
    outputRoot = path.join(ROOT, "tmp/simulation-tools"),
    execute = executeCommand,
}) {
    const admitted = await preflight(manifestFile, { execute });
    const capsule = await admitToolCapsule(capsuleFile, { execute });
    const manifest = {
        ...admitted.manifest,
        ...Object.fromEntries(
            TOOL_NAMES.map((name) => [name, capsule.tools[name]]),
        ),
        toolCapsule: await pinFile(path.resolve(capsuleFile)),
    };
    const directory = await createArtifactRunDirectory(outputRoot, "bound-");
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await preflight(manifestPath, { execute });
    return { directory, manifestPath, manifest };
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    const args = process.argv.slice(2);
    const run = () => {
        if (args.length === 1 && args[0] === "build")
            return prepareToolCapsule();
        if (args.length === 2 && args[0] === "restore")
            return restoreToolCapsule(args[1]);
        if (
            args.length === 5 &&
            args[0] === "bind" &&
            args[1] === "--manifest" &&
            args[3] === "--capsule"
        )
            return bindToolCapsule({
                manifestFile: args[2],
                capsuleFile: args[4],
            });
        throw new Error(
            "Usage: tool-capsule.mjs build | restore FILE | bind --manifest FILE --capsule FILE",
        );
    };
    Promise.resolve()
        .then(run)
        .then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}
