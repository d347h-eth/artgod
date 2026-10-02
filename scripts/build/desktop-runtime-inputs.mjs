import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    DESKTOP_BUILD_TARGET_ENV_KEYS,
    DESKTOP_NODE_DIST_TARGET,
    MACOS_UNIVERSAL_NATIVE_ARCHITECTURES,
    resolveDesktopDistributionTargetFromEnvironment,
} from "./native-runtime-dependencies.mjs";
import {
    GITHUB_RELEASE_ASSET_URL_PATTERN,
    assertInputPublicationTimestamp,
    assertPinnedInputAge,
    assertPinnedInputBytesContract,
    materializePinnedInput,
    verifyGithubReleaseInputProvenance,
} from "./pinned-build-inputs.mjs";
import { runRedactedCommand } from "./secret-output-redaction.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const DESKTOP_RUNTIME_INPUT = Object.freeze({
    Node: "node",
    Nats: "nats",
});
const CONCRETE_TARGETS = Object.values(DESKTOP_NODE_DIST_TARGET).filter(
    (target) => target !== DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
);
const MANIFEST_RELATIVE_PATH = "config/desktop-runtime-inputs.json";
const NODE_RELEASE_INDEX_URL = "https://nodejs.org/dist/index.json";
const NATS_RELEASE_ASSET_URL_PREFIX =
    "https://api.github.com/repos/nats-io/nats-server/releases/assets/";

// The release manifest owns archive admission; derived executables have no cache.
export function validateDesktopRuntimeInputs(
    manifest,
    expectedNodeVersion,
    now = new Date(),
) {
    if (manifest?.schemaVersion !== 1)
        throw new Error("Unsupported desktop runtime input manifest schema.");
    const inputs = {};
    for (const runtime of Object.values(DESKTOP_RUNTIME_INPUT)) {
        const record = manifest[runtime];
        if (
            !/^\d+\.\d+\.\d+$/.test(record?.version ?? "") ||
            !Array.isArray(record.archives)
        ) {
            throw new Error(
                `Pinned ${runtime} requires an exact version and archives.`,
            );
        }
        if (
            runtime === DESKTOP_RUNTIME_INPUT.Node &&
            record.version !== expectedNodeVersion
        ) {
            throw new Error(
                `Pinned Node version ${record.version} does not match package.json engines.node ${expectedNodeVersion}.`,
            );
        }
        const archives = new Map();
        for (const input of record.archives) {
            assertPinnedInputBytesContract(input);
            const spec = archiveSpec(runtime, record.version, input.target);
            if (
                archives.has(input.target) ||
                input.fileName !== spec.fileName
            ) {
                throw new Error(
                    `Pinned ${runtime} archive target/name mismatch: ${input.target}.`,
                );
            }
            if (runtime === DESKTOP_RUNTIME_INPUT.Node) {
                assertInputPublicationTimestamp(
                    `${record.releaseDate}T23:59:59Z`,
                    input.fileName,
                );
                assertInputPublicationTimestamp(
                    input.lastModifiedAt,
                    input.fileName,
                );
                const publishedAt = [
                    `${record.releaseDate}T23:59:59Z`,
                    input.lastModifiedAt,
                ]
                    .sort()
                    .at(-1);
                if (
                    input.url !==
                        `https://nodejs.org/dist/v${record.version}/${input.fileName}` ||
                    input.publishedAt !== publishedAt ||
                    record.publicationEvidenceUrl !==
                        `https://nodejs.org/en/blog/release/v${record.version}` ||
                    record.checksumEvidenceUrl !==
                        `https://nodejs.org/dist/v${record.version}/SHASUMS256.txt`
                ) {
                    throw new Error(
                        `Pinned Node archive publication evidence mismatch: ${input.fileName}.`,
                    );
                }
            } else if (
                !GITHUB_RELEASE_ASSET_URL_PATTERN.test(input.url) ||
                !input.url.startsWith(NATS_RELEASE_ASSET_URL_PREFIX) ||
                input.releaseTag !== `v${record.version}` ||
                input.assetName !== input.fileName ||
                record.checksumEvidenceUrl !==
                    `https://github.com/nats-io/nats-server/releases/download/v${record.version}/SHA256SUMS`
            ) {
                throw new Error(
                    `Pinned NATS release asset mismatch: ${input.fileName}.`,
                );
            }
            assertPinnedInputAge(input, manifest.minimumAgeDays, now);
            archives.set(
                input.target,
                Object.freeze({
                    ...input,
                    ...spec,
                    version: record.version,
                    releaseDate: record.releaseDate,
                }),
            );
        }
        if (
            archives.size !== CONCRETE_TARGETS.length ||
            CONCRETE_TARGETS.some((target) => !archives.has(target))
        ) {
            throw new Error(
                `Pinned ${runtime} archive set must cover all concrete desktop targets.`,
            );
        }
        inputs[runtime] = Object.freeze({ version: record.version, archives });
    }
    return Object.freeze(inputs);
}

