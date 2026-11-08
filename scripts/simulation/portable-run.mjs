import {
    copyFile,
    lstat,
    mkdir,
    readdir,
    realpath,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    assertWorktreeTemporaryPath,
    createArtifactRunDirectory,
    hashFile,
    pinFile,
} from "./artifacts.mjs";
import { preflight, executeCommand } from "./qemu-replay.mjs";
import { assertRecordedProfile } from "./replay-run.mjs";
import { readArtifactJson, readRunEvidence } from "./run-evidence.mjs";
import { admitToolCapsule, validateToolCapsule } from "./tool-capsule.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const INPUTS = [
    "qemu",
    "qemuImg",
    "firmware",
    "kernel",
    "guest",
    "scenario",
    "toolCapsule",
];
const RUN_FILES = [
    "report.json",
    "input-manifest.json",
    "replay-command.json",
    "record-serial.log",
    "replay-serial.log",
    "replay.bin",
];
export const DEFAULT_FAILURE_BUNDLE_LIMIT = 3;
export const BUNDLE_EXPORT_STATUS = Object.freeze({
    Exported: "exported",
    Limited: "limited",
    Unqualified: "unqualified",
});

function exact(value, keys, label) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    )
        throw new Error(`${label} requires exactly ${keys.join(", ")}`);
}

function sameBytes(actual, expected, label) {
    if (
        actual.sha256 !== expected.sha256 ||
        actual.sizeBytes !== expected.sizeBytes
    )
        throw new Error(
            `Relocated ${label} differs from its original byte pin`,
        );
}

async function checkedBundlePin(root, pin) {
    exact(pin, ["path", "sha256", "sizeBytes"], "Relocation pin");
    if (
        typeof pin.path !== "string" ||
        !pin.path ||
        path.isAbsolute(pin.path) ||
        path.normalize(pin.path) !== pin.path ||
        pin.path === ".." ||
        pin.path.startsWith(`..${path.sep}`) ||
        /[\x00-\x1f]/.test(pin.path)
    )
        throw new Error("Relocation paths must stay within their bundle");
    const filename = path.join(root, pin.path);
    const metadata = await lstat(filename);
    const canonical = await realpath(filename);
    if (!metadata.isFile() || !canonical.startsWith(`${root}${path.sep}`))
        throw new Error("Relocation files must be regular bundle members");
    const actual = await pinFile(filename);
    sameBytes(actual, pin, pin.path);
    return actual;
}

