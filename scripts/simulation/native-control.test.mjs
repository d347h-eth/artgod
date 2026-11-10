import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, symlink, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    admitNativeControlInputs,
    runNativeControl,
    nativeControlAdmissionScript,
    assertNativeControlAdmission,
    NATIVE_CONTROL_ARTIFACT as ARTIFACT,
    NATIVE_CONTROL_STATUS as STATUS,
} from "./native-control.mjs";
import { createArtifactRunDirectory, pinFile } from "./artifacts.mjs";
import { resolveRuntimeLayout } from "./guest/runtime-manifest.mjs";
import {
    DOCKER_NATIVE_CONTROL_POLICY as POLICY,
    NATIVE_CONTROL_ENVIRONMENT,
    validateNativeControlProfile,
} from "./docker.mjs";
import {
    QUALIFICATION_PROTOCOL_PREFIX,
    QUALIFICATION_PROTOCOL_VERSION,
    QUALIFICATION_EVENT,
    QUALIFICATION_STATUS,
    CHECK_COVERAGE_STATUS,
    SIMULATION_EVIDENCE_PREFIX,
    SIMULATION_EVIDENCE_EVENT as EVENT,
} from "./qualification-protocol.mjs";
import baseline from "./scenarios/baseline.json" with { type: "json" };
import { NATIVE_DIAGNOSTIC_PROFILE } from "./guest/native-failure-evidence.mjs";

