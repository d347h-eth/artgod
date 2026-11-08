#!/usr/bin/env node
import { copyFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    assertWorktreeTemporaryPath,
    createArtifactRunDirectory,
    hashFile,
} from "./artifacts.mjs";
import { assertBoundedFile, readArtifactJson } from "./run-evidence.mjs";
import {
    assertGuestProtocol,
    executeCommand,
    executeSuccessfulCommand,
    preflight,
    qemuArguments,
    QEMU_ENVIRONMENT,
} from "./qemu-replay.mjs";
import { QUALIFICATION_CHECKS } from "./qualification-protocol.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const digestPattern = /^[a-f0-9]{64}$/;

/** Only locations of the new overlay and copied original event log may differ. */
export function assertRecordedProfile(command, manifest, originalDirectory) {
    if (
        !command ||
        Object.keys(command).sort().join(",") !== "args,env,file" ||
        typeof originalDirectory !== "string" ||
        !path.isAbsolute(originalDirectory)
    )
        throw new Error("Recorded replay command/profile is malformed");
    const expected = qemuArguments(
        manifest,
        path.join(originalDirectory, "replay.qcow2"),
        path.join(originalDirectory, "replay.bin"),
        "replay",
    );
    if (
        command.file !== manifest.qemu.path ||
        !isDeepStrictEqual(command.env, QEMU_ENVIRONMENT) ||
        !isDeepStrictEqual(command.args, expected)
    )
        throw new Error(
            "Recorded QEMU profile differs; restore the matching runner rather than recording a replacement execution",
        );
}

