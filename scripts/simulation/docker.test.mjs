import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    DOCKER_OWNER_LABEL,
    DOCKER_NATIVE_CONTROL_POLICY,
    NATIVE_CONTROL_ENVIRONMENT,
    readNativeControlHostIdentity,
    validateNativeControlProfile,
    assertNativeControlInspection,
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

async function nativeOptions(f) {
    const host = await readNativeControlHostIdentity();
    const cpu = Number(host.allowedCpuList.split(",")[0].split("-")[0]);
    return {
        ...f.options,
        nativeProfile: { kind: DOCKER_NATIVE_CONTROL_POLICY.kind, cpu },
        command: [
            "/usr/bin/env",
            "-i",
            ...Object.entries(NATIVE_CONTROL_ENVIRONMENT).map(
                ([key, value]) => `${key}=${value}`,
            ),
            "/bin/busybox",
            "sh",
            "/workbench/native-control-admission.sh",
        ],
    };
}

test("default container creation retains the exact existing build/tool profile", async () => {
    const f = await fixture();
    const result = await runOwnedContainer(f.options);
    const created = f.calls.find((args) => args[0] === "create");
    const descriptor = JSON.parse(
        await readFile(
            path.join(result.dockerArtifacts, "container.json"),
            "utf8",
        ),
    );
    assert.deepEqual(created, [
        "create",
        "--pull=never",
        "--name",
        f.name,
        "--label",
        `${DOCKER_OWNER_LABEL}=${descriptor.owner}`,
        "--cidfile",
        path.join(result.dockerArtifacts, "container.cid"),
        "--network",
        "none",
        "--read-only",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        IMAGE,
        ...f.options.command,
    ]);
    assert.equal("nativeProfile" in descriptor, false);
});

test("native control pins one allowed CPU and the fixed isolation/resource policy without inherited environment", async () => {
    const f = await fixture();
    const options = await nativeOptions(f);
    const result = await runOwnedContainer(options);
    const created = f.calls.find((args) => args[0] === "create");
    const expected = {
        "--platform": "linux/amd64",
        "--network": "none",
        "--user": `${process.getuid()}:${process.getgid()}`,
        "--cap-drop": "ALL",
        "--security-opt": "no-new-privileges",
        "--cgroupns": "private",
        "--cpuset-cpus": String(options.nativeProfile.cpu),
        "--cpus": "1",
        "--memory": "2147483648",
        "--memory-swap": "2147483648",
        "--pids-limit": "512",
        "--ulimit": "core=1:1",
    };
    for (const [flag, value] of Object.entries(expected)) {
        assert.equal(created.filter((arg) => arg === flag).length, 1);
        assert.equal(created[created.indexOf(flag) + 1], value);
    }
    assert.ok(created.includes("--read-only"));
    for (const forbidden of [
        "--privileged",
        "--sysctl",
        "--pid",
        "--ipc",
        "--userns",
        "--env",
        "--env-file",
        "-e",
    ])
        assert.ok(!created.includes(forbidden));
    assert.deepEqual(
        created.slice(created.indexOf(IMAGE) + 1),
        options.command,
    );
    const descriptor = JSON.parse(
        await readFile(
            path.join(result.dockerArtifacts, "container.json"),
            "utf8",
        ),
    );
    assert.equal(descriptor.nativeProfile.cpu, options.nativeProfile.cpu);
    assert.equal(
        descriptor.nativeProfile.memoryBytes,
        DOCKER_NATIVE_CONTROL_POLICY.memoryBytes,
    );
    assert.equal(f.daemon.size, 0);
});

test("native control rejects root identities, malformed or disallowed affinity and configurable escape flags", async () => {
    const host = { uid: 1000, gid: 1000, allowedCpuList: "2-4,6,8-9" };
    const valid = { kind: DOCKER_NATIVE_CONTROL_POLICY.kind, cpu: 6 };
    for (const cpu of [2, 4, 6, 8, 9])
        assert.equal(
            validateNativeControlProfile({ ...valid, cpu }, host).cpu,
            cpu,
        );
    for (const value of [
        null,
        {},
        [],
        { ...valid, kind: "custom" },
        { ...valid, cpu: "6" },
        { ...valid, cpu: "2,3" },
        { ...valid, cpu: -1 },
        { ...valid, cpu: 2.5 },
        { ...valid, cpu: 5 },
        { ...valid, privileged: true },
        { ...valid, sysctls: {} },
    ])
        assert.throws(
            () => validateNativeControlProfile(value, host),
            /Native control|Selected native-control CPU/,
        );
    for (const identity of [
        { ...host, uid: 0 },
        { ...host, gid: 0 },
        { ...host, allowedCpuList: "2-" },
        { ...host, allowedCpuList: "4-2" },
    ])
        assert.throws(
            () => validateNativeControlProfile(valid, identity),
            /Native control|allowed host CPU list/,
        );
    const f = await fixture();
    await assert.rejects(
        runOwnedContainer({
            ...f.options,
            nativeProfile: { ...valid, memoryBytes: 1 },
        }),
        /fixed kind/,
    );
    await assert.rejects(
        runOwnedContainer({ ...f.options, privileged: true }),
        /Unknown owned-container option/,
    );
    assert.equal(f.calls.length, 0);
});

