import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
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
export const DOCKER_NATIVE_CONTROL_POLICY = Object.freeze({
    kind: "native-control-v1",
    platform: "linux/amd64",
    cpuQuota: 1,
    memoryBytes: 2 * 1024 ** 3,
    memorySwapBytes: 2 * 1024 ** 3,
    pidsLimit: 512,
    coreSoftBytes: 1,
    coreHardBytes: 1,
    cgroupnsMode: "private",
});
export const NATIVE_CONTROL_ENVIRONMENT = Object.freeze({
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    ARTGOD_WORKBENCH_ROOT: "/workbench",
    TMPDIR: "/workbench/state/tmp",
    NODE_EXTRA_CA_CERTS: "/workbench/certs/ca.pem",
});

/** Linux's current affinity is an admission input, never an assumed CPU count. */
export async function readNativeControlHostIdentity() {
    const status = await readFile("/proc/self/status", "utf8");
    const match = status.match(/^Cpus_allowed_list:\s*([^\r\n]+)$/m);
    if (!match) throw new Error("Current allowed host CPU list is unavailable");
    return {
        uid: process.getuid(),
        gid: process.getgid(),
        allowedCpuList: match[1].trim(),
    };
}

export function validateNativeControlProfile(value, host) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "cpu,kind" ||
        value.kind !== DOCKER_NATIVE_CONTROL_POLICY.kind ||
        !Number.isSafeInteger(value.cpu) ||
        value.cpu < 0
    )
        throw new Error(
            "Native control requires its fixed kind and one explicit integer CPU",
        );
    if (
        !Number.isSafeInteger(host?.uid) ||
        host.uid <= 0 ||
        !Number.isSafeInteger(host?.gid) ||
        host.gid <= 0 ||
        typeof host.allowedCpuList !== "string"
    )
        throw new Error(
            "Native control requires the fixed nonroot host UID/GID and current CPU affinity",
        );
    const ranges = host.allowedCpuList.split(",").map((part) => {
        const match = part.match(/^(\d+)(?:-(\d+))?$/);
        if (!match)
            throw new Error("Current allowed host CPU list is malformed");
        const first = Number(match[1]),
            last = Number(match[2] ?? match[1]);
        if (
            !Number.isSafeInteger(first) ||
            !Number.isSafeInteger(last) ||
            first > last
        )
            throw new Error("Current allowed host CPU list is malformed");
        return [first, last];
    });
    if (
        !ranges.some(([first, last]) => first <= value.cpu && value.cpu <= last)
    )
        throw new Error(
            "Selected native-control CPU is outside the current allowed affinity",
        );
    return {
        ...DOCKER_NATIVE_CONTROL_POLICY,
        cpu: value.cpu,
        uid: host.uid,
        gid: host.gid,
        allowedCpuList: host.allowedCpuList,
    };
}

const NATIVE_CONTROL_INSPECT_FIELDS = Object.freeze({
    image: ".Image",
    configuredImage: ".Config.Image",
    user: ".Config.User",
    readOnlyRootfs: ".HostConfig.ReadonlyRootfs",
    networkMode: ".HostConfig.NetworkMode",
    capAdd: ".HostConfig.CapAdd",
    capDrop: ".HostConfig.CapDrop",
    securityOpt: ".HostConfig.SecurityOpt",
    cpusetCpus: ".HostConfig.CpusetCpus",
    nanoCpus: ".HostConfig.NanoCpus",
    memoryBytes: ".HostConfig.Memory",
    memorySwapBytes: ".HostConfig.MemorySwap",
    pidsLimit: ".HostConfig.PidsLimit",
    ulimits: ".HostConfig.Ulimits",
    privileged: ".HostConfig.Privileged",
    pidMode: ".HostConfig.PidMode",
    ipcMode: ".HostConfig.IpcMode",
    usernsMode: ".HostConfig.UsernsMode",
    cgroupnsMode: ".HostConfig.CgroupnsMode",
});
const NATIVE_CONTROL_INSPECT_TEMPLATE = `{${Object.entries(
    NATIVE_CONTROL_INSPECT_FIELDS,
)
    .map(([key, field]) => `${JSON.stringify(key)}:{{json ${field}}}`)
    .join(",")}}`;

/** Check configured Docker isolation once; effective proc/cgroup reads remain
 * the native admission shell's responsibility before starting Node.
 */