export async function readDesktopRuntimeInputs({
    rootDir = repositoryRoot,
    now = new Date(),
} = {}) {
    const [manifest, packageJson] = await Promise.all([
        readFile(path.join(rootDir, MANIFEST_RELATIVE_PATH), "utf8").then(
            JSON.parse,
        ),
        readFile(path.join(rootDir, "package.json"), "utf8").then(JSON.parse),
    ]);
    return validateDesktopRuntimeInputs(
        manifest,
        packageJson.engines?.node,
        now,
    );
}

// Resolve the same target contract as native dependency staging before touching resources.
export function resolveDesktopRuntimeInputContext(
    inputs,
    {
        environment = process.env,
        platform = process.platform,
        arch = process.arch,
    } = {},
) {
    const override =
        environment[DESKTOP_BUILD_TARGET_ENV_KEYS.NatsVersion]?.trim();
    if (override && override !== inputs.nats.version) {
        throw new Error(
            `${DESKTOP_BUILD_TARGET_ENV_KEYS.NatsVersion}=${override} is not reviewed; update ${MANIFEST_RELATIVE_PATH} before changing the bundled NATS version.`,
        );
    }
    const resolveTarget = (distributionTargetEnvKey) =>
        resolveDesktopDistributionTargetFromEnvironment({
            environment,
            distributionTargetEnvKey,
            platform,
            arch,
        });
    const target = resolveTarget(
        DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget,
    );
    if (
        target !==
        resolveTarget(DESKTOP_BUILD_TARGET_ENV_KEYS.NatsDistributionTarget)
    ) {
        throw new Error("Desktop Node and NATS targets must match.");
    }
    if (
        target === DESKTOP_NODE_DIST_TARGET.DarwinUniversal &&
        platform !== "darwin"
    ) {
        throw new Error(
            "Universal desktop runtimes require a macOS build host.",
        );
    }
    return Object.freeze({ inputs, target });
}

function archiveSpec(runtime, version, target) {
    if (!CONCRETE_TARGETS.includes(target))
        throw new Error(`Unsupported pinned desktop target: ${target}.`);
    const windows = target.startsWith("win-");
    const archiveKind = windows
        ? "zip"
        : runtime === DESKTOP_RUNTIME_INPUT.Node
          ? "tar.xz"
          : "tar.gz";
    const platformTarget =
        runtime === DESKTOP_RUNTIME_INPUT.Node
            ? target
            : target.replace(/^win-/, "windows-").replace(/-x64$/, "-amd64");
    const baseName = `${runtime === DESKTOP_RUNTIME_INPUT.Node ? "node" : "nats-server"}-v${version}-${platformTarget}`;
    const binaryName = `${runtime === DESKTOP_RUNTIME_INPUT.Node ? "node" : "nats-server"}${windows ? ".exe" : ""}`;
    return {
        fileName: `${baseName}.${archiveKind}`,
        archiveKind,
        binaryName,
        binaryMember: `${baseName}/${runtime === DESKTOP_RUNTIME_INPUT.Node && !windows ? "bin/" : ""}${binaryName}`,
    };
}