/** Replay an existing completed execution; this function never enters record mode. */
export async function replayRun({
    runDirectory,
    outputRoot = path.join(ROOT, "tmp", "simulation-replays"),
    execute = executeCommand,
}) {
    const source = await realpath(
        await assertWorktreeTemporaryPath(runDirectory),
    );
    const files = Object.fromEntries(
        [
            "report.json",
            "input-manifest.json",
            "replay-command.json",
            "record-serial.log",
            "replay-serial.log",
            "replay.bin",
        ].map((name) => [name, path.join(source, name)]),
    );
    const original = await readArtifactJson(files["report.json"]);
    if (
        original.version !== 1 ||
        original.engineReplayStatus !== "passed" ||
        !["passed", "failed"].includes(original.propertyStatus) ||
        original.status !== original.propertyStatus ||
        !digestPattern.test(original.replayLogSha256 ?? "") ||
        !digestPattern.test(original.serialSha256 ?? "")
    )
        throw new Error(
            "Exact replay requires a completed original record/replay pair with explicit property and digest evidence",
        );
    await assertBoundedFile(files["replay.bin"], Number.MAX_SAFE_INTEGER);
    for (const name of ["record-serial.log", "replay-serial.log"])
        await assertBoundedFile(files[name], 64 * 1024 * 1024);
    if (
        !(await stat(files["replay.bin"])).size ||
        (await hashFile(files["replay.bin"])) !== original.replayLogSha256 ||
        (await hashFile(files["record-serial.log"])) !==
            original.serialSha256 ||
        (await hashFile(files["replay-serial.log"])) !== original.serialSha256
    )
        throw new Error(
            "Original replay log or serial digest no longer matches its report",
        );
    const inputManifestSha256 = await hashFile(files["input-manifest.json"]);
    if (
        original.inputManifestSha256 !== undefined &&
        original.inputManifestSha256 !== inputManifestSha256
    )
        throw new Error("Original normalized input manifest changed");
    const admitted = await preflight(files["input-manifest.json"], { execute });
    const command = await readArtifactJson(files["replay-command.json"]);
    assertRecordedProfile(command, admitted.manifest, original.directory);
    const fingerprints = Object.fromEntries(
        await Promise.all(
            Object.entries(files).map(async ([name, filename]) => [
                name,
                await hashFile(filename),
            ]),
        ),
    );
    const unchanged = async () => {
        for (const [name, filename] of Object.entries(files))
            if ((await hashFile(filename)) !== fingerprints[name])
                throw new Error(`Original artifact changed: ${name}`);
        await preflight(files["input-manifest.json"], { execute });
    };
    const directory = await createArtifactRunDirectory(outputRoot, "replay-");
    const report = {
        version: 1,
        sourceSha: admitted.manifest.sourceSha,
        qualificationId: admitted.manifest.qualificationId,
        directory,
        originalRunDirectory: source,
        evidence: "existing-whole-machine-replay",
        mode: "replay-only",
        status: "failed",
        engineReplayStatus: "unqualified",
        propertyStatus: "unqualified",
        substrateQualificationStatus: "not-run",
        sourceReportSha256: fingerprints["report.json"],
        replayLogSha256: original.replayLogSha256,
        manifestSha256: admitted.manifestSha256,
        limitations: [
            ...(original.limitations ?? []),
            ...(original.inputManifestSha256
                ? []
                : [
                      "Legacy source report did not hash its normalized manifest; admitted copy is checked throughout this replay",
                  ]),
        ],
    };
    try {
        await unchanged();
        await writeFile(
            path.join(directory, "input-manifest.json"),
            JSON.stringify(admitted.manifest, null, 2),
        );
        report.inputManifestSha256 = await hashFile(
            path.join(directory, "input-manifest.json"),
        );
        const replayLog = path.join(directory, "replay.bin");
        await copyFile(files["replay.bin"], replayLog);
        await copyFile(
            files["record-serial.log"],
            path.join(directory, "record-serial.log"),
        );
        if ((await hashFile(replayLog)) !== original.replayLogSha256)
            throw new Error("Copied original event log changed before replay");
        const overlay = path.join(directory, "replay.qcow2");
        await executeSuccessfulCommand(
            execute,
            admitted.manifest.qemuImg.path,
            [
                "create",
                "-f",
                "qcow2",
                "-F",
                "qcow2",
                "-b",
                admitted.manifest.guest.path,
                overlay,
            ],
            { cwd: directory },
        );
        const args = qemuArguments(
            admitted.manifest,
            overlay,
            replayLog,
            "replay",
        );
        await writeFile(
            path.join(directory, "replay-command.json"),
            JSON.stringify(
                {
                    file: admitted.manifest.qemu.path,
                    args,
                    env: QEMU_ENVIRONMENT,
                },
                null,
                2,
            ),
        );
        const serial = path.join(directory, "replay-serial.log");
        await executeSuccessfulCommand(
            execute,
            admitted.manifest.qemu.path,
            args,
            {
                cwd: directory,
                timeoutMs: admitted.manifest.timeoutSeconds * 1000,
                stdoutPath: serial,
                stderrPath: path.join(directory, "replay-qemu.log"),
            },
        );
        if (!(await stat(serial)).size)
            throw new Error("Repeated replay serial output is empty");
        const completion = await assertGuestProtocol(serial, admitted.manifest);
        report.propertyStatus = completion.status;
        report.guestReportedChecks = completion.checks;
        report.serialSha256 = await hashFile(serial);
        if (
            report.serialSha256 !== original.serialSha256 ||
            report.propertyStatus !== original.propertyStatus
        )
            throw new Error(
                "Repeated replay differs from the original recorded serial/property result",
            );
        if ((await hashFile(replayLog)) !== original.replayLogSha256)
            throw new Error(
                "Repeated replay modified the original event log copy",
            );
        await unchanged();
        report.engineReplayStatus = "passed";
        report.status = report.propertyStatus;
        if (
            isDeepStrictEqual(
                [...admitted.manifest.expectedChecks].sort(),
                [...QUALIFICATION_CHECKS].sort(),
            )
        )
            report.substrateQualificationStatus = report.propertyStatus;
        return report;
    } catch (error) {
        report.engineReplayStatus = "failed";
        report.error = error.message;
        const failure = new Error(
            `${error.message}; replay artifacts: ${directory}`,
            { cause: error },
        );
        failure.report = report;
        failure.directory = directory;
        throw failure;
    } finally {
        await writeFile(
            path.join(directory, "report.json"),
            JSON.stringify(report, null, 2),
        );
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    if (process.argv.length !== 3) {
        process.stderr.write(
            "Usage: node scripts/simulation/replay-run.mjs RUN_DIRECTORY\n",
        );
        process.exitCode = 1;
    } else
        replayRun({ runDirectory: process.argv[2] })
            .then((report) => {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
                if (report.status !== "passed") process.exitCode = 1;
            })
            .catch((error) => {
                process.stderr.write(`${error.message}\n`);
                process.exitCode = 1;
            });
}
