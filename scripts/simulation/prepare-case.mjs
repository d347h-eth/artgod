#!/usr/bin/env node
import {
    chmod,
    mkdir,
    open,
    readFile,
    readdir,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateScenario } from "./guest/scenario-contract.mjs";
import {
    assertWorktreeTemporaryPath,
    createArtifactRunDirectory,
    pinFile,
} from "./artifacts.mjs";
import { executeCommand, preflight } from "./qemu-replay.mjs";

export { validateScenario } from "./guest/scenario-contract.mjs";
export const SCENARIO_DISK_BYTES = 8 * 1024 * 1024;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function readScenario(filename) {
    return validateScenario(JSON.parse(await readFile(filename, "utf8")));
}

/** Independent read-only input disk: cached runtime images contain no selected case. */
export async function prepareScenarioDisk({
    scenarioFile,
    directory,
    execute = executeCommand,
}) {
    if (typeof scenarioFile !== "string" || !scenarioFile)
        throw new Error("An explicit scenario file is required");
    const scenario = await readScenario(scenarioFile);
    const output = await assertWorktreeTemporaryPath(directory);
    await mkdir(output, { recursive: true });
    await assertWorktreeTemporaryPath(output);
    if ((await readdir(output)).length)
        throw new Error("Scenario output directory must be fresh and empty");
    const payload = path.join(output, "payload");
    await mkdir(payload);
    const scenarioPath = path.join(payload, "scenario.json");
    await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, {
        flag: "wx",
        mode: 0o444,
    });
    const diskPath = path.join(output, "scenario.ext4");
    const disk = await open(diskPath, "wx");
    try {
        await disk.truncate(SCENARIO_DISK_BYTES);
    } finally {
        await disk.close();
    }
    let result;
    try {
        result = await execute(
            "mke2fs",
            [
                "-q",
                "-t",
                "ext4",
                "-F",
                "-L",
                "ARTGOD_SCENARIO",
                "-d",
                payload,
                diskPath,
            ],
            {
                cwd: output,
                timeoutMs: 30_000,
                env: {
                    PATH: process.env.PATH,
                    LANG: "C",
                    LC_ALL: "C",
                    TZ: "UTC",
                },
                stdoutPath: path.join(output, "filesystem.stdout.log"),
                stderrPath: path.join(output, "filesystem.stderr.log"),
            },
        );
    } catch (error) {
        error.preparationDirectory = output;
        throw error;
    }
    if (
        result.code !== 0 ||
        result.signal ||
        result.timedOut ||
        result.outputLimit
    )
        throw new Error(
            `Scenario filesystem creation failed; retained artifacts: ${output}`,
        );
    await chmod(diskPath, 0o444);
    return { directory: output, scenario, scenarioPath, diskPath };
}

/** Retest the same immutable production image with a new explicit external history. */
export async function prepareCase({
    baseManifestPath,
    scenarioFile,
    outputRoot = path.join(ROOT, "tmp", "simulation-cases"),
    execute = executeCommand,
}) {
    if (
        typeof baseManifestPath !== "string" ||
        !baseManifestPath ||
        typeof scenarioFile !== "string" ||
        !scenarioFile
    )
        throw new Error(
            "Explicit base manifest and scenario files are required",
        );
    await readScenario(scenarioFile);
    const { manifest: base } = await preflight(baseManifestPath, { execute });
    const directory = await createArtifactRunDirectory(outputRoot, "case-");
    try {
        const prepared = await prepareScenarioDisk({
            scenarioFile,
            directory: path.join(directory, "input"),
            execute,
        });
        const manifest = {
            ...base,
            qualificationId: prepared.scenario.qualificationId,
            expectedChecks: prepared.scenario.expectedChecks,
            scenario: await pinFile(prepared.diskPath, directory),
        };
        const manifestPath = path.join(directory, "manifest.json");
        await writeFile(
            manifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
            {
                flag: "wx",
                mode: 0o444,
            },
        );
        await preflight(manifestPath, { execute });
        return { directory, manifest, manifestPath };
    } catch (error) {
        error.preparationDirectory = directory;
        throw error;
    }
}

async function main(args) {
    if (
        args.length !== 4 ||
        args[0] !== "--base-manifest" ||
        args[2] !== "--scenario"
    )
        throw new Error(
            "Usage: node scripts/simulation/prepare-case.mjs --base-manifest INPUT.json --scenario CASE.json",
        );
    process.stdout.write(
        `${JSON.stringify(await prepareCase({ baseManifestPath: args[1], scenarioFile: args[3] }), null, 2)}\n`,
    );
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