async function verifyNodeArchiveProvenance(input, fetchImplementation) {
    const response = await fetchImplementation(NODE_RELEASE_INDEX_URL);
    if (!response.ok)
        throw new Error(
            `Failed to verify Node release index: HTTP ${response.status}.`,
        );
    const releases = await response.json();
    if (
        !Array.isArray(releases) ||
        !releases.some(
            (release) =>
                release.version === `v${input.version}` &&
                release.date === input.releaseDate,
        )
    ) {
        throw new Error(
            `Pinned Node ${input.version} release publication mismatch.`,
        );
    }
    const archive = await fetchImplementation(input.url, { method: "HEAD" });
    const lastModified = new Date(archive.headers.get("last-modified") ?? "");
    if (
        !archive.ok ||
        Number(archive.headers.get("content-length")) !== input.sizeBytes ||
        !Number.isFinite(lastModified.getTime()) ||
        lastModified.toISOString().replace(".000Z", "Z") !==
            input.lastModifiedAt
    ) {
        throw new Error(
            `Pinned Node archive metadata mismatch: ${input.fileName}.`,
        );
    }
}

// One verified archive cache is shared by desktop staging and Docker Node bootstrap.
export async function prepareDesktopRuntimeArchive({
    rootDir = repositoryRoot,
    runtime,
    input,
    scratchDirectory,
    fetchImplementation = fetch,
}) {
    const cacheDirectory = path.join(
        rootDir,
        ".cache",
        runtime === DESKTOP_RUNTIME_INPUT.Node
            ? "desktop-node-runtime"
            : "desktop-nats-runtime",
        "downloads",
        `v${input.version}`,
    );
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    return materializePinnedInput({
        input,
        destinationPath: path.join(cacheDirectory, input.fileName),
        temporaryDirectory: scratchDirectory,
        fetchImplementation,
        verifyProvenance:
            runtime === DESKTOP_RUNTIME_INPUT.Node
                ? verifyNodeArchiveProvenance
                : verifyGithubReleaseInputProvenance,
    });
}

// Extraction selects one declared member; archive metadata cannot choose a staging path.
async function extractExecutable({
    input,
    archivePath,
    destinationDirectory,
    platform,
    runCommand,
}) {
    const binaryPath = path.join(destinationDirectory, input.binaryMember);
    await mkdir(destinationDirectory, { recursive: true });
    if (input.archiveKind !== "zip") {
        await runCommand("tar", [
            input.archiveKind === "tar.xz" ? "-xJf" : "-xzf",
            archivePath,
            "-C",
            destinationDirectory,
            "--",
            input.binaryMember,
        ]);
    } else if (platform === "win32") {
        await mkdir(path.dirname(binaryPath), { recursive: true });
        const literal = (value) => `'${value.replaceAll("'", "''")}'`;
        await runCommand("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            [
                "$ErrorActionPreference = 'Stop'",
                "Add-Type -AssemblyName System.IO.Compression.FileSystem",
                `$archive = [System.IO.Compression.ZipFile]::OpenRead(${literal(archivePath)})`,
                `try { $entry = $archive.GetEntry(${literal(input.binaryMember)}); if ($null -eq $entry) { throw 'Pinned executable missing' }; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, ${literal(binaryPath)}) } finally { $archive.Dispose() }`,
            ].join("; "),
        ]);
    } else {
        await runCommand("unzip", [
            "-q",
            archivePath,
            input.binaryMember,
            "-d",
            destinationDirectory,
        ]);
    }
    if (!(await lstat(binaryPath)).isFile())
        throw new Error(
            `Archive executable must be a regular file: ${input.binaryMember}.`,
        );
    return binaryPath;
}