export function assertNativeControlInspection(receipt, expected, image) {
    const normalized = validateNativeControlProfile(
        { kind: expected?.kind, cpu: expected?.cpu },
        expected,
    );
    assert.deepEqual(
        expected,
        normalized,
        "Native requested policy differs from its fixed owner",
    );
    assert.deepEqual(
        receipt?.requested,
        expected,
        "Native inspected request differs from admission",
    );
    assertImageReference(image);
    const observed = receipt?.observed;
    if (
        !observed ||
        typeof observed !== "object" ||
        Array.isArray(observed) ||
        Object.keys(observed).sort().join(",") !==
            Object.keys(NATIVE_CONTROL_INSPECT_FIELDS).sort().join(",")
    )
        throw new Error("Native profile inspection returned unexpected fields");
    assert.equal(
        observed.configuredImage,
        image,
        "Native configured image changed",
    );
    assert.match(
        observed.image,
        /^sha256:[a-f0-9]{64}$/,
        "Native image identity is missing",
    );
    assert.equal(
        observed.user,
        `${expected.uid}:${expected.gid}`,
        "Native host UID/GID changed",
    );
    assert.equal(
        observed.readOnlyRootfs,
        true,
        "Native root filesystem must remain read-only",
    );
    assert.equal(
        observed.networkMode,
        "none",
        "Native networking must remain private loopback only",
    );
    // Docker may serialize an absent capability list as null or an empty array.
    assert.deepEqual(
        observed.capAdd ?? [],
        [],
        "Native added capabilities are forbidden",
    );
    assert.ok(
        Array.isArray(observed.capDrop),
        "Native capability drop is missing",
    );
    assert.deepEqual(
        observed.capDrop.map((value) =>
            typeof value === "string" ? value.toUpperCase() : value,
        ),
        ["ALL"],
        "Native control must drop all capabilities",
    );
    assert.ok(
        Array.isArray(observed.securityOpt) &&
            observed.securityOpt.length > 0 &&
            observed.securityOpt.every(
                (value) =>
                    typeof value === "string" &&
                    /^no-new-privileges(?:[:=]true)?$/.test(value),
            ),
        "Native security options must retain only no-new-privileges",
    );
    assert.equal(
        observed.cpusetCpus,
        String(expected.cpu),
        "Native CPU affinity changed",
    );
    assert.equal(
        observed.nanoCpus,
        expected.cpuQuota * 1e9,
        "Native CPU quota changed",
    );
    for (const field of ["memoryBytes", "memorySwapBytes", "pidsLimit"])
        assert.equal(
            observed[field],
            expected[field],
            `Native ${field} changed`,
        );
    assert.equal(
        observed.privileged,
        false,
        "Privileged native control is forbidden",
    );
    // Empty strings are Docker's default private namespace selection. Reject
    // host/container sharing and unknown namespace modes rather than treating
    // every non-host string as evidence of isolation.
    for (const field of ["pidMode", "ipcMode", "usernsMode"])
        assert.ok(
            ["", "private"].includes(observed[field]),
            `Native ${field} must remain private or default`,
        );
    assert.equal(
        observed.cgroupnsMode,
        expected.cgroupnsMode,
        "Native cgroup namespace must be explicitly private",
    );
    assert.ok(
        Array.isArray(observed.ulimits),
        "Native resource limits are missing",
    );
    assert.deepEqual(
        observed.ulimits.filter((value) => value?.Name === "core"),
        [
            {
                Name: "core",
                Hard: expected.coreHardBytes,
                Soft: expected.coreSoftBytes,
            },
        ],
        "Native core soft/hard limits changed",
    );
    return receipt;
}

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
        "nativeProfile",
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
        nativeProfile,
    } = options;
    assertImageReference(image);
    assertArguments(command, "Container command");
    const native =
        nativeProfile === undefined
            ? undefined
            : validateNativeControlProfile(
                  nativeProfile,
                  await readNativeControlHostIdentity(),
              );
    if (native) {
        const cleanPrefix = [
            "/usr/bin/env",
            "-i",
            ...Object.entries(NATIVE_CONTROL_ENVIRONMENT).map(
                ([key, value]) => `${key}=${value}`,
            ),
        ];
        if (
            !cleanPrefix.every((part, index) => command[index] === part) ||
            typeof command[cleanPrefix.length] !== "string" ||
            !command[cleanPrefix.length].startsWith("/")
        )
            throw new Error(
                "Native control requires the fixed clean environment before an absolute executable",
            );
    }
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
        ...(native ? { nativeProfile: native } : {}),
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
        async inspectNativeProfile() {
            if (!native)
                throw new Error(
                    "Native profile inspection requires an admitted native control",
                );
            await requireOwned();
            const result = assertSuccessful(
                await invoke([
                    "inspect",
                    "--format",
                    NATIVE_CONTROL_INSPECT_TEMPLATE,
                    name,
                ]),
                "native profile inspection",
            );
            if (Buffer.byteLength(result.stdout, "utf8") > 64 * 1024)
                throw new Error(
                    "Native profile inspection exceeded its byte limit",
                );
            const observed = JSON.parse(result.stdout);
            return assertNativeControlInspection(
                { requested: native, observed },
                native,
                image,
            );
        },
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
        if (native)
            args.push(
                "--platform",
                native.platform,
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--cgroupns",
                native.cgroupnsMode,
                "--cpuset-cpus",
                String(native.cpu),
                "--cpus",
                String(native.cpuQuota),
                "--memory",
                String(native.memoryBytes),
                "--memory-swap",
                String(native.memorySwapBytes),
                "--pids-limit",
                String(native.pidsLimit),
                "--ulimit",
                `core=${native.coreSoftBytes}:${native.coreHardBytes}`,
            );
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
