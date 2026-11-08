import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    createArtifactRunDirectory,
    assertWorktreeTemporaryPath,
} from "./artifacts.mjs";
import { executeCommand } from "./qemu-replay.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const DOCKER_OWNER_LABEL = "network.artgod.simulation.owner";
export const CONTAINER_MOUNT_TARGET = Object.freeze({
    Certificates: "/certs",
    NativePackage: "/native",
});

export function assertImageReference(value) {
    if (
        typeof value !== "string" ||
        !/^(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/.test(value)
    )
        throw new Error(
            "Builder image requires an immutable image@sha256 reference",
        );
}

function assertArguments(value, label) {
    if (
        !Array.isArray(value) ||
        value.some(
            (part) => typeof part !== "string" || /[\x00-\x1f]/.test(part),
        )
    )
        throw new Error(`${label} must be explicit argument strings`);
}

async function validateMount(mount) {
    if (
        !mount ||
        Object.keys(mount).some(
            (key) => !["source", "target", "readOnly"].includes(key),
        ) ||
        typeof mount.source !== "string" ||
        /[,\x00-\x1f]/.test(mount.source) ||
        typeof mount.target !== "string" ||
        mount.target === "/" ||
        !mount.target.startsWith("/") ||
        path.posix.normalize(mount.target) !== mount.target ||
        /[,\x00-\x1f]/.test(mount.target) ||
        ["/dev", "/proc", "/sys", "/run", "/var/run"].some(
            (root) =>
                mount.target === root || mount.target.startsWith(`${root}/`),
        ) ||
        (mount.readOnly !== undefined && typeof mount.readOnly !== "boolean")
    )
        throw new Error(
            "Mounts require explicit worktree sources, ordinary absolute targets and a boolean readOnly policy",
        );
    const source = await realpath(mount.source);
    const workspace = await realpath(ROOT);
    const metadata = await stat(source);
    if (
        (source !== workspace &&
            !source.startsWith(`${workspace}${path.sep}`)) ||
        (!metadata.isDirectory() && !metadata.isFile())
    )
        throw new Error(
            "Mount source must be an ordinary file/directory inside this worktree",
        );
    return { source, target: mount.target, readOnly: mount.readOnly ?? true };
}

async function freshOutput(filename) {
    const destination = await assertWorktreeTemporaryPath(filename);
    try {
        await lstat(destination);
        throw new Error(
            "Container copy/export cannot overwrite an existing artifact",
        );
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    return destination;
}

function assertSuccessful(result, action) {
    if (
        !result ||
        result.code !== 0 ||
        result.signal ||
        result.timedOut ||
        result.outputLimit
    ) {
        const error = new Error(
            `Docker ${action} failed: ${result?.timedOut ? "timeout" : result?.outputLimit ? "output limit" : (result?.signal ?? result?.code ?? "invalid executor result")}${result?.stderr ? `; ${result.stderr.slice(-2000)}` : ""}`,
        );
        error.result = result;
        throw error;
    }
    return result;
}

/** Docker daemon ownership survives a lost CLI reply, timeout or interruption. */
export async function withOwnedContainer(options, operation) {
    const allowed = [
        "image",
        "command",
        "mounts",
        "workdir",
        "timeoutMs",
        "artifactParent",
        "execute",
    ];
    if (!options || Object.keys(options).some((key) => !allowed.includes(key)))
        throw new Error("Unknown owned-container option");
    const {
        image,
        command = ["/bin/true"],
        mounts = [],
        workdir,
        timeoutMs = 30_000,
        artifactParent = path.join(ROOT, "tmp", "simulation-docker"),
        execute = executeCommand,
    } = options;
    assertImageReference(image);
    assertArguments(command, "Container command");
    if (
        typeof operation !== "function" ||
        typeof execute !== "function" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 3_600_000
    )
        throw new Error(
            "Owned container requires a callback/executor and bounded timeout",
        );
    if (!Array.isArray(mounts) || mounts.length > 8)
        throw new Error("Container mount list is invalid");
    const bound = await Promise.all(mounts.map(validateMount));
    if (new Set(bound.map((mount) => mount.target)).size !== bound.length)
        throw new Error("Container targets cannot repeat");
    if (
        workdir !== undefined &&
        !bound.some(
            (mount) =>
                mount.target === workdir ||
                (typeof workdir === "string" &&
                    workdir.startsWith(`${mount.target}/`) &&
                    path.posix.normalize(workdir) === workdir),
        )
    )
        throw new Error(
            "Container working directory must name its explicit mount",
        );
    const directory = await createArtifactRunDirectory(
        artifactParent,
        "container-",
    );
    const owner = randomUUID();
    const name = `artgod-simulation-${owner}`;
    const descriptor = {
        version: 1,
        name,
        ownerLabel: DOCKER_OWNER_LABEL,
        owner,
        image,
        phase: "planned",
        cleanup: "pending",
        commands: [],
    };
    const descriptorPath = path.join(directory, "container.json");
    const cidPath = path.join(directory, "container.cid");
    const persist = () =>
        writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    await persist();
    const invoke = async (args, budget = 15_000, cleanup = false) => {
        const sequence = descriptor.commands.length + 1;
        const prefix = path.join(directory, `command-${sequence}`);
        descriptor.commands.push({
            args,
            stdout: `${path.basename(prefix)}.stdout`,
            stderr: `${path.basename(prefix)}.stderr`,
        });
        if (!cleanup) await persist();
        else
            await persist().catch((error) => {
                descriptor.artifactError = error.message;
            });
        // The common executor bounds captured bytes. Inspect/version replies must
        // remain available to the owner as well as retained in diagnostics.
        const result = await execute("docker", args, {
            cwd: directory,
            env: process.env,
            timeoutMs: budget,
        });
        const retain = () =>
            Promise.all([
                writeFile(`${prefix}.stdout`, result.stdout ?? ""),
                writeFile(`${prefix}.stderr`, result.stderr ?? ""),
            ]);
        if (!cleanup) await retain();
        else
            await retain().catch((error) => {
                descriptor.artifactError = error.message;
            });
        return result;
    };
    const inspectOwned = async (cleanup = false) => {
        const inspected = await invoke(
            ["inspect", "--format", "{{json .Config.Labels}}", name],
            15_000,
            cleanup,
        );
        if (
            inspected.code !== 0 &&
            !inspected.timedOut &&
            !inspected.signal &&
            /No such (object|container)/i.test(inspected.stderr)
        )
            return false;
        assertSuccessful(inspected, "ownership inspection");
        const labels = JSON.parse(inspected.stdout);
        if (labels?.[DOCKER_OWNER_LABEL] !== owner)
            throw new Error(
                "Refusing operation on container without the matching simulation owner label",
            );
        return true;
    };
    const requireOwned = async () => {
        if (!(await inspectOwned()))
            throw new Error("Owned container disappeared before its operation");
    };
    const control = {
        name,
        artifactsDirectory: directory,
        async start() {
            if (!options.command?.length)
                throw new Error(
                    "Container execution requires an explicit command",
                );
            await requireOwned();
            descriptor.phase = "running";
            await persist();
            return assertSuccessful(
                await invoke(["start", "--attach", name], timeoutMs),
                "execution",
            );
        },
        async exportTo(filename) {
            const destination = await freshOutput(filename);
            await requireOwned();
            return assertSuccessful(
                await invoke(
                    ["export", "--output", destination, name],
                    timeoutMs,
                ),
                "export",
            );
        },
        async copyFrom(source, filename) {
            if (
                typeof source !== "string" ||
                !source.startsWith("/") ||
                path.posix.normalize(source) !== source ||
                /[\x00-\x1f]/.test(source)
            )
                throw new Error(
                    "Container copy requires an explicit absolute source",
                );
            const destination = await freshOutput(filename);
            await requireOwned();
            return assertSuccessful(
                await invoke(
                    ["cp", `${name}:${source}`, destination],
                    timeoutMs,
                ),
                "copy",
            );
        },
    };
    let value;
    let failure;
    try {
        descriptor.phase = "creating";
        await persist();
        const args = [
            "create",
            "--pull=never",
            "--name",
            name,
            "--label",
            `${DOCKER_OWNER_LABEL}=${owner}`,
            "--cidfile",
            cidPath,
            "--network",
            "none",
            "--read-only",
            "--user",
            `${process.getuid()}:${process.getgid()}`,
        ];
        for (const mount of bound)
            args.push(
                "--mount",
                `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
            );
        if (workdir) args.push("--workdir", workdir);
        args.push(image, ...command);
        assertSuccessful(await invoke(args), "creation");
        descriptor.phase = "created";
        await persist();
        value = await operation(control);
    } catch (error) {
        failure = error;
    }
    try {
        descriptor.phase = "cleanup";
        await persist().catch((error) => {
            descriptor.artifactError = error.message;
        });
        if (await inspectOwned(true)) {
            assertSuccessful(
                await invoke(["rm", "--force", name], 15_000, true),
                "cleanup",
            );
            descriptor.cleanup = "removed";
        } else descriptor.cleanup = "already-absent";
    } catch (error) {
        descriptor.cleanup = "failed";
        descriptor.cleanupError = error.message;
        failure = failure
            ? new AggregateError(
                  [failure, error],
                  `${failure.message}; cleanup failed: ${error.message}`,
              )
            : error;
    }
    try {
        const cid = (await readFile(cidPath, "utf8")).trim();
        if (/^[a-f0-9]{64}$/.test(cid)) descriptor.containerId = cid;
    } catch (error) {
        if (error.code !== "ENOENT") failure ??= error;
    }
    descriptor.phase = failure ? "failed" : "complete";
    if (failure) descriptor.error = failure.message;
    await persist();
    if (failure) {
        const error = new Error(
            `${failure.message}; Docker artifacts: ${directory}`,
            { cause: failure },
        );
        error.artifactsDirectory = directory;
        throw error;
    }
    return { value, artifactsDirectory: directory };
}

export async function runOwnedContainer(options) {
    if (!Array.isArray(options?.command) || options.command.length === 0)
        throw new Error("Container execution requires an explicit command");
    const { value, artifactsDirectory } = await withOwnedContainer(
        options,
        (container) => container.start(),
    );
    return { ...value, dockerArtifacts: artifactsDirectory };
}
