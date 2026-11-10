#!/usr/bin/env node
import {
    chmod,
    lstat,
    mkdir,
    readFile,
    stat,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createArtifactRunDirectory, pinFile } from "./artifacts.mjs";
import {
    DEFAULT_INPUT_PINS,
    readInputPins,
    validateBuildConfiguration,
} from "./input-pins.mjs";
export { DEFAULT_INPUT_PINS, validateInputPins } from "./input-pins.mjs";
import { withOwnedContainer } from "./docker.mjs";
import { validateScenario } from "./guest/scenario-contract.mjs";
import { executeCommand } from "./qemu-replay.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
async function explicitFile(filename, label) {
    if (
        typeof filename !== "string" ||
        !filename.trim() ||
        /[\x00-\x1f]/.test(filename)
    )
        throw new Error(`An explicit ${label} file is required`);
    const absolute = path.resolve(filename);
    if (!(await stat(absolute)).isFile())
        throw new Error(`${label} must be a regular file`);
    return absolute;
}

/**
 * Explicit provisioning command: pull only pinned images, copy files from fresh
 * stopped containers, and emit a build input. No host installation, service
 * configuration, existing-container access, volume mounts or standalone download.
 */
export async function provisionInputs({
    configFile = DEFAULT_INPUT_PINS,
    qemu,
    qemuImg,
    firmware,
    scenarioFile,
    outputRoot = path.join(ROOT, "tmp/simulation-inputs"),
    execute = executeCommand,
} = {}) {
    const pins = await readInputPins(configFile);
    const tools = {
        qemu: await explicitFile(qemu, "QEMU"),
        qemuImg: await explicitFile(qemuImg, "qemu-img"),
        firmware: await explicitFile(firmware, "firmware"),
        scenarioFile: await explicitFile(scenarioFile, "scenario"),
    };
    validateScenario(JSON.parse(await readFile(tools.scenarioFile, "utf8")));
    const directory = await createArtifactRunDirectory(outputRoot, "inputs-");
    const logs = path.join(directory, "logs");
    await mkdir(logs);
    let commandIndex = 0;
    const command = async (args, capture = false) => {
        const prefix = path.join(logs, String(++commandIndex).padStart(3, "0"));
        const result = await execute("docker", args, {
            cwd: ROOT,
            env: process.env,
            timeoutMs: 600_000,
            stdoutPath: `${prefix}.stdout.log`,
            stderrPath: `${prefix}.stderr.log`,
        });
        // executeCommand writes redirected output to disk. Read only bounded
        // command results when a container id or architecture is required.
        if (
            result.code !== 0 ||
            result.signal ||
            result.timedOut ||
            result.outputLimit
        )
            throw new Error(
                `Docker ${args[0]} failed (${result.timedOut ? "timeout" : result.outputLimit ? "output limit" : (result.signal ?? result.code)}); retained artifacts: ${directory}`,
            );
        if (!capture) return "";
        if (result.stdout) {
            if (Buffer.byteLength(result.stdout) > 4096)
                throw new Error("Unexpected Docker metadata output size");
            return result.stdout;
        }
        if ((await stat(`${prefix}.stdout.log`)).size > 4096)
            throw new Error("Unexpected Docker metadata output size");
        return readFile(`${prefix}.stdout.log`, "utf8");
    };
    const images = [
        ...new Set([
            pins.runtimeImage,
            pins.builderImage,
            pins.busyboxImage,
            pins.kernel.image,
            pins.nats.image,
        ]),
    ];
    for (const image of images) {
        await command(["pull", "--platform", "linux/amd64", image]);
        const architecture = (
            await command(
                ["image", "inspect", "--format", "{{.Architecture}}", image],
                true,
            )
        ).trim();
        if (architecture !== pins.architecture)
            throw new Error(`Pinned image architecture mismatch: ${image}`);
    }
    const extract = async (source, filename, mode) => {
        // A synthetic entrypoint permits inspecting scratch-style images. The
        // container is never started, so that path need not exist in the image.
        const destination = path.join(directory, filename);
        await withOwnedContainer(
            {
                image: source.image,
                command: ["/bin/true"],
                artifactParent: path.join(directory, "containers"),
                execute,
            },
            async (container) => {
                await container.copyFrom(source.path, destination);
                const copied = await lstat(destination);
                if (!copied.isFile() || copied.size === 0)
                    throw new Error(
                        "Container extraction must produce a nonempty regular file, never a symlink",
                    );
                await chmod(destination, mode);
            },
        );
        return destination;
    };
    const kernel = await extract(pins.kernel, "kernel", 0o644);
    const natsBinary = await extract(pins.nats, "nats-server", 0o755);
    const relative = (filename) => path.relative(directory, filename);
    const buildConfig = validateBuildConfiguration({
        version: 1,
        runtimeImage: pins.runtimeImage,
        builderImage: pins.builderImage,
        busyboxImage: pins.busyboxImage,
        kernel: relative(kernel),
        firmware: relative(tools.firmware),
        natsBinary: relative(natsBinary),
        qemu: relative(tools.qemu),
        qemuImg: relative(tools.qemuImg),
        machine: pins.machine,
        storageProfile: pins.storageProfile,
        cpu: pins.cpu,
        epoch: pins.epoch,
        scenarioFile: relative(tools.scenarioFile),
    });
    const buildConfigPath = path.join(directory, "build.json");
    await writeFile(
        buildConfigPath,
        `${JSON.stringify(buildConfig, null, 2)}\n`,
        { flag: "wx" },
    );
    await writeFile(
        path.join(directory, "provenance.json"),
        `${JSON.stringify({ version: 1, pins, extracted: { kernel: await pinFile(kernel, directory), natsBinary: await pinFile(natsBinary, directory) }, supplied: { qemu: await pinFile(tools.qemu, directory), qemuImg: await pinFile(tools.qemuImg, directory), firmware: await pinFile(tools.firmware, directory), scenario: await pinFile(tools.scenarioFile, directory) }, qualification: "unqualified; the builder and record/replay checks must still execute" }, null, 2)}\n`,
        { flag: "wx" },
    );
    return { directory, buildConfigPath, buildConfig };
}

export function parseProvisionArguments(args) {
    const names = new Map([
        ["--config", "configFile"],
        ["--qemu", "qemu"],
        ["--qemu-img", "qemuImg"],
        ["--firmware", "firmware"],
        ["--scenario", "scenarioFile"],
    ]);
    const result = {};
    for (let index = 0; index < args.length; index += 2) {
        const key = names.get(args[index]);
        if (
            !key ||
            result[key] !== undefined ||
            !args[index + 1] ||
            args[index + 1].startsWith("--")
        )
            throw new Error(
                "Expected unique --qemu PATH --qemu-img PATH --firmware PATH --scenario PATH, optionally --config FILE",
            );
        result[key] = args[index + 1];
    }
    if (
        ["qemu", "qemuImg", "firmware", "scenarioFile"].some(
            (key) => !result[key],
        )
    )
        throw new Error(
            "Explicit QEMU, qemu-img, firmware and scenario paths are required",
        );
    return result;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
    provisionInputs(parseProvisionArguments(process.argv.slice(2)))
        .then((result) => {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        })
        .catch((error) => {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        });
