#!/usr/bin/env node
import assert from "node:assert/strict";
import {
    cp,
    mkdir,
    lstat,
    readdir,
    readFile,
    readlink,
    realpath,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { arch, release, cpus } from "node:os";
import { assertCoordinatorOnlySourceChanges } from "./build-guest.mjs";
import { snapshotSource } from "./source-snapshot.mjs";
import {
    createArtifactRunDirectory,
    assertWorktreeTemporaryPath,
    pinFile,
} from "./artifacts.mjs";
import {
    readArtifactJson,
    captureArtifactJson,
    readGuestEvidence,
    assertCompleteGuestEvidence,
} from "./run-evidence.mjs";
import { validateManifest, assertGuestProtocol } from "./qemu-replay.mjs";
import { validateScenario, SCENARIO_KIND } from "./guest/scenario-contract.mjs";
import { resolveRuntimeLayout } from "./guest/runtime-manifest.mjs";
import {
    QUALIFICATION_STATUS,
    SIMULATION_EVIDENCE_EVENT as EVENT,
} from "./qualification-protocol.mjs";
import {
    withOwnedContainer,
    assertImageReference,
    DOCKER_NATIVE_CONTROL_POLICY as POLICY,
    NATIVE_CONTROL_ENVIRONMENT,
    readNativeControlHostIdentity,
    validateNativeControlProfile,
    assertNativeControlInspection,
} from "./docker.mjs";

export const NATIVE_CONTROL_ARTIFACT = Object.freeze({
    Report: "native-control.json",
    Admission: "native-admission.json",
    Shell: "native-control-admission.sh",
    Stdout: "coordinator.stdout.log",
    Stderr: "coordinator.stderr.log",
});
export const NATIVE_CONTROL_STATUS = Object.freeze({
    Passed: QUALIFICATION_STATUS.Passed,
    Failed: QUALIFICATION_STATUS.Failed,
    Incomplete: "incomplete",
});
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKBENCH = NATIVE_CONTROL_ENVIRONMENT.ARTGOD_WORKBENCH_ROOT;
const OUTPUT = `${WORKBENCH}/output`;
const NODE = "/usr/local/bin/node";
const BUSYBOX = "/bin/busybox";
const COORDINATOR = `${WORKBENCH}/guest/guest.mjs`;
const SCENARIO = "/scenario/scenario.json";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SWAP_BYTES = POLICY.memorySwapBytes - POLICY.memoryBytes;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** The shell performs only private-container reads before the unchanged Node argv.
 * Its initial builtin guard makes accidental host invocation a no-exec failure.
 * core1 is Linux's pipe-recursion sentinel; core0 does not suppress pipe helpers.
 */
export function nativeControlAdmissionScript(profile) {
    validateNativeControlProfile(
        { kind: POLICY.kind, cpu: profile.cpu },
        profile,
    );
    return `#!/bin/busybox sh
deny() { printf 'ArtGod native control admission unavailable: %s\\n' "$1" >&2; exit 126; }
[ "$$" -eq 1 ] && [ "$#" -eq 0 ] || deny 'private container PID1 required'
[ -f /.dockerenv ] || deny 'Docker namespace marker missing'
[ "$(${BUSYBOX} id -u)" = '${profile.uid}' ] && [ "$(${BUSYBOX} id -g)" = '${profile.gid}' ] || deny 'fixed nonroot UID/GID required'
[ -w '${WORKBENCH}/state' ] && [ -w '${OUTPUT}' ] || deny 'private stores unavailable'
${BUSYBOX} awk '$1=="Max" && $2=="core" && $3=="file" && $4=="size" {ok=($5==${POLICY.coreSoftBytes} && $6==${POLICY.coreHardBytes} && $7=="bytes")} END {exit !ok}' /proc/$$/limits || deny 'core soft/hard1 required'
${BUSYBOX} awk '/^Cap(Inh|Prm|Eff|Bnd|Amb):/ {n++; if ($2 !~ /^0+$/) bad=1} /^NoNewPrivs:/ {nn=($2==1)} END {exit (n!=5 || bad || !nn)}' /proc/$$/status || deny 'caps0 and no-new-privileges required'
cpu=$(${BUSYBOX} awk '/^Cpus_allowed_list:/ {print $2}' /proc/$$/status)
[ "$cpu" = '${profile.cpu}' ] || deny 'single admitted CPU affinity required'
[ "$(${BUSYBOX} cat /proc/sys/net/ipv4/ip_unprivileged_port_start)" = 0 ] || deny 'private namespace low ports unavailable'
[ "$(${BUSYBOX} ls -1 /sys/class/net)" = lo ] || deny 'loopback-only network required'
[ "$(${BUSYBOX} cat /sys/fs/cgroup/memory.max)" = '${POLICY.memoryBytes}' ] || deny 'effective memory ceiling unavailable'
[ "$(${BUSYBOX} cat /sys/fs/cgroup/memory.swap.max)" = '${SWAP_BYTES}' ] || deny 'effective swap ceiling unavailable'
[ "$(${BUSYBOX} cat /sys/fs/cgroup/pids.max)" = '${POLICY.pidsLimit}' ] || deny 'effective PID ceiling unavailable'
quota=$(${BUSYBOX} cat /sys/fs/cgroup/cpu.max)
printf '%s\\n' "$quota" | ${BUSYBOX} awk 'NF==2 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $1>0 && $1==${POLICY.cpuQuota}*$2 {ok=1} END {exit !ok}' || deny 'effective single CPU quota unavailable'
[ "$(${BUSYBOX} cat /sys/fs/cgroup/cpuset.cpus.effective)" = '${profile.cpu}' ] || deny 'effective cpuset unavailable'
(umask 077; printf '{"version":1,"uid":${profile.uid},"gid":${profile.gid},"cpu":${profile.cpu},"coreSoftBytes":${POLICY.coreSoftBytes},"coreHardBytes":${POLICY.coreHardBytes},"capabilitiesZero":true,"noNewPrivileges":true,"portStart":0,"memoryBytes":${POLICY.memoryBytes},"swapBytes":${SWAP_BYTES},"pidsLimit":${POLICY.pidsLimit},"cpuQuota":${POLICY.cpuQuota},"loopbackOnly":true}\\n' > '${OUTPUT}/${NATIVE_CONTROL_ARTIFACT.Admission}') || deny 'admission receipt unavailable'
exec '${NODE}' '${COORDINATOR}' '${SCENARIO}'
`;
}

export function assertNativeControlAdmission(value, expected) {
    assert.deepEqual(
        value,
        {
            version: 1,
            uid: expected.uid,
            gid: expected.gid,
            cpu: expected.cpu,
            coreSoftBytes: POLICY.coreSoftBytes,
            coreHardBytes: POLICY.coreHardBytes,
            capabilitiesZero: true,
            noNewPrivileges: true,
            portStart: 0,
            memoryBytes: POLICY.memoryBytes,
            swapBytes: SWAP_BYTES,
            pidsLimit: POLICY.pidsLimit,
            cpuQuota: POLICY.cpuQuota,
            loopbackOnly: true,
        },
        "Native effective admission differs from the fixed profile",
    );
    return value;
}

function relativeMember(value) {
    assert.ok(
        typeof value === "string" &&
            value &&
            !path.posix.isAbsolute(value) &&
            path.posix.normalize(value) === value &&
            value !== ".." &&
            !value.startsWith("../") &&
            !/[\x00-\x1f]/.test(value),
        "Payload members must be unique ordinary relative paths",
    );
    return value;
}

async function regularPin(filename) {
    assert.ok(
        (await lstat(filename)).isFile(),
        "Admitted input must be a regular file, not a symlink",
    );
    return pinFile(filename);
}

async function inventory(directory, ignored = new Set()) {
    const entries = [];
    const root = await realpath(directory);
    const visit = async (parent) => {
        for (const entry of await readdir(parent, { withFileTypes: true })) {
            const filename = path.join(parent, entry.name);
            const name = path
                .relative(directory, filename)
                .split(path.sep)
                .join("/");
            if (ignored.has(name)) continue;
            if (entry.isSymbolicLink()) {
                const target = await realpath(filename);
                assert.ok(
                    target.startsWith(`${root}${path.sep}`),
                    "Payload symlink escapes the admitted workbench",
                );
                entries.push({ path: name, symlink: await readlink(filename) });
            } else if (entry.isDirectory()) await visit(filename);
            else {
                assert.ok(
                    entry.isFile(),
                    "Payload cannot contain special nodes",
                );
                entries.push(await pinFile(filename, directory));
            }
        }
    };
    await visit(directory);
    return entries.sort((left, right) => left.path.localeCompare(right.path));
}

/** Read the fresh full-builder closure; do not rebuild it or substitute source modules. */
export async function admitNativeControlInputs(
    { baseManifestPath, scenarioFile },
    { captureSource = () => snapshotSource(ROOT) } = {},
) {
    const manifestFile = await assertWorktreeTemporaryPath(baseManifestPath);
    const scenarioPath = await assertWorktreeTemporaryPath(scenarioFile);
    const scenarioCapture = await captureArtifactJson(scenarioPath);
    const scenarioInput = scenarioCapture.value;
    assert.ok(
        scenarioInput &&
            typeof scenarioInput === "object" &&
            !Array.isArray(scenarioInput),
        "Native scenario must be a JSON object",
    );
    assert.ok(
        scenarioInput.kind !== SCENARIO_KIND.NativeDiagnostic &&
            !Object.hasOwn(scenarioInput, "nativeDiagnostics"),
        "Native Docker cannot run guest-only native diagnostics or mutate host core policy",
    );
    const scenario = validateScenario(scenarioInput);
    const manifestCapture = await captureArtifactJson(manifestFile);
    const manifest = validateManifest(manifestCapture.value, manifestFile);
    const provenanceFile = path.join(
        path.dirname(manifestFile),
        "provenance.json",
    );
    assert.equal(
        path.dirname(manifest.guest.path),
        path.dirname(manifestFile),
        "Native image and full-build provenance must be paired in the same build directory",
    );
    const provenanceCapture = await captureArtifactJson(
        provenanceFile,
        32 * 1024 * 1024,
    );
    const provenance = provenanceCapture.value;
    assert.ok(
        !provenance.runtimeOrigin,
        "Native control requires the retained fresh full-build rootfs",
    );
    assert.equal(provenance.sourceCommit, manifest.sourceSha);
    assertImageReference(provenance.images?.runtime);
    const source = await captureSource();
    const controllerChanges = assertCoordinatorOnlySourceChanges(
        provenance.sourceInputs,
        source.files,
    );
    const rootfs = await realpath(
        await assertWorktreeTemporaryPath(
            path.join(path.dirname(manifestFile), "rootfs"),
        ),
    );
    const workbench = path.join(rootfs, "workbench");
    assert.ok(
        (await lstat(workbench)).isDirectory(),
        "Full workbench must be a real directory",
    );
    const expected = provenance.payload;
    assert.ok(
        Array.isArray(expected) && expected.length > 0,
        "Full build must retain a complete payload inventory",
    );
    const names = expected.map((entry) => relativeMember(entry.path));
    assert.equal(new Set(names).size, names.length);
    for (const name of ["state", "output", NATIVE_CONTROL_ARTIFACT.Shell])
        assert.ok(
            !names.some(
                (value) => value === name || value.startsWith(`${name}/`),
            ),
            "Fresh payload cannot contain prior control state",
        );
    const payload = await inventory(workbench);
    assert.deepEqual(
        payload,
        [...expected].sort((a, b) => a.path.localeCompare(b.path)),
    );
    const layout = resolveRuntimeLayout(workbench);
    for (const filename of [
        path.join(workbench, "guest/guest.mjs"),
        layout.natsBinary,
        ...layout.processes.map((value) => value.filename),
        ...layout.bootstrapProcesses.map((value) => value.filename),
        ...layout.startupMaintenance.map((value) => value.filename),
    ])
        await regularPin(filename);
    const osPins = {};
    for (const [key, logical] of Object.entries({
        node: NODE,
        busybox: BUSYBOX,
        hosts: "/etc/hosts",
    })) {
        const filename = await realpath(path.join(rootfs, logical.slice(1)));
        assert.ok(
            filename.startsWith(`${rootfs}${path.sep}`),
            "Rootfs input escapes its full build",
        );
        osPins[key] = await regularPin(filename);
    }
    const files = [
        manifestCapture.pin,
        provenanceCapture.pin,
        scenarioCapture.pin,
        await regularPin(manifest.guest.path),
    ];
    assert.equal(
        files[3].sha256,
        manifest.guest.sha256,
        "Immutable VM image no longer matches its manifest",
    );
    assert.equal(files[3].sizeBytes, manifest.guest.sizeBytes);
    const admitted = {
        manifestFile,
        scenarioPath,
        manifest,
        provenanceFile,
        provenance,
        rootfs,
        workbench,
        scenario,
        source,
        controllerChanges,
        osPins,
        files,
        payload,
        scenarioBytes: scenarioCapture.bytes,
    };
    await unchanged(admitted, undefined, captureSource);
    return admitted;
}

async function unchanged(admitted, stage, captureSource) {
    for (const expected of [
        ...admitted.files,
        ...Object.values(admitted.osPins),
    ])
        assert.deepEqual(await regularPin(expected.path), expected);
    assert.deepEqual(await inventory(admitted.workbench), admitted.payload);
    if (stage)
        assert.deepEqual(
            await inventory(
                stage,
                new Set(["state", "output", NATIVE_CONTROL_ARTIFACT.Shell]),
            ),
            admitted.payload,
        );
    assert.deepEqual(
        await captureSource(),
        admitted.source,
        "Native controller source changed during execution",
    );
}

/** Native platform comparison only. This never publishes a replay/disk verdict. */
export async function runNativeControl(
    {
        baseManifestPath,
        scenarioFile,
        cpu,
        outputRoot = path.join(ROOT, "tmp/simulation-native-controls"),
    },
    {
        container = withOwnedContainer,
        captureSource = () => snapshotSource(ROOT),
        hostIdentity = readNativeControlHostIdentity,
        writeScenario = writeFile,
    } = {},
) {
    const host = await hostIdentity();
    assert.equal(
        process.platform,
        "linux",
        "Native control requires an actual Linux host",
    );
    assert.equal(
        arch(),
        "x64",
        "Native amd64 control cannot use transparent cross-architecture emulation",
    );
    const nativeProfile = { kind: POLICY.kind, cpu };
    const expectedProfile = validateNativeControlProfile(nativeProfile, host);
    const admitted = await admitNativeControlInputs(
        { baseManifestPath, scenarioFile },
        { captureSource },
    );
    const directory = await createArtifactRunDirectory(outputRoot, "control-");
    const startedAt = performance.now();
    const stage = path.join(directory, "stage/workbench");
    const state = path.join(directory, "state"),
        output = path.join(directory, "output");
    const frozenScenario = path.join(directory, "scenario.json");
    const report = {
        version: 1,
        platform: POLICY.kind,
        directory,
        executionStatus: NATIVE_CONTROL_STATUS.Incomplete,
        propertyStatus: "unqualified",
        integrityStatus: NATIVE_CONTROL_STATUS.Incomplete,
        sourceSha: admitted.manifest.sourceSha,
        controllerSource: admitted.source,
        controllerChanges: admitted.controllerChanges,
        qualificationId: admitted.scenario.qualificationId,
        expectedChecks: admitted.scenario.expectedChecks,
        inputs: {
            files: admitted.files,
            os: admitted.osPins,
            payload: admitted.payload,
            image: admitted.provenance.images.runtime,
        },
        requestedProfile: expectedProfile,
        wallClockStartedAt: new Date().toISOString(),
        vmEpoch: admitted.manifest.epoch,
        hostContext: {
            kernel: release(),
            architecture: arch(),
            controllerNode: process.version,
            selectedCpuModel: cpus()[cpu]?.model,
        },
        limitations: [
            "Native-only platform comparison; no record/replay or full-disk parity qualification",
            "Native CPU/kernel/clocks/scheduling/storage differ together; non-reproduction does not clear the recorded crash",
            "Default world wall-clock epoch/order hashes can differ from the VM; old immutable timestamps are never retimed",
            "Piped host cores are suppressed by inherited hard/soft1; no host synthetic fault or kernel-policy mutation",
        ],
    };
    let startResult, failure;
    const shell = nativeControlAdmissionScript(expectedProfile);
    try {
        await mkdir(path.dirname(stage), { recursive: true });
        await cp(admitted.workbench, stage, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
            errorOnExist: true,
            force: false,
        });
        for (const target of [
            state,
            output,
            path.join(state, "tmp"),
            path.join(stage, "state"),
            path.join(stage, "output"),
        ])
            await mkdir(target, { recursive: true });
        await writeFile(
            path.join(stage, NATIVE_CONTROL_ARTIFACT.Shell),
            shell,
            { flag: "wx", mode: 0o600 },
        );
        await writeScenario(frozenScenario, admitted.scenarioBytes, {
            flag: "wx",
            mode: 0o444,
        });
        const stagedScenarioPin = await regularPin(frozenScenario);
        report.scenarioCopy = {
            expected: admitted.files[2],
            observed: stagedScenarioPin,
        };
        assert.equal(
            stagedScenarioPin.sizeBytes,
            admitted.files[2].sizeBytes,
            "Frozen scenario copy size differs from its admitted bytes",
        );
        assert.equal(
            stagedScenarioPin.sha256,
            admitted.files[2].sha256,
            "Frozen scenario copy differs from its admitted bytes",
        );
        report.scenarioPin = stagedScenarioPin;
        report.admissionShellPin = await regularPin(
            path.join(stage, NATIVE_CONTROL_ARTIFACT.Shell),
        );
        await unchanged(admitted, stage, captureSource);
        const owned = await container(
            {
                image: admitted.provenance.images.runtime,
                nativeProfile,
                command: [
                    "/usr/bin/env",
                    "-i",
                    ...Object.entries(NATIVE_CONTROL_ENVIRONMENT).map(
                        ([key, value]) => `${key}=${value}`,
                    ),
                    BUSYBOX,
                    "sh",
                    `${WORKBENCH}/${NATIVE_CONTROL_ARTIFACT.Shell}`,
                ],
                mounts: [
                    { source: stage, target: WORKBENCH },
                    {
                        source: state,
                        target: `${WORKBENCH}/state`,
                        readOnly: false,
                    },
                    { source: output, target: OUTPUT, readOnly: false },
                    { source: frozenScenario, target: SCENARIO },
                    {
                        source: admitted.osPins.hosts.path,
                        target: "/etc/hosts",
                    },
                    { source: admitted.osPins.busybox.path, target: BUSYBOX },
                ],
                timeoutMs: admitted.manifest.timeoutSeconds * 1000,
                artifactParent: path.join(directory, "containers"),
            },
            async (control) => {
                report.observedProfile = await control.inspectNativeProfile();
                assertNativeControlInspection(
                    report.observedProfile,
                    expectedProfile,
                    admitted.provenance.images.runtime,
                );
                const nodeInspection = path.join(directory, "container-node");
                await control.copyFrom(NODE, nodeInspection);
                const actualNode = await regularPin(nodeInspection);
                assert.equal(
                    actualNode.sha256,
                    admitted.osPins.node.sha256,
                    "Container Node differs from the full guest runtime image",
                );
                assert.equal(
                    actualNode.sizeBytes,
                    admitted.osPins.node.sizeBytes,
                );
                report.containerNode = actualNode;
                try {
                    startResult = await control.start();
                } catch (error) {
                    startResult = error.result;
                    throw error;
                }
            },
        );
        report.dockerArtifacts = owned.artifactsDirectory;
    } catch (error) {
        failure = error;
        report.error = error.message;
        report.dockerArtifacts = error.artifactsDirectory;
    } finally {
        // The Docker owner has completed labelled cleanup before this boundary.
        // Inspect dedicated bind outputs only after that acknowledgement.
        let cleanupAcknowledged = false;
        if (report.dockerArtifacts) {
            try {
                const descriptor = await readArtifactJson(
                    path.join(report.dockerArtifacts, "container.json"),
                );
                report.cleanup = descriptor.cleanup;
                assert.ok(
                    ["removed", "already-absent"].includes(descriptor.cleanup),
                    "Native container cleanup was not acknowledged",
                );
                cleanupAcknowledged = true;
            } catch (error) {
                failure ??= error;
                report.cleanupError = error.message;
            }
        }
        for (const [field, name] of [
            ["stdout", NATIVE_CONTROL_ARTIFACT.Stdout],
            ["stderr", NATIVE_CONTROL_ARTIFACT.Stderr],
        ]) {
            const text = Buffer.from(startResult?.[field] ?? "");
            if (text.length > MAX_OUTPUT_BYTES) {
                failure ??= new Error(
                    "Native attached output exceeded its byte ceiling",
                );
                report.outputLimit = true;
            }
            await writeFile(
                path.join(directory, name),
                text.subarray(0, MAX_OUTPUT_BYTES),
                { flag: "wx" },
            );
        }
        try {
            await unchanged(admitted, stage, captureSource);
            assert.deepEqual(
                await regularPin(frozenScenario),
                report.scenarioPin,
            );
            assert.deepEqual(
                await regularPin(
                    path.join(stage, NATIVE_CONTROL_ARTIFACT.Shell),
                ),
                report.admissionShellPin,
            );
            report.integrityStatus = NATIVE_CONTROL_STATUS.Passed;
        } catch (error) {
            failure ??= error;
            report.integrityStatus = NATIVE_CONTROL_STATUS.Failed;
            report.integrityError = error.message;
        }
        try {
            assert.ok(
                cleanupAcknowledged,
                "Private stores cannot be inspected before owned cleanup is acknowledged",
            );
            report.admission = assertNativeControlAdmission(
                await readArtifactJson(
                    path.join(output, NATIVE_CONTROL_ARTIFACT.Admission),
                    8192,
                ),
                expectedProfile,
            );
        } catch (error) {
            failure ??= error;
            report.admissionError = error.message;
        }
        if (!failure) {
            try {
                const completion = await assertGuestProtocol(
                    path.join(directory, NATIVE_CONTROL_ARTIFACT.Stdout),
                    admitted.scenario,
                );
                const transport = await readGuestEvidence(
                    path.join(directory, NATIVE_CONTROL_ARTIFACT.Stdout),
                );
                assertCompleteGuestEvidence(transport, completion);
                report.transport = {
                    serialSha256: transport.serialSha256,
                    processReady: transport.processReady,
                };
                report.guestReportedChecks = completion.checks;
                report.guestReportedPropertyStatus = completion.status;
                report.guestEvidence = await readArtifactJson(
                    path.join(
                        output,
                        completion.status === QUALIFICATION_STATUS.Passed
                            ? "result.json"
                            : "failure.json",
                    ),
                    16 * 1024 * 1024,
                );
                assert.deepEqual(
                    report.guestEvidence.checks,
                    completion.checks,
                    "Written native evidence differs from the declared guest protocol",
                );
                if (completion.status === QUALIFICATION_STATUS.Passed) {
                    assert.equal(
                        report.guestEvidence.qualificationId,
                        admitted.scenario.qualificationId,
                    );
                    assert.equal(
                        report.guestEvidence.probe?.storage?.requested,
                        false,
                        "Native platform cannot claim guest storage qualification",
                    );
                    assert.deepEqual(
                        {
                            checks: report.guestEvidence.checks,
                            evidence: report.guestEvidence.evidence,
                        },
                        transport.events[EVENT.Result],
                        "Written native result differs from stdout evidence",
                    );
                    assert.deepEqual(
                        report.guestEvidence.probe,
                        transport.events[EVENT.Probe],
                        "Written native probe differs from stdout evidence",
                    );
                } else {
                    assert.deepEqual(
                        report.guestEvidence,
                        transport.events[EVENT.Failure],
                        "Written native failure differs from stdout evidence",
                    );
                }
                const reached =
                    report.guestEvidence.evidence ?? report.guestEvidence;
                report.reached = {
                    checkpoints: reached.checkpoints?.map(
                        (value) => value.name,
                    ),
                    failedCheck: reached.failedCheck,
                    failedProperty: reached.failedProperty,
                    worldEpochSeconds: reached.world?.epochSeconds,
                };
                report.checks = completion.checks;
                report.propertyStatus = completion.status;
                report.executionStatus = NATIVE_CONTROL_STATUS.Passed;
            } catch (error) {
                failure = error;
                report.error = error.message;
            }
        }
        if (failure) report.executionStatus = NATIVE_CONTROL_STATUS.Incomplete;
        report.hostElapsedMs = Math.round(performance.now() - startedAt);
        await writeFile(
            path.join(directory, NATIVE_CONTROL_ARTIFACT.Report),
            json(report),
            { flag: "wx" },
        );
    }
    return report;
}

async function main(args) {
    assert.ok(
        args.length === 6 &&
            args[0] === "--manifest" &&
            args[2] === "--scenario" &&
            args[4] === "--cpu",
        "Usage: native-control.mjs --manifest FULL.json --scenario CASE.json --cpu INTEGER",
    );
    assert.match(args[5], /^(0|[1-9]\d*)$/);
    return runNativeControl({
        baseManifestPath: args[1],
        scenarioFile: args[3],
        cpu: Number(args[5]),
    });
}
if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
    main(process.argv.slice(2))
        .then((report) => {
            process.stdout.write(
                json({
                    directory: report.directory,
                    executionStatus: report.executionStatus,
                    propertyStatus: report.propertyStatus,
                }),
            );
            if (
                report.executionStatus !== NATIVE_CONTROL_STATUS.Passed ||
                report.propertyStatus !== QUALIFICATION_STATUS.Passed
            )
                process.exitCode = 1;
        })
        .catch((error) => {
            process.stderr.write(`${error.stack ?? error.message}\n`);
            process.exitCode = 1;
        });