/** Preserve the recorded inputs and tool userspace, not merely the event log. */
export async function exportReplayBundle({
    runDirectory,
    outputRoot = path.join(ROOT, "tmp/simulation-bundles"),
    execute = executeCommand,
}) {
    const source = await realpath(
        await assertWorktreeTemporaryPath(runDirectory),
    );
    const evidence = await readRunEvidence(source);
    if (
        evidence.report.engineReplayStatus !== "passed" ||
        evidence.report.evidence !== "whole-machine-record-replay"
    )
        throw new Error(
            "Portable replay export requires a completed qualified engine pair",
        );
    const admitted = await preflight(path.join(source, "input-manifest.json"), {
        execute,
    });
    if (!admitted.manifest.toolCapsule)
        throw new Error(
            "Portable replay requires an OCI tool capsule from the original execution",
        );
    const command = await readArtifactJson(
        path.join(source, "replay-command.json"),
    );
    assertRecordedProfile(
        command,
        admitted.manifest,
        evidence.report.directory,
    );
    const capsule = await admitToolCapsule(admitted.manifest.toolCapsule.path, {
        execute,
        manifest: admitted.manifest,
    });
    const runFiles = [
        ...RUN_FILES,
        ...(evidence.report.recordOverlay ? ["record.qcow2"] : []),
    ];
    const original = Object.fromEntries(
        await Promise.all(
            runFiles.map(async (name) => [
                name,
                await pinFile(path.join(source, name)),
            ]),
        ),
    );
    if (
        evidence.report.recordOverlay &&
        (original["record.qcow2"].sha256 !==
            evidence.report.recordOverlay.sha256 ||
            original["record.qcow2"].sizeBytes !==
                evidence.report.recordOverlay.sizeBytes)
    )
        throw new Error("Pinned record overlay changed before portable export");
    if (
        evidence.report.inputManifestSha256 &&
        evidence.report.inputManifestSha256 !==
            original["input-manifest.json"].sha256
    )
        throw new Error(
            "Original normalized input manifest changed before export",
        );
    if (
        original["replay.bin"].sha256 !== evidence.report.replayLogSha256 ||
        original["record-serial.log"].sha256 !== evidence.report.serialSha256
    )
        throw new Error(
            "Original replay log or record serial no longer matches its report",
        );
    const directory = await createArtifactRunDirectory(outputRoot, "bundle-");
    const run = path.join(directory, "run");
    const inputs = path.join(directory, "inputs");
    await mkdir(run);
    await mkdir(inputs);
    for (const name of runFiles)
        await copyFile(original[name].path, path.join(run, name));
    const mapped = {};
    for (const name of INPUTS) {
        const destination = path.join(inputs, name);
        await copyFile(admitted.manifest[name].path, destination);
        mapped[name] = await pinFile(destination, directory);
        sameBytes(mapped[name], admitted.manifest[name], name);
    }
    const archive = path.join(inputs, "tool-image.tar");
    await copyFile(capsule.archive.path, archive);
    const capsuleArchive = await pinFile(archive, directory);
    sameBytes(capsuleArchive, capsule.archive, "capsule archive");
    for (const name of runFiles) {
        if (
            (await hashFile(path.join(source, name))) !==
                original[name].sha256 ||
            (await hashFile(path.join(run, name))) !== original[name].sha256
        )
            throw new Error(
                `Recorded artifact changed during portable export: ${name}`,
            );
    }
    await preflight(path.join(source, "input-manifest.json"), { execute });
    const relocation = {
        version: 1,
        originalReportSha256: original["report.json"].sha256,
        originalManifestSha256: original["input-manifest.json"].sha256,
        inputs: mapped,
        capsuleArchive,
    };
    const relocationFile = path.join(directory, "relocation.json");
    await writeFile(relocationFile, `${JSON.stringify(relocation, null, 2)}\n`);
    const toolCapsuleFile = path.join(directory, "tool-capsule.json");
    const restorableCapsule = {
        ...capsule,
        archive: capsuleArchive,
        tools: Object.fromEntries(
            Object.entries(capsule.tools).map(([name, pin]) => [
                name,
                { ...pin, path: mapped[name].path },
            ]),
        ),
    };
    await writeFile(
        toolCapsuleFile,
        `${JSON.stringify(restorableCapsule, null, 2)}\n`,
    );
    return {
        directory,
        runDirectory: run,
        relocationFile,
        toolCapsuleFile,
        imageId: capsule.imageId,
        sizeBytes:
            Object.values(original).reduce(
                (total, pin) => total + pin.sizeBytes,
                0,
            ) +
            Object.values(mapped).reduce(
                (total, pin) => total + pin.sizeBytes,
                0,
            ) +
            capsuleArchive.sizeBytes +
            (await pinFile(relocationFile)).sizeBytes +
            (await pinFile(toolCapsuleFile)).sizeBytes,
    };
}

/** Bound large portable copies while retaining explicit reasons for every omission. */
export async function exportFailedRuns({
    runRoot = path.join(ROOT, "tmp/simulation-qemu"),
    outputRoot = path.join(ROOT, "tmp/simulation-failed-exports"),
    maxBundles = DEFAULT_FAILURE_BUNDLE_LIMIT,
    execute = executeCommand,
    exportRun = exportReplayBundle,
} = {}) {
    if (!Number.isSafeInteger(maxBundles) || maxBundles < 0 || maxBundles > 100)
        throw new Error(
            "Failure export requires an explicit finite bundle limit from 0 to 100",
        );
    const source = await assertWorktreeTemporaryPath(runRoot);
    const directory = await createArtifactRunDirectory(outputRoot, "exports-");
    const report = {
        version: 1,
        sourceRunRoot: source,
        maxBundles,
        completeBundles: 0,
        eligibleProductFailures: 0,
        entries: [],
    };
    const persist = () =>
        writeFile(
            path.join(directory, "index.json"),
            `${JSON.stringify(report, null, 2)}\n`,
        );
    let runs;
    try {
        runs = await readdir(source, { withFileTypes: true });
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        runs = [];
        report.scanNote = "No VM run directory exists";
    }
    for (const entry of runs.sort((left, right) =>
        left.name.localeCompare(right.name),
    )) {
        if (!entry.name.startsWith("run-")) continue;
        const runDirectory = path.join(source, entry.name);
        const item = { runDirectory, status: BUNDLE_EXPORT_STATUS.Unqualified };
        let original;
        try {
            if (!entry.isDirectory())
                throw new Error("Run entry is not an ordinary directory");
            original = await readArtifactJson(
                path.join(runDirectory, "report.json"),
            );
        } catch (error) {
            item.reason = `No readable completed report: ${error.message}`;
            report.entries.push(item);
            await persist();
            continue;
        }
        if (
            original.engineReplayStatus === "passed" &&
            original.propertyStatus === "passed"
        )
            continue;
        item.engineReplayStatus = original.engineReplayStatus ?? "unqualified";
        item.propertyStatus = original.propertyStatus ?? "unqualified";
        if (
            original.engineReplayStatus !== "passed" ||
            original.propertyStatus !== "failed"
        ) {
            item.reason =
                "Engine or property evidence is incomplete; raw run artifacts remain diagnostic";
        } else {
            report.eligibleProductFailures++;
            if (report.completeBundles >= maxBundles) {
                item.status = BUNDLE_EXPORT_STATUS.Limited;
                item.reason =
                    "Explicit complete-bundle limit reached; original run artifacts remain required and are not a portable bundle";
            } else
                try {
                    item.bundle = await exportRun({
                        runDirectory,
                        outputRoot: path.join(directory, "bundles"),
                        execute,
                    });
                    item.status = BUNDLE_EXPORT_STATUS.Exported;
                    report.completeBundles++;
                } catch (error) {
                    item.reason = error.message;
                }
        }
        report.entries.push(item);
        await persist();
    }
    await persist();
    return {
        directory,
        indexFile: path.join(directory, "index.json"),
        ...report,
    };
}

