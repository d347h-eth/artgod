#!/usr/bin/env node
import { readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    assertWorktreeTemporaryPath,
    createArtifactRunDirectory,
    pinFile,
    hashFile,
} from "./artifacts.mjs";
import { readArtifactJson, assertBoundedFile } from "./run-evidence.mjs";
import {
    executeCommand,
    executeSuccessfulCommand,
    preflight,
} from "./qemu-replay.mjs";

import { assertExpectedOverlay } from "./image-artifacts.mjs";
export { assertExpectedOverlay } from "./image-artifacts.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Read completed synthetic guest output without host mounts or modifying images. */
export async function extractRun({
    runDirectory,
    debugfs,
    mode = "record",
    execute = executeCommand,
    outputRoot = path.join(ROOT, "tmp/simulation-extractions"),
}) {
    if (!["record", "replay"].includes(mode))
        throw new Error("Extraction mode must be record or replay");
    if (typeof debugfs !== "string" || !path.isAbsolute(debugfs))
        throw new Error("An explicit installed debugfs path is required");
    const debugfsPin = await pinFile(debugfs);
    const source = await realpath(
        await assertWorktreeTemporaryPath(runDirectory),
    );
    // Reports are written only after the VM process is closed. Never inspect a
    // live writable disk through a competing image client.
    const sourceReport = await readArtifactJson(
        path.join(source, "report.json"),
    );
    if (!["passed", "failed"].includes(sourceReport.engineReplayStatus))
        throw new Error("Extraction requires a completed VM run report");
    const manifestPath = path.join(source, "input-manifest.json");
    const { manifest, execute: engineExecute } = await preflight(manifestPath, {
        execute,
    });
    if (sourceReport.qualificationId !== manifest.qualificationId)
        throw new Error("Run report and input manifest identities disagree");
    const manifestHash = await hashFile(manifestPath);
    if (
        sourceReport.inputManifestSha256 &&
        sourceReport.inputManifestSha256 !== manifestHash
    )
        throw new Error("Normalized input manifest changed after execution");
    const overlay = path.join(source, `${mode}.qcow2`);
    await assertBoundedFile(overlay, Number.MAX_SAFE_INTEGER);
    const overlayPin = await pinFile(overlay);
    const inspect = await executeSuccessfulCommand(
        engineExecute,
        manifest.qemuImg.path,
        ["info", "--output=json", overlay],
    );
    assertExpectedOverlay(
        JSON.parse(inspect.stdout),
        manifest.guest.path,
        source,
    );
    const directory = await createArtifactRunDirectory(outputRoot, "extract-");
    const report = {
        version: 1,
        status: "failed",
        evidence: "read-only-synthetic-guest-diagnostics",
        sourceRunDirectory: source,
        mode,
        qualificationId: manifest.qualificationId,
        directory,
        overlay: overlayPin,
        debugfs: debugfsPin,
        files: [],
    };
    try {
        const raw = path.join(directory, "guest.ext4");
        await executeSuccessfulCommand(
            engineExecute,
            manifest.qemuImg.path,
            ["convert", "-f", "qcow2", "-O", "raw", overlay, raw],
            {
                cwd: directory,
                timeoutMs: 120_000,
                stdoutPath: path.join(directory, "convert.stdout.log"),
                stderrPath: path.join(directory, "convert.stderr.log"),
            },
        );
        const output = path.join(directory, "output");
        // The debugfs command is constant; all varying filenames are ordinary
        // argv paths. No host filesystem mount, shell expansion or write mode.
        await executeSuccessfulCommand(
            execute,
            debugfs,
            ["-R", "rdump /workbench/output .", raw],
            {
                cwd: directory,
                timeoutMs: 120_000,
                stdoutPath: path.join(directory, "debugfs.stdout.log"),
                stderrPath: path.join(directory, "debugfs.stderr.log"),
            },
        );
        const inventory = async (parent) => {
            for (const entry of await readdir(parent, {
                withFileTypes: true,
            })) {
                const filename = path.join(parent, entry.name);
                if (entry.isDirectory()) await inventory(filename);
                else if (entry.isFile())
                    report.files.push(await pinFile(filename, output));
                else
                    throw new Error(
                        "Unexpected file type in synthetic guest diagnostics",
                    );
            }
        };
        await inventory(output);
        if (
            !report.files.some((entry) =>
                ["result.json", "failure.json"].includes(entry.path),
            )
        )
            throw new Error(
                "The completed guest result was not extracted; inspect retained debugfs diagnostics",
            );
        if (
            (await hashFile(overlay)) !== overlayPin.sha256 ||
            (await hashFile(manifestPath)) !== manifestHash ||
            (await hashFile(debugfs)) !== debugfsPin.sha256
        )
            throw new Error("Diagnostic input changed during extraction");
        await preflight(manifestPath, { execute });
        report.status = "passed";
        return report;
    } catch (error) {
        report.error = error.message;
        const failure = new Error(
            `${error.message}; retained extraction: ${directory}`,
            { cause: error },
        );
        failure.report = report;
        throw failure;
    } finally {
        await writeFile(
            path.join(directory, "report.json"),
            `${JSON.stringify(report, null, 2)}\n`,
        );
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    const args = process.argv.slice(2);
    if (
        ![4, 6].includes(args.length) ||
        args[0] !== "--run" ||
        args[2] !== "--debugfs" ||
        (args.length === 6 && args[4] !== "--mode")
    ) {
        console.error(
            "Usage: extract-run.mjs --run RUN_DIRECTORY --debugfs INSTALLED_BINARY [--mode record|replay]",
        );
        process.exitCode = 1;
    } else
        extractRun({ runDirectory: args[1], debugfs: args[3], mode: args[5] })
            .then((result) => console.log(JSON.stringify(result, null, 2)))
            .catch((error) => {
                console.error(error.message);
                process.exitCode = 1;
            });
}