test("native control requires its closed env-i prefix before any Docker action", async () => {
    const f = await fixture();
    const options = await nativeOptions(f);
    for (const command of [
        f.options.command,
        ["/usr/bin/env", ...options.command.slice(2)],
        [
            ...options.command.slice(0, -3),
            "NODE_OPTIONS=--jitless",
            ...options.command.slice(-3),
        ],
    ])
        await assert.rejects(
            runOwnedContainer({ ...options, command }),
            /fixed clean environment/,
        );
    assert.equal(f.calls.length, 0);
});

test("native control selected inspection is owned, bounded and excludes the container environment", async () => {
    const f = await fixture();
    const options = await nativeOptions(f);
    const observed = {
        image: "sha256:" + "b".repeat(64),
        configuredImage: IMAGE,
        user: `${process.getuid()}:${process.getgid()}`,
        readOnlyRootfs: true,
        networkMode: "none",
        capAdd: null,
        capDrop: ["ALL"],
        securityOpt: ["no-new-privileges"],
        cpusetCpus: String(options.nativeProfile.cpu),
        nanoCpus: 1e9,
        memoryBytes: 2147483648,
        memorySwapBytes: 2147483648,
        pidsLimit: 512,
        ulimits: [{ Name: "core", Soft: 1, Hard: 1 }],
        privileged: false,
        pidMode: "",
        ipcMode: "private",
        usernsMode: "",
        cgroupnsMode: "private",
    };
    let inspectionArgs;
    const result = await withOwnedContainer(
        {
            ...options,
            execute: async (binary, args, execution) => {
                if (args[0] === "inspect" && args[2].includes(".HostConfig")) {
                    inspectionArgs = args;
                    return okay(JSON.stringify(observed));
                }
                return f.execute(binary, args, execution);
            },
        },
        (container) => container.inspectNativeProfile(),
    );
    assert.deepEqual(result.value.observed, observed);
    assert.equal(result.value.requested.cpu, options.nativeProfile.cpu);
    assert.equal(result.value.requested.uid, process.getuid());
    assert.ok(!inspectionArgs[2].includes(".Config.Env"));
    assert.ok(!inspectionArgs[2].includes("{{json .}}"));
    assert.ok(f.calls.filter((args) => args[0] === "inspect").length >= 2);
    assert.equal(f.daemon.size, 0);
    const plain = await fixture();
    await assert.rejects(
        withOwnedContainer(plain.options, (container) =>
            container.inspectNativeProfile(),
        ),
        /requires an admitted native control/,
    );
});

function nativeInspection(expected) {
    return {
        requested: expected,
        observed: {
            image: "sha256:" + "b".repeat(64),
            configuredImage: IMAGE,
            user: `${expected.uid}:${expected.gid}`,
            readOnlyRootfs: true,
            networkMode: "none",
            capAdd: null,
            capDrop: ["ALL"],
            securityOpt: ["no-new-privileges"],
            cpusetCpus: String(expected.cpu),
            nanoCpus: 1e9,
            memoryBytes: 2147483648,
            memorySwapBytes: 2147483648,
            pidsLimit: 512,
            ulimits: [{ Name: "core", Soft: 1, Hard: 1 }],
            privileged: false,
            pidMode: "",
            ipcMode: "private",
            usernsMode: "",
            cgroupnsMode: "private",
        },
    };
}

test("native control inspection owner accepts deliberate empty-capability and default-private namespace forms", () => {
    const expected = validateNativeControlProfile(
        { kind: DOCKER_NATIVE_CONTROL_POLICY.kind, cpu: 2 },
        { uid: 1000, gid: 1000, allowedCpuList: "2-4" },
    );
    for (const capAdd of [null, []]) {
        for (const namespace of ["", "private"]) {
            for (const security of [
                "no-new-privileges",
                "no-new-privileges:true",
                "no-new-privileges=true",
            ]) {
                const receipt = nativeInspection(expected);
                Object.assign(receipt.observed, {
                    capAdd,
                    capDrop: ["all"],
                    securityOpt: [security],
                    pidMode: namespace,
                    ipcMode: namespace,
                    usernsMode: namespace,
                });
                receipt.observed.ulimits.push({
                    Name: "nofile",
                    Soft: 1024,
                    Hard: 2048,
                });
                assert.equal(
                    assertNativeControlInspection(receipt, expected, IMAGE),
                    receipt,
                );
            }
        }
    }
});