// Byte/admission/transport guards only. Every container callback is inert; fixture
// Node/native-addon/artifact bytes are never executed. No Docker or VM is used.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const IMAGE = `node@sha256:${"1".repeat(64)}`;
const HOST = { uid: 1000, gid: 1000, allowedCpuList: "2-3" };
const PROFILE = validateNativeControlProfile(
    { kind: POLICY.kind, cpu: 2 },
    HOST,
);
const json = (value) => `${JSON.stringify(value)}\n`;
function admission() {
    return {
        version: 1,
        uid: HOST.uid,
        gid: HOST.gid,
        cpu: 2,
        coreSoftBytes: 1,
        coreHardBytes: 1,
        capabilitiesZero: true,
        noNewPrivileges: true,
        portStart: 0,
        memoryBytes: POLICY.memoryBytes,
        swapBytes: 0,
        pidsLimit: POLICY.pidsLimit,
        cpuQuota: 1,
        loopbackOnly: true,
    };
}
async function fixture(mode) {
    const directory = await createArtifactRunDirectory(
        path.join(ROOT, "tmp/simulation-native-control-tests"),
        "fixture-",
    );
    const rootfs = path.join(directory, "rootfs"),
        workbench = path.join(rootfs, "workbench");
    const files = new Map([
        ["guest/guest.mjs", "inert bundled guest; never executed"],
        ["database/migrations/001.sql", "inert migration"],
        ["certs/ca.pem", "synthetic fixture CA"],
        ["certs/server.pem", "synthetic fixture cert"],
        ["certs/server.key", "synthetic fixture key"],
        [
            "runtime/indexer/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
            "inert native binding",
        ],
    ]);
    const layout = resolveRuntimeLayout(workbench);
    for (const spec of [
        ...layout.processes,
        ...layout.bootstrapProcesses,
        ...layout.startupMaintenance,
    ])
        files.set(
            path.relative(workbench, spec.filename),
            `inert production ${spec.id}`,
        );
    files.set(
        path.relative(workbench, layout.natsBinary),
        "inert real-binary slot",
    );
    const payload = [];
    for (const [name, text] of files) {
        const filename = path.join(workbench, name);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, text);
        payload.push(await pinFile(filename, workbench));
    }
    await symlink(
        "../runtime/indexer/node_modules",
        path.join(workbench, "guest/node_modules"),
    );
    payload.push({
        path: "guest/node_modules",
        symlink: "../runtime/indexer/node_modules",
    });
    payload.sort((a, b) => a.path.localeCompare(b.path));
    for (const [name, text] of Object.entries({
        "usr/local/bin/node": "inert pinned Node image bytes",
        "bin/busybox": "inert static BusyBox bytes",
        "etc/hosts":
            "127.0.0.1 localhost api.opensea.io stream-api.opensea.io\n::1 localhost\n",
    })) {
        const filename = path.join(rootfs, name);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, text);
    }
    const source = {
        sourceCommit: "a".repeat(40),
        files: [
            {
                path: "indexer/src/runtime/domain-worker.ts",
                sha256: "2".repeat(64),
                sizeBytes: 9,
            },
        ],
    };
    const pins = {};
    for (const name of ["qemu", "qemuImg", "kernel", "firmware", "scenario"]) {
        const filename = path.join(directory, `inert-${name}`);
        await writeFile(filename, `inert ${name}`);
        pins[name] = await pinFile(filename, directory);
    }
    const guest = path.join(directory, "guest.qcow2");
    await writeFile(guest, "inert pristine image");
    const manifest = {
        version: 1,
        sourceSha: source.sourceCommit,
        qualificationId: baseline.qualificationId,
        expectedChecks: baseline.expectedChecks,
        machine: "pc-i440fx-8.2",
        epoch: "2026-11-08T00:00:00Z",
        timeoutSeconds: 30,
        qemu: { ...pins.qemu, version: "inert QEMU fixture" },
        qemuImg: { ...pins.qemuImg, version: "inert QEMU-img fixture" },
        kernel: pins.kernel,
        firmware: pins.firmware,
        scenario: pins.scenario,
        guest: await pinFile(guest, directory),
    };
    const manifestPath = path.join(directory, "manifest.json"),
        scenarioFile = path.join(directory, "scenario.json");
    await writeFile(manifestPath, json(manifest));
    await writeFile(scenarioFile, json(baseline));
    await writeFile(
        path.join(directory, "provenance.json"),
        json({
            version: 1,
            sourceCommit: source.sourceCommit,
            sourceInputs: source.files,
            payload,
            images: { runtime: IMAGE },
        }),
    );
    let calls = 0,
        starts = 0,
        optionsSeen;
    const container = async (options, operation) => {
        calls++;
        optionsSeen = options;
        const artifactsDirectory = await createArtifactRunDirectory(
            path.join(directory, "fake-container"),
            "owner-",
        );
        const output = options.mounts.find(
            (value) => value.target === "/workbench/output",
        ).source;
        const scenario = JSON.parse(
            await readFile(
                options.mounts.find(
                    (value) => value.target === "/scenario/scenario.json",
                ).source,
                "utf8",
            ),
        );
        const observed = {
            image: `sha256:${"3".repeat(64)}`,
            configuredImage: IMAGE,
            user: "1000:1000",
            readOnlyRootfs: true,
            networkMode: mode === "wrong-profile" ? "host" : "none",
            capAdd: [],
            capDrop: ["ALL"],
            securityOpt: ["no-new-privileges"],
            cpusetCpus: "2",
            nanoCpus: 1e9,
            memoryBytes: POLICY.memoryBytes,
            memorySwapBytes: POLICY.memorySwapBytes,
            pidsLimit: POLICY.pidsLimit,
            ulimits: [{ Name: "core", Hard: 1, Soft: 1 }],
            privileged: false,
            pidMode: "",
            ipcMode: "private",
            usernsMode: "",
            cgroupnsMode: "private",
        };
        try {
            const value = await operation({
                inspectNativeProfile: async () => ({
                    requested: PROFILE,
                    observed,
                }),
                async copyFrom(source, target) {
                    assert.equal(source, "/usr/local/bin/node");
                    await writeFile(
                        target,
                        mode === "wrong-node"
                            ? "different Node"
                            : await readFile(
                                  path.join(rootfs, "usr/local/bin/node"),
                              ),
                    );
                },
                async start() {
                    starts++;
                    if (mode !== "admission-failure")
                        await writeFile(
                            path.join(output, ARTIFACT.Admission),
                            json(admission()),
                        );
                    if (mode === "admission-failure")
                        throw Object.assign(
                            new Error("admission unavailable"),
                            {
                                result: {
                                    code: 126,
                                    stdout: "",
                                    stderr: "caps unavailable",
                                },
                            },
                        );
                    const checks = Object.fromEntries(
                        scenario.expectedChecks.map((check) => [check, true]),
                    );
                    const status =
                        mode === "property-failure"
                            ? QUALIFICATION_STATUS.Failed
                            : QUALIFICATION_STATUS.Passed;
                    if (status === QUALIFICATION_STATUS.Failed)
                        checks[scenario.expectedChecks[0]] = false;
                    const probe = { pid: 1, storage: { requested: false } };
                    const evidence = {
                        checkpoints: [{ name: "inert-fixture-only" }],
                        world: { epochSeconds: 123 },
                    };
                    const failureEvidence = {
                        error: "inert property failure",
                        checks,
                        coverage: Object.entries(checks).map(([check, ok]) => ({
                            check,
                            status: ok
                                ? CHECK_COVERAGE_STATUS.Passed
                                : CHECK_COVERAGE_STATUS.Failed,
                        })),
                    };
                    const terminal =
                        status === QUALIFICATION_STATUS.Passed
                            ? { [EVENT.Result]: { checks, evidence } }
                            : { [EVENT.Failure]: failureEvidence };
                    const written =
                        status === QUALIFICATION_STATUS.Passed
                            ? {
                                  version: 1,
                                  qualificationId: scenario.qualificationId,
                                  checks,
                                  probe,
                                  evidence:
                                      mode === "disk-divergence"
                                          ? { changed: true }
                                          : evidence,
                              }
                            : failureEvidence;
                    if (mode === "evidence-mismatch")
                        written.checks = {
                            ...checks,
                            [scenario.expectedChecks[0]]: false,
                        };
                    await writeFile(
                        path.join(
                            output,
                            status === QUALIFICATION_STATUS.Passed
                                ? "result.json"
                                : "failure.json",
                        ),
                        json(written),
                    );
                    const evidenceFrame = (value) =>
                        `${SIMULATION_EVIDENCE_PREFIX}${json(value)}`;
                    let frames = evidenceFrame({ [EVENT.Probe]: probe });
                    if (mode === "bad-generation")
                        frames += evidenceFrame({
                            [EVENT.ProcessReady]: {
                                id: "domain",
                                pid: 40,
                                generation: 2,
                            },
                        });
                    if (mode !== "missing-terminal")
                        frames += evidenceFrame(terminal);
                    if (mode === "duplicate-terminal")
                        frames += evidenceFrame(terminal);
                    if (mode === "contrary-terminal")
                        frames += evidenceFrame({
                            [EVENT.Failure]: failureEvidence,
                        });
                    const frame = (value) =>
                        `${QUALIFICATION_PROTOCOL_PREFIX}${json({ version: QUALIFICATION_PROTOCOL_VERSION, qualificationId: scenario.qualificationId, ...value })}`;
                    if (mode === "mutate-input")
                        await writeFile(
                            path.join(workbench, "guest/guest.mjs"),
                            "mutated original fixture",
                        );
                    return {
                        code: 0,
                        stdout:
                            frame({ event: QUALIFICATION_EVENT.Ready }) +
                            frames +
                            frame({
                                event: QUALIFICATION_EVENT.Complete,
                                status,
                                checks,
                            }),
                        stderr: "",
                    };
                },
            });
            await writeFile(
                path.join(artifactsDirectory, "container.json"),
                json({
                    cleanup: mode === "cleanup-failure" ? "failed" : "removed",
                }),
            );
            return { value, artifactsDirectory };
        } catch (error) {
            await writeFile(
                path.join(artifactsDirectory, "container.json"),
                json({ cleanup: "removed" }),
            );
            error.artifactsDirectory = artifactsDirectory;
            throw error;
        }
    };
    return {
        directory,
        workbench,
        rootfs,
        manifestPath,
        scenarioFile,
        source,
        options: {
            baseManifestPath: manifestPath,
            scenarioFile,
            cpu: 2,
            outputRoot: path.join(directory, "controls"),
        },
        dependencies: {
            container,
            captureSource: async () => source,
            hostIdentity: async () => HOST,
        },
        get calls() {
            return calls;
        },
        get starts() {
            return starts;
        },
        get optionsSeen() {
            return optionsSeen;
        },
    };
}