/** Admit only known path roles; every other original manifest/profile byte is evidence. */
export async function materializeReplayRelocation({
    relocationFile,
    originalManifest,
    originalReportSha256,
    originalManifestSha256,
    outputRoot = path.join(ROOT, "tmp/simulation-relocations"),
}) {
    const filename = await realpath(
        await assertWorktreeTemporaryPath(relocationFile),
    );
    const root = path.dirname(filename);
    const relocation = await readArtifactJson(filename);
    exact(
        relocation,
        [
            "version",
            "originalReportSha256",
            "originalManifestSha256",
            "inputs",
            "capsuleArchive",
        ],
        "Replay relocation",
    );
    if (
        relocation.version !== 1 ||
        relocation.originalReportSha256 !== originalReportSha256 ||
        relocation.originalManifestSha256 !== originalManifestSha256
    )
        throw new Error(
            "Relocation does not identify the original report/manifest",
        );
    if (!originalManifest.toolCapsule)
        throw new Error("Relocation requires the original OCI tool capsule");
    exact(relocation.inputs, INPUTS, "Relocation inputs");
    const pins = {};
    for (const name of INPUTS) {
        pins[name] = await checkedBundlePin(root, relocation.inputs[name]);
        sameBytes(pins[name], originalManifest[name], name);
    }
    const archive = await checkedBundlePin(root, relocation.capsuleArchive);
    const originalCapsule = validateToolCapsule(
        await readArtifactJson(pins.toolCapsule.path),
        pins.toolCapsule.path,
    );
    sameBytes(archive, originalCapsule.archive, "capsule archive");
    for (const name of ["qemu", "qemuImg", "firmware"]) {
        sameBytes(pins[name], originalCapsule.tools[name], name);
        if (
            name !== "firmware" &&
            originalManifest[name].version !==
                originalCapsule.tools[name].version
        )
            throw new Error(
                "Relocated engine version differs from its original capsule",
            );
    }
    const before = await hashFile(filename);
    const generated = [];
    const assertUnchanged = async () => {
        if ((await hashFile(filename)) !== before)
            throw new Error("Replay relocation changed after admission");
        for (const [name, pin] of Object.entries(pins))
            sameBytes(await pinFile(pin.path), pin, name);
        sameBytes(await pinFile(archive.path), archive, "capsule archive");
        for (const pin of generated)
            sameBytes(
                await pinFile(pin.path),
                pin,
                "materialized replay metadata",
            );
    };
    await assertUnchanged();
    const directory = await createArtifactRunDirectory(
        outputRoot,
        "relocation-",
    );
    const capsule = {
        ...originalCapsule,
        archive,
        tools: Object.fromEntries(
            Object.entries(originalCapsule.tools).map(([name, pin]) => [
                name,
                { ...pin, path: pins[name].path },
            ]),
        ),
    };
    const capsulePath = path.join(directory, "tool-capsule.json");
    await writeFile(capsulePath, `${JSON.stringify(capsule, null, 2)}\n`);
    const manifest = {
        ...originalManifest,
        ...Object.fromEntries(
            INPUTS.filter((name) => name !== "toolCapsule").map((name) => [
                name,
                { ...originalManifest[name], path: pins[name].path },
            ]),
        ),
        toolCapsule: await pinFile(capsulePath),
    };
    const manifestPath = path.join(directory, "input-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    generated.push(await pinFile(capsulePath), await pinFile(manifestPath));
    return {
        manifestPath,
        assertUnchanged,
        provenance: {
            file: filename,
            sha256: before,
            originalToolCapsuleSha256: originalManifest.toolCapsule.sha256,
            relocatedToolCapsuleSha256: manifest.toolCapsule.sha256,
            imageId: capsule.imageId,
        },
    };
}