test("native control inspection owner rejects observed isolation and resource drift including host cgroup namespaces", () => {
    const expected = validateNativeControlProfile(
        { kind: DOCKER_NATIVE_CONTROL_POLICY.kind, cpu: 2 },
        { uid: 1000, gid: 1000, allowedCpuList: "2-4" },
    );
    const mutations = [
        { configuredImage: "sha256:" + "c".repeat(64) },
        { image: "unknown" },
        { user: "0:0" },
        { readOnlyRootfs: false },
        { networkMode: "host" },
        { capAdd: ["NET_ADMIN"] },
        { capDrop: null },
        { capDrop: [] },
        { capDrop: ["ALL", "SYS_PTRACE"] },
        { securityOpt: ["no-new-privileges=false"] },
        { securityOpt: ["no-new-privileges", "seccomp=unconfined"] },
        { cpusetCpus: "2-3" },
        { nanoCpus: 0 },
        { memoryBytes: 0 },
        { memorySwapBytes: -1 },
        { pidsLimit: 0 },
        { privileged: true },
        { pidMode: "host" },
        { ipcMode: "host" },
        { usernsMode: "host" },
        { pidMode: "container:other" },
        { ipcMode: "shareable" },
        { usernsMode: "unknown" },
        { cgroupnsMode: "host" },
        { cgroupnsMode: "" },
        { ulimits: null },
        { ulimits: [] },
        { ulimits: [{ Name: "core", Soft: 0, Hard: 1 }] },
        {
            ulimits: [
                { Name: "core", Soft: 1, Hard: 1 },
                { Name: "core", Soft: 1, Hard: 1 },
            ],
        },
    ];
    for (const mutation of mutations) {
        const receipt = nativeInspection(expected);
        Object.assign(receipt.observed, mutation);
        assert.throws(
            () => assertNativeControlInspection(receipt, expected, IMAGE),
            undefined,
            JSON.stringify(mutation),
        );
    }
    const forged = { ...expected, memoryBytes: 1 };
    const receipt = nativeInspection(forged);
    receipt.observed.memoryBytes = 1;
    assert.throws(
        () => assertNativeControlInspection(receipt, forged, IMAGE),
        /fixed owner/,
    );
});

test("native control selected inspection rejects real-shaped policy drift before use and still cleans its owned container", async () => {
    for (const mutation of [
        { memoryBytes: 1 },
        { cgroupnsMode: "host" },
        { capAdd: ["SYS_ADMIN"] },
    ]) {
        const f = await fixture();
        const options = await nativeOptions(f);
        const expected = validateNativeControlProfile(
            options.nativeProfile,
            await readNativeControlHostIdentity(),
        );
        const { observed } = nativeInspection(expected);
        Object.assign(observed, mutation);
        await assert.rejects(
            withOwnedContainer(
                {
                    ...options,
                    execute: async (binary, args, execution) => {
                        if (
                            args[0] === "inspect" &&
                            args[2].includes(".HostConfig")
                        )
                            return okay(JSON.stringify(observed));
                        return f.execute(binary, args, execution);
                    },
                },
                (container) => container.inspectNativeProfile(),
            ),
            /Native/,
        );
        assert.equal(f.daemon.size, 0);
        assert.ok(!f.calls.some((args) => args[0] === "start"));
        assert.equal(f.calls.filter((args) => args[0] === "rm").length, 1);
    }
});

test("native control inspection and attached timeout failures retain owned cleanup", async () => {
    for (const problem of ["oversized", "fields", "timeout"]) {
        const f = await fixture(problem === "timeout" ? "timeout" : undefined);
        const options = await nativeOptions(f);
        const execute = async (binary, args, execution) => {
            if (args[0] === "inspect" && args[2].includes(".HostConfig"))
                return okay(
                    problem === "oversized"
                        ? "x".repeat(65537)
                        : JSON.stringify({ Env: ["fixture-only-secret"] }),
                );
            return f.execute(binary, args, execution);
        };
        await assert.rejects(
            withOwnedContainer({ ...options, execute }, (container) =>
                problem === "timeout"
                    ? container.start()
                    : container.inspectNativeProfile(),
            ),
            /byte limit|unexpected fields|timeout/,
        );
        assert.equal(f.daemon.size, 0);
        assert.equal(f.calls.filter((args) => args[0] === "rm").length, 1);
    }
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