test("admission shell refuses host invocation before any Node or BusyBox child can execute", async () => {
    const f = await fixture();
    const filename = path.join(f.directory, "admission.sh");
    const script = nativeControlAdmissionScript(PROFILE);
    await writeFile(filename, script, { mode: 0o600 });
    const result = spawnSync("sh", [filename], {
        encoding: "utf8",
        timeout: 2000,
    });
    assert.equal(result.status, 126, result.stderr);
    assert.match(result.stderr, /private container PID1/);
    assert.equal(result.stdout, "");
    assert.ok(!script.includes("sysctl "));
    assert.ok(!/>\s*['"]?\/(?:proc|sys)\//.test(script));
    assert.ok(
        script.indexOf("core soft/hard1") <
            script.indexOf("exec '/usr/local/bin/node'"),
    );
});

test("effective admission rejects root, caps, core, network, memory and affinity mismatches", () => {
    assert.deepEqual(
        assertNativeControlAdmission(admission(), PROFILE),
        admission(),
    );
    for (const change of [
        { uid: 0 },
        { cpu: 3 },
        { coreHardBytes: 0 },
        { coreSoftBytes: 0 },
        { capabilitiesZero: false },
        { portStart: 1024 },
        { noNewPrivileges: false },
        { memoryBytes: 1 },
        { swapBytes: 1 },
        { pidsLimit: 1 },
        { loopbackOnly: false },
        { cpuQuota: 2 },
    ])
        assert.throws(() =>
            assertNativeControlAdmission(
                { ...admission(), ...change },
                PROFILE,
            ),
        );
});

test("native control copies exact immutable artifacts independently and uses the normal coordinator through its owned profile", async () => {
    const f = await fixture();
    const original = await pinFile(path.join(f.workbench, "guest/guest.mjs"));
    const report = await runNativeControl(f.options, f.dependencies);
    assert.equal(report.executionStatus, STATUS.Passed);
    assert.equal(report.propertyStatus, QUALIFICATION_STATUS.Passed);
    assert.equal(report.integrityStatus, STATUS.Passed);
    assert.equal(report.cleanup, "removed");
    assert.equal(f.starts, 1);
    assert.equal(f.calls, 1);
    assert.equal("engineReplayStatus" in report, false);
    assert.equal("guestDiskParityStatus" in report, false);
    assert.deepEqual(await pinFile(original.path), original);
    const staged = path.join(
        report.directory,
        "stage/workbench/guest/guest.mjs",
    );
    assert.notEqual((await stat(original.path)).ino, (await stat(staged)).ino);
    assert.equal((await pinFile(staged)).sha256, original.sha256);
    assert.deepEqual(f.optionsSeen.nativeProfile, {
        kind: POLICY.kind,
        cpu: 2,
    });
    assert.deepEqual(f.optionsSeen.command.slice(0, 2), ["/usr/bin/env", "-i"]);
    assert.deepEqual(
        f.optionsSeen.command.slice(
            2,
            2 + Object.keys(NATIVE_CONTROL_ENVIRONMENT).length,
        ),
        Object.entries(NATIVE_CONTROL_ENVIRONMENT).map(
            ([key, value]) => `${key}=${value}`,
        ),
    );
    assert.equal(
        f.optionsSeen.mounts.filter((value) => value.readOnly === false).length,
        2,
    );
    assert.ok(
        f.optionsSeen.mounts.some(
            (value) =>
                value.target === "/etc/hosts" && value.readOnly !== false,
        ),
    );
});

test("a completed native property failure stays failed even with clean container execution and immutable inputs", async () => {
    const f = await fixture("property-failure");
    const report = await runNativeControl(f.options, f.dependencies);
    assert.equal(report.executionStatus, STATUS.Passed);
    assert.equal(report.propertyStatus, QUALIFICATION_STATUS.Failed);
    assert.equal(report.integrityStatus, STATUS.Passed);
    assert.equal(report.admission.coreHardBytes, 1);
});

test("guest-only diagnostics and altered production source are rejected before container creation", async () => {
    const f = await fixture();
    await writeFile(
        f.scenarioFile,
        json({
            ...baseline,
            nativeDiagnostics: {
                profile: NATIVE_DIAGNOSTIC_PROFILE.RegisteredContext,
            },
        }),
    );
    await assert.rejects(
        runNativeControl(f.options, f.dependencies),
        /guest-only/,
    );
    assert.equal(f.calls, 0);
    await writeFile(f.scenarioFile, json(baseline));
    const changed = {
        ...f.source,
        files: [{ ...f.source.files[0], sha256: "4".repeat(64) }],
    };
    await assert.rejects(
        runNativeControl(f.options, {
            ...f.dependencies,
            captureSource: async () => changed,
        }),
        /Reused runtime source changed/,
    );
    assert.equal(f.calls, 0);
});

test("payload mutations and symlink escapes fail full-byte admission before any execution", async () => {
    const f = await fixture();
    await writeFile(
        path.join(f.workbench, "guest/guest.mjs"),
        "altered source bundle",
    );
    await assert.rejects(admitNativeControlInputs(f.options, f.dependencies));
    const g = await fixture();
    await symlink(
        path.join(g.directory, "manifest.json"),
        path.join(g.workbench, "external"),
    );
    await assert.rejects(
        admitNativeControlInputs(g.options, g.dependencies),
        /escapes/,
    );
    assert.equal(f.calls + g.calls, 0);
});

test("observed Docker or Node identity mismatch prevents the coordinator from starting", async () => {
    for (const mode of ["wrong-profile", "wrong-node"]) {
        const f = await fixture(mode);
        const report = await runNativeControl(f.options, f.dependencies);
        assert.equal(report.executionStatus, STATUS.Incomplete);
        assert.equal(f.starts, 0);
        assert.equal(report.cleanup, "removed");
    }
});

test("failed pre-Node admission remains an explicit incomplete control with cleanup and bounded attached output", async () => {
    const f = await fixture("admission-failure");
    const report = await runNativeControl(f.options, f.dependencies);
    assert.equal(report.executionStatus, STATUS.Incomplete);
    assert.equal(report.propertyStatus, "unqualified");
    assert.equal(report.cleanup, "removed");
    assert.match(report.error, /admission unavailable/);
    assert.ok(report.admissionError);
    assert.equal(
        await readFile(path.join(report.directory, ARTIFACT.Stderr), "utf8"),
        "caps unavailable",
    );
});

test("post-execution original mutation cannot be accepted through a passing synthetic protocol", async () => {
    const f = await fixture("mutate-input");
    const report = await runNativeControl(f.options, f.dependencies);
    assert.equal(report.executionStatus, STATUS.Incomplete);
    assert.equal(report.integrityStatus, STATUS.Failed);
    assert.equal(report.propertyStatus, "unqualified");
    assert.ok(report.integrityError);
});

test("the frozen target closure is reused byte-for-byte while newer observer/controller source is recorded separately", async () => {
    const f = await fixture();
    const controller = {
        sourceCommit: "b".repeat(40),
        files: [
            ...f.source.files,
            {
                path: "scripts/simulation/native-control.mjs",
                sha256: "5".repeat(64),
                sizeBytes: 42,
            },
        ],
    };
    const report = await runNativeControl(f.options, {
        ...f.dependencies,
        captureSource: async () => controller,
    });
    assert.equal(report.executionStatus, STATUS.Passed);
    assert.equal(report.sourceSha, f.source.sourceCommit);
    assert.equal(report.controllerSource.sourceCommit, controller.sourceCommit);
    assert.deepEqual(report.controllerChanges, [
        "scripts/simulation/native-control.mjs",
    ]);
});

test("green completion cannot qualify changed evidence or stores without acknowledged cleanup", async () => {
    for (const mode of ["evidence-mismatch", "cleanup-failure"]) {
        const f = await fixture(mode);
        const report = await runNativeControl(f.options, f.dependencies);
        assert.equal(report.executionStatus, STATUS.Incomplete);
        assert.equal(report.propertyStatus, "unqualified");
        if (mode === "cleanup-failure") {
            assert.ok(report.cleanupError);
            assert.equal(report.admission, undefined);
            assert.equal(report.guestEvidence, undefined);
        } else {
            assert.match(report.error, /Written native evidence/);
            assert.equal(
                report.guestReportedPropertyStatus,
                QUALIFICATION_STATUS.Passed,
            );
        }
    }
});

test("JSON mutation after parsing cannot replace the admitted scenario identity before its final bookend", async () => {
    const f = await fixture();
    let captures = 0;
    const captureSource = async () => {
        if (++captures === 1)
            await writeFile(
                f.scenarioFile,
                json({
                    ...baseline,
                    qualificationId: baseline.qualificationId.replace(
                        /1$/,
                        "2",
                    ),
                }),
            );
        return f.source;
    };
    await assert.rejects(
        runNativeControl(f.options, { ...f.dependencies, captureSource }),
    );
    assert.equal(f.calls, 0);
});

test("a wrong staged scenario copy is rejected before any container is created", async () => {
    const f = await fixture();
    const original = await pinFile(f.scenarioFile);
    const report = await runNativeControl(f.options, {
        ...f.dependencies,
        writeScenario: async (filename) =>
            writeFile(filename, "wrong scenario bytes"),
    });
    assert.equal(report.executionStatus, STATUS.Incomplete);
    assert.equal(f.calls, 0);
    assert.match(report.error, /Frozen scenario copy/);
    assert.deepEqual(await pinFile(f.scenarioFile), original);
});

test("missing, duplicate, contradictory or disk-divergent native terminal evidence cannot earn a completion", async () => {
    for (const mode of [
        "missing-terminal",
        "duplicate-terminal",
        "contrary-terminal",
        "bad-generation",
        "disk-divergence",
    ]) {
        const f = await fixture(mode);
        const report = await runNativeControl(f.options, f.dependencies);
        assert.equal(report.executionStatus, STATUS.Incomplete, mode);
        assert.equal(report.propertyStatus, "unqualified", mode);
        assert.equal(report.integrityStatus, STATUS.Passed, mode);
        assert.ok(report.error, mode);
    }
});