// Every build gets fresh slices and fresh universal assemblies; no derived cache is read.
export async function stageDesktopRuntimeExecutables({
    rootDir = repositoryRoot,
    resourcesRootDir,
    context,
    platform = process.platform,
    runCommand = runRedactedCommand,
    fetchImplementation = fetch,
}) {
    const scratchRoot = path.join(rootDir, "tmp");
    await mkdir(scratchRoot, { recursive: true });
    const scratchDirectory = await mkdtemp(
        path.join(scratchRoot, "desktop-runtime-"),
    );
    const binaries = {};
    try {
        for (const runtime of Object.values(DESKTOP_RUNTIME_INPUT)) {
            const record = context.inputs[runtime];
            const targets =
                context.target === DESKTOP_NODE_DIST_TARGET.DarwinUniversal
                    ? MACOS_UNIVERSAL_NATIVE_ARCHITECTURES.map(
                          (slice) => slice.nodeTarget,
                      )
                    : [context.target];
            const slices = [];
            for (const target of targets) {
                const input = record.archives.get(target);
                const archivePath = await prepareDesktopRuntimeArchive({
                    rootDir,
                    runtime,
                    input,
                    scratchDirectory,
                    fetchImplementation,
                });
                slices.push(
                    await extractExecutable({
                        input,
                        archivePath,
                        destinationDirectory: path.join(
                            scratchDirectory,
                            runtime,
                            target,
                        ),
                        platform,
                        runCommand,
                    }),
                );
            }
            const binaryName = record.archives.get(targets[0]).binaryName;
            let binaryPath = slices[0];
            if (slices.length > 1) {
                binaryPath = path.join(scratchDirectory, runtime, binaryName);
                await runCommand("lipo", [
                    "-create",
                    ...slices,
                    "-output",
                    binaryPath,
                ]);
                if (!(await lstat(binaryPath)).isFile())
                    throw new Error(
                        "Universal runtime assembly must be a regular file.",
                    );
            }
            const outputDirectory = path.join(resourcesRootDir, runtime);
            await mkdir(outputDirectory, { recursive: true });
            const outputPath = path.join(outputDirectory, binaryName);
            // Never follow a leftover staging symlink when refreshing an executable.
            await rm(outputPath, { force: true });
            await copyFile(binaryPath, outputPath);
            if (!binaryName.endsWith(".exe")) await chmod(outputPath, 0o755);
            await writeFile(
                path.join(outputDirectory, "metadata.json"),
                JSON.stringify(
                    { version: record.version, target: context.target },
                    null,
                    2,
                ) + "\n",
            );
            binaries[runtime] = outputPath;
        }
        return Object.freeze(binaries);
    } finally {
        // This invocation owns only this freshly created staging workspace.
        await rm(scratchDirectory, { recursive: true, force: true });
    }
}

async function main() {
    const [command, target, ...extra] = process.argv.slice(2);
    if (
        command !== "--node-archive" ||
        !CONCRETE_TARGETS.includes(target) ||
        extra.length
    ) {
        throw new Error(
            "Usage: desktop-runtime-inputs.mjs --node-archive <concrete-target>",
        );
    }
    const inputs = await readDesktopRuntimeInputs();
    await mkdir(path.join(repositoryRoot, "tmp"), { recursive: true });
    const scratchDirectory = await mkdtemp(
        path.join(repositoryRoot, "tmp", "desktop-runtime-download-"),
    );
    try {
        console.log(
            await prepareDesktopRuntimeArchive({
                runtime: DESKTOP_RUNTIME_INPUT.Node,
                input: inputs.node.archives.get(target),
                scratchDirectory,
            }),
        );
    } finally {
        await rm(scratchDirectory, { recursive: true, force: true });
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
    await main();
