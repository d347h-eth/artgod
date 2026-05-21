#!/usr/bin/env node
import {
    access,
    chmod,
    cp,
    mkdir,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const packageJson = JSON.parse(
    await readFile(path.join(rootDir, "package.json"), "utf8"),
);
const nodeVersion = parseExactSemver(packageJson.engines?.node, "engines.node");
const defaultDistTarget = inferNodeDistTarget(process.platform, process.arch);
const nodeDistTarget =
    process.env.DESKTOP_NODE_DIST_TARGET?.trim() || defaultDistTarget;
const nodeCacheRoot = path.join(rootDir, ".cache", "desktop-node-runtime");
const natsVersion = parseExactSemver(
    process.env.DESKTOP_NATS_VERSION?.trim() || "2.10.17",
    "DESKTOP_NATS_VERSION",
);
const natsDistTarget =
    process.env.DESKTOP_NATS_DIST_TARGET?.trim() || defaultDistTarget;
const natsCacheRoot = path.join(rootDir, ".cache", "desktop-nats-runtime");

const resourcesRootDir = path.join(
    rootDir,
    "src-tauri",
    "resources",
    "runtime",
);

const copySpecs = [
    {
        source: path.join(rootDir, "backend", "dist-desktop"),
        target: path.join(resourcesRootDir, "backend", "dist-desktop"),
        description: "backend runtime artifacts",
    },
    {
        source: path.join(rootDir, "frontend", "dist-userland"),
        target: path.join(resourcesRootDir, "frontend", "userland"),
        description: "userland frontend static artifacts",
    },
    {
        source: path.join(rootDir, "indexer", "dist-desktop"),
        target: path.join(resourcesRootDir, "indexer", "dist-desktop"),
        description: "indexer runtime artifacts",
    },
    {
        source: path.join(rootDir, "trading", "dist-desktop"),
        target: path.join(resourcesRootDir, "trading", "dist-desktop"),
        description: "trading runtime artifacts",
    },
    {
        source: path.join(rootDir, "database", "migrations"),
        target: path.join(resourcesRootDir, "database", "migrations"),
        description: "database migrations",
    },
    {
        source: path.join(rootDir, ".pnp.cjs"),
        target: path.join(resourcesRootDir, ".pnp.cjs"),
        description: "Yarn PnP runtime hook (.pnp.cjs)",
    },
    {
        source: path.join(rootDir, ".pnp.loader.mjs"),
        target: path.join(resourcesRootDir, ".pnp.loader.mjs"),
        description: "Yarn PnP runtime hook (.pnp.loader.mjs)",
    },
    {
        source: path.join(rootDir, ".yarn", "cache"),
        target: path.join(resourcesRootDir, ".yarn", "cache"),
        description: "Yarn local package cache",
    },
    {
        source: path.join(rootDir, ".yarn", "unplugged"),
        target: path.join(resourcesRootDir, ".yarn", "unplugged"),
        description: "Yarn unplugged native/runtime packages",
    },
    {
        source: path.join(rootDir, ".yarn", "install-state.gz"),
        target: path.join(resourcesRootDir, ".yarn", "install-state.gz"),
        description: "Yarn install state",
    },
];

await rm(resourcesRootDir, { recursive: true, force: true });
await mkdir(resourcesRootDir, { recursive: true });

for (const spec of copySpecs) {
    await assertExists(spec.source, spec.description);
    await mkdir(path.dirname(spec.target), { recursive: true });
    await cp(spec.source, spec.target, { recursive: true });
}

// Keep only native prebuilds that match the bundled desktop runtime target.
await pruneNativePrebuilds(resourcesRootDir, nodeDistTarget);

await bundleNodeRuntime({
    cacheRootDir: nodeCacheRoot,
    nodeVersion,
    nodeDistTarget,
    resourcesRootDir,
});
await bundleNatsRuntime({
    cacheRootDir: natsCacheRoot,
    natsVersion,
    natsDistTarget,
    resourcesRootDir,
});

// Keep runtime resources directory tracked in git between clean/build cycles.
await writeFile(path.join(resourcesRootDir, ".gitkeep"), "", "utf8");

console.log(
    `Prepared desktop runtime resources at ${path.relative(rootDir, resourcesRootDir)} (node ${nodeVersion}, node target ${nodeDistTarget}, nats ${natsVersion}, nats target ${natsDistTarget})`,
);

async function assertExists(targetPath, description) {
    try {
        await access(targetPath);
    } catch {
        throw new Error(
            `Missing ${description}: ${path.relative(rootDir, targetPath)}. Run \`yarn install --immutable\` and then \`yarn build:runtime\`.`,
        );
    }
}

function parseExactSemver(rawValue, sourceName) {
    const normalized = rawValue?.trim().replace(/^v/, "") ?? "";
    if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
        throw new Error(
            `${sourceName} must be an exact x.y.z version. Received: "${rawValue ?? ""}"`,
        );
    }
    return normalized;
}

function inferNodeDistTarget(platform, arch) {
    if (platform === "linux") {
        if (arch === "x64") return "linux-x64";
        if (arch === "arm64") return "linux-arm64";
    }
    if (platform === "darwin") {
        if (arch === "x64") return "darwin-x64";
        if (arch === "arm64") return "darwin-arm64";
    }
    if (platform === "win32") {
        if (arch === "x64") return "win-x64";
        if (arch === "arm64") return "win-arm64";
    }
    throw new Error(
        `Unsupported platform/arch for automatic Node runtime target: ${platform}/${arch}. Set DESKTOP_NODE_DIST_TARGET and DESKTOP_NATS_DIST_TARGET explicitly.`,
    );
}

async function pruneNativePrebuilds(targetRootDir, target) {
    const allowedTargets = getNativePrebuildTargets(target);
    const unpluggedDir = path.join(targetRootDir, ".yarn", "unplugged");
    const prebuildDirs = await findDirectoriesNamed(unpluggedDir, "prebuilds");

    for (const prebuildDir of prebuildDirs) {
        const entries = await readdir(prebuildDir, { withFileTypes: true });
        await Promise.all(
            entries
                .filter(
                    (entry) =>
                        entry.isDirectory() && !allowedTargets.has(entry.name),
                )
                .map((entry) =>
                    rm(path.join(prebuildDir, entry.name), {
                        recursive: true,
                        force: true,
                    }),
                ),
        );
    }
}

function getNativePrebuildTargets(target) {
    const targets = {
        "linux-x64": ["linux-x64", "linuxglibc-x64"],
        "linux-arm64": ["linux-arm64", "linuxglibc-arm64"],
        "darwin-x64": ["darwin-x64"],
        "darwin-arm64": ["darwin-arm64"],
        "darwin-universal": ["darwin-x64", "darwin-arm64"],
        "win-x64": ["win32-x64"],
        "win-arm64": ["win32-arm64"],
    };
    const allowedTargets = targets[target];
    if (!allowedTargets) {
        throw new Error(
            `Unsupported DESKTOP_NODE_DIST_TARGET "${target}" for native prebuild pruning.`,
        );
    }
    return new Set(allowedTargets);
}

async function findDirectoriesNamed(rootDir, targetName) {
    const matches = [];
    const entries = await readdir(rootDir, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const entryPath = path.join(rootDir, entry.name);
        if (entry.name === targetName) {
            matches.push(entryPath);
            continue;
        }

        matches.push(...(await findDirectoriesNamed(entryPath, targetName)));
    }

    return matches;
}

function getNodeArchiveSpec(nodeVersion, target) {
    const baseName = `node-v${nodeVersion}`;
    const specs = {
        "linux-x64": {
            archiveName: `${baseName}-linux-x64.tar.xz`,
            unpackDir: `${baseName}-linux-x64`,
            binaryRelativePath: "bin/node",
            binaryName: "node",
            archiveKind: "tar.xz",
        },
        "linux-arm64": {
            archiveName: `${baseName}-linux-arm64.tar.xz`,
            unpackDir: `${baseName}-linux-arm64`,
            binaryRelativePath: "bin/node",
            binaryName: "node",
            archiveKind: "tar.xz",
        },
        "darwin-x64": {
            archiveName: `${baseName}-darwin-x64.tar.xz`,
            unpackDir: `${baseName}-darwin-x64`,
            binaryRelativePath: "bin/node",
            binaryName: "node",
            archiveKind: "tar.xz",
        },
        "darwin-arm64": {
            archiveName: `${baseName}-darwin-arm64.tar.xz`,
            unpackDir: `${baseName}-darwin-arm64`,
            binaryRelativePath: "bin/node",
            binaryName: "node",
            archiveKind: "tar.xz",
        },
        "win-x64": {
            archiveName: `${baseName}-win-x64.zip`,
            unpackDir: `${baseName}-win-x64`,
            binaryRelativePath: "node.exe",
            binaryName: "node.exe",
            archiveKind: "zip",
        },
        "win-arm64": {
            archiveName: `${baseName}-win-arm64.zip`,
            unpackDir: `${baseName}-win-arm64`,
            binaryRelativePath: "node.exe",
            binaryName: "node.exe",
            archiveKind: "zip",
        },
    };
    const spec = specs[target];
    if (!spec) {
        throw new Error(
            `Unsupported DESKTOP_NODE_DIST_TARGET "${target}". Supported targets: ${Object.keys(specs).join(", ")}, darwin-universal.`,
        );
    }
    return spec;
}

function getNatsArchiveSpec(natsVersion, target) {
    const baseName = `nats-server-v${natsVersion}`;
    const specs = {
        "linux-x64": {
            archiveName: `${baseName}-linux-amd64.tar.gz`,
            unpackDir: `${baseName}-linux-amd64`,
            binaryRelativePath: "nats-server",
            binaryName: "nats-server",
            archiveKind: "tar.gz",
        },
        "linux-arm64": {
            archiveName: `${baseName}-linux-arm64.tar.gz`,
            unpackDir: `${baseName}-linux-arm64`,
            binaryRelativePath: "nats-server",
            binaryName: "nats-server",
            archiveKind: "tar.gz",
        },
        "darwin-x64": {
            archiveName: `${baseName}-darwin-amd64.tar.gz`,
            unpackDir: `${baseName}-darwin-amd64`,
            binaryRelativePath: "nats-server",
            binaryName: "nats-server",
            archiveKind: "tar.gz",
        },
        "darwin-arm64": {
            archiveName: `${baseName}-darwin-arm64.tar.gz`,
            unpackDir: `${baseName}-darwin-arm64`,
            binaryRelativePath: "nats-server",
            binaryName: "nats-server",
            archiveKind: "tar.gz",
        },
        "win-x64": {
            archiveName: `${baseName}-windows-amd64.zip`,
            unpackDir: `${baseName}-windows-amd64`,
            binaryRelativePath: "nats-server.exe",
            binaryName: "nats-server.exe",
            archiveKind: "zip",
        },
        "win-arm64": {
            archiveName: `${baseName}-windows-arm64.zip`,
            unpackDir: `${baseName}-windows-arm64`,
            binaryRelativePath: "nats-server.exe",
            binaryName: "nats-server.exe",
            archiveKind: "zip",
        },
    };
    const spec = specs[target];
    if (!spec) {
        throw new Error(
            `Unsupported DESKTOP_NATS_DIST_TARGET "${target}". Supported targets: ${Object.keys(specs).join(", ")}, darwin-universal.`,
        );
    }
    return spec;
}

async function bundleNodeRuntime({
    cacheRootDir,
    nodeVersion,
    nodeDistTarget,
    resourcesRootDir,
}) {
    const nodeBinaryPath = await ensureNodeBinary({
        cacheRootDir,
        nodeVersion,
        nodeDistTarget,
    });
    const nodeBinaryName = nodeBinaryPath.endsWith(".exe")
        ? "node.exe"
        : "node";
    const nodeTargetDir = path.join(resourcesRootDir, "node");
    await mkdir(nodeTargetDir, { recursive: true });

    const outputPath = path.join(nodeTargetDir, nodeBinaryName);
    await cp(nodeBinaryPath, outputPath);
    if (nodeBinaryName === "node") {
        await chmod(outputPath, 0o755);
    }

    await writeFile(
        path.join(nodeTargetDir, "metadata.json"),
        JSON.stringify(
            {
                version: nodeVersion,
                target: nodeDistTarget,
            },
            null,
            2,
        ) + "\n",
        "utf8",
    );
}

async function bundleNatsRuntime({
    cacheRootDir,
    natsVersion,
    natsDistTarget,
    resourcesRootDir,
}) {
    const natsBinaryPath = await ensureNatsBinary({
        cacheRootDir,
        natsVersion,
        natsDistTarget,
    });
    const natsBinaryName = natsBinaryPath.endsWith(".exe")
        ? "nats-server.exe"
        : "nats-server";
    const natsTargetDir = path.join(resourcesRootDir, "nats");
    await mkdir(natsTargetDir, { recursive: true });

    const outputPath = path.join(natsTargetDir, natsBinaryName);
    await cp(natsBinaryPath, outputPath);
    if (natsBinaryName === "nats-server") {
        await chmod(outputPath, 0o755);
    }

    await writeFile(
        path.join(natsTargetDir, "metadata.json"),
        JSON.stringify(
            {
                version: natsVersion,
                target: natsDistTarget,
            },
            null,
            2,
        ) + "\n",
        "utf8",
    );
}

async function ensureNodeBinary({ cacheRootDir, nodeVersion, nodeDistTarget }) {
    if (nodeDistTarget === "darwin-universal") {
        if (process.platform !== "darwin") {
            throw new Error(
                "DESKTOP_NODE_DIST_TARGET=darwin-universal requires running the build on macOS.",
            );
        }
        const arm64Binary = await ensureNodeBinaryForConcreteTarget({
            cacheRootDir,
            nodeVersion,
            concreteTarget: "darwin-arm64",
        });
        const x64Binary = await ensureNodeBinaryForConcreteTarget({
            cacheRootDir,
            nodeVersion,
            concreteTarget: "darwin-x64",
        });
        const universalDir = path.join(
            cacheRootDir,
            "assembled",
            `node-v${nodeVersion}-darwin-universal`,
        );
        const universalBinaryPath = path.join(universalDir, "node");
        if (!(await pathExists(universalBinaryPath))) {
            await rm(universalDir, { recursive: true, force: true });
            await mkdir(universalDir, { recursive: true });
            await runCommand("lipo", [
                "-create",
                arm64Binary,
                x64Binary,
                "-output",
                universalBinaryPath,
            ]);
        }
        await chmod(universalBinaryPath, 0o755);
        return universalBinaryPath;
    }
    return ensureNodeBinaryForConcreteTarget({
        cacheRootDir,
        nodeVersion,
        concreteTarget: nodeDistTarget,
    });
}

async function ensureNatsBinary({ cacheRootDir, natsVersion, natsDistTarget }) {
    if (natsDistTarget === "darwin-universal") {
        if (process.platform !== "darwin") {
            throw new Error(
                "DESKTOP_NATS_DIST_TARGET=darwin-universal requires running the build on macOS.",
            );
        }
        const arm64Binary = await ensureNatsBinaryForConcreteTarget({
            cacheRootDir,
            natsVersion,
            concreteTarget: "darwin-arm64",
        });
        const x64Binary = await ensureNatsBinaryForConcreteTarget({
            cacheRootDir,
            natsVersion,
            concreteTarget: "darwin-x64",
        });
        const universalDir = path.join(
            cacheRootDir,
            "assembled",
            `nats-server-v${natsVersion}-darwin-universal`,
        );
        const universalBinaryPath = path.join(universalDir, "nats-server");
        if (!(await pathExists(universalBinaryPath))) {
            await rm(universalDir, { recursive: true, force: true });
            await mkdir(universalDir, { recursive: true });
            await runCommand("lipo", [
                "-create",
                arm64Binary,
                x64Binary,
                "-output",
                universalBinaryPath,
            ]);
        }
        await chmod(universalBinaryPath, 0o755);
        return universalBinaryPath;
    }
    return ensureNatsBinaryForConcreteTarget({
        cacheRootDir,
        natsVersion,
        concreteTarget: natsDistTarget,
    });
}

async function ensureNodeBinaryForConcreteTarget({
    cacheRootDir,
    nodeVersion,
    concreteTarget,
}) {
    const spec = getNodeArchiveSpec(nodeVersion, concreteTarget);
    const checksums = await getNodeChecksums({ cacheRootDir, nodeVersion });
    const checksum = checksums.get(spec.archiveName);
    if (!checksum) {
        throw new Error(
            `Unable to find checksum for ${spec.archiveName} in SHASUMS256.txt`,
        );
    }

    const downloadsDir = path.join(
        cacheRootDir,
        "downloads",
        `v${nodeVersion}`,
    );
    await mkdir(downloadsDir, { recursive: true });
    const archivePath = path.join(downloadsDir, spec.archiveName);
    const archiveUrl = `https://nodejs.org/dist/v${nodeVersion}/${spec.archiveName}`;
    await ensureDownloadedFile({ archivePath, archiveUrl, checksum });

    const extractDir = path.join(
        cacheRootDir,
        "extracted",
        `node-v${nodeVersion}-${concreteTarget}`,
    );
    const binaryPath = path.join(
        extractDir,
        spec.unpackDir,
        spec.binaryRelativePath,
    );

    if (!(await pathExists(binaryPath))) {
        await rm(extractDir, { recursive: true, force: true });
        await mkdir(extractDir, { recursive: true });
        await extractArchive({
            archivePath,
            archiveKind: spec.archiveKind,
            destinationDir: extractDir,
        });
    }

    if (!(await pathExists(binaryPath))) {
        throw new Error(
            `Bundled Node binary missing after extraction: ${binaryPath}`,
        );
    }
    if (spec.binaryName === "node") {
        await chmod(binaryPath, 0o755);
    }
    return binaryPath;
}

async function ensureNatsBinaryForConcreteTarget({
    cacheRootDir,
    natsVersion,
    concreteTarget,
}) {
    const spec = getNatsArchiveSpec(natsVersion, concreteTarget);
    const checksums = await getNatsChecksums({ cacheRootDir, natsVersion });
    const checksum = checksums.get(spec.archiveName);
    if (!checksum) {
        throw new Error(
            `Unable to find checksum for ${spec.archiveName} in SHA256SUMS`,
        );
    }

    const downloadsDir = path.join(
        cacheRootDir,
        "downloads",
        `v${natsVersion}`,
    );
    await mkdir(downloadsDir, { recursive: true });
    const archivePath = path.join(downloadsDir, spec.archiveName);
    const archiveUrl = `https://github.com/nats-io/nats-server/releases/download/v${natsVersion}/${spec.archiveName}`;
    await ensureDownloadedFile({ archivePath, archiveUrl, checksum });

    const extractDir = path.join(
        cacheRootDir,
        "extracted",
        `nats-server-v${natsVersion}-${concreteTarget}`,
    );
    const binaryPath = path.join(
        extractDir,
        spec.unpackDir,
        spec.binaryRelativePath,
    );

    if (!(await pathExists(binaryPath))) {
        await rm(extractDir, { recursive: true, force: true });
        await mkdir(extractDir, { recursive: true });
        await extractArchive({
            archivePath,
            archiveKind: spec.archiveKind,
            destinationDir: extractDir,
        });
    }

    if (!(await pathExists(binaryPath))) {
        throw new Error(
            `Bundled NATS binary missing after extraction: ${binaryPath}`,
        );
    }
    if (spec.binaryName === "nats-server") {
        await chmod(binaryPath, 0o755);
    }
    return binaryPath;
}

async function getNodeChecksums({ cacheRootDir, nodeVersion }) {
    const checksumsDir = path.join(
        cacheRootDir,
        "downloads",
        `v${nodeVersion}`,
    );
    await mkdir(checksumsDir, { recursive: true });
    const checksumsPath = path.join(checksumsDir, "SHASUMS256.txt");
    const checksumsUrl = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;
    if (!(await pathExists(checksumsPath))) {
        await downloadFile(checksumsUrl, checksumsPath);
    }
    const content = await readFile(checksumsPath, "utf8");
    const result = new Map();
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
        if (!match) continue;
        result.set(match[2], match[1].toLowerCase());
    }
    return result;
}

async function getNatsChecksums({ cacheRootDir, natsVersion }) {
    const checksumsDir = path.join(
        cacheRootDir,
        "downloads",
        `v${natsVersion}`,
    );
    await mkdir(checksumsDir, { recursive: true });
    const checksumsPath = path.join(checksumsDir, "SHA256SUMS");
    const checksumsUrl = `https://github.com/nats-io/nats-server/releases/download/v${natsVersion}/SHA256SUMS`;
    if (!(await pathExists(checksumsPath))) {
        await downloadFile(checksumsUrl, checksumsPath);
    }
    const content = await readFile(checksumsPath, "utf8");
    const result = new Map();
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
        if (!match) continue;
        result.set(match[2], match[1].toLowerCase());
    }
    return result;
}

async function ensureDownloadedFile({ archivePath, archiveUrl, checksum }) {
    if (await pathExists(archivePath)) {
        const existingChecksum = await sha256File(archivePath);
        if (existingChecksum === checksum) {
            return;
        }
        await rm(archivePath, { force: true });
    }

    await downloadFile(archiveUrl, archivePath);
    const downloadedChecksum = await sha256File(archivePath);
    if (downloadedChecksum !== checksum) {
        throw new Error(
            `Checksum mismatch for ${archivePath}. Expected ${checksum}, received ${downloadedChecksum}`,
        );
    }
}

async function downloadFile(url, destinationPath) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `Failed to download ${url}: HTTP ${response.status} ${response.statusText}`,
        );
    }
    const content = Buffer.from(await response.arrayBuffer());
    await writeFile(destinationPath, content);
}

async function sha256File(filePath) {
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
}

async function extractArchive({ archivePath, archiveKind, destinationDir }) {
    if (archiveKind === "tar.xz") {
        await runCommand("tar", ["-xJf", archivePath, "-C", destinationDir]);
        return;
    }
    if (archiveKind === "tar.gz") {
        await runCommand("tar", ["-xzf", archivePath, "-C", destinationDir]);
        return;
    }
    if (archiveKind === "zip") {
        if (process.platform === "win32") {
            const archiveLiteral = archivePath.replace(/'/g, "''");
            const destinationLiteral = destinationDir.replace(/'/g, "''");
            await runCommand("powershell.exe", [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `Expand-Archive -LiteralPath '${archiveLiteral}' -DestinationPath '${destinationLiteral}' -Force`,
            ]);
            return;
        }
        await runCommand("unzip", ["-q", archivePath, "-d", destinationDir]);
        return;
    }
    throw new Error(`Unsupported archive kind: ${archiveKind}`);
}

async function runCommand(command, args) {
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: "inherit",
        });
        child.on("error", (error) => {
            reject(
                new Error(
                    `Failed to run command "${command} ${args.join(" ")}": ${String(error)}`,
                ),
            );
        });
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    `Command "${command} ${args.join(" ")}" exited with code ${String(code)}`,
                ),
            );
        });
    });
}

async function pathExists(targetPath) {
    try {
        await stat(targetPath);
        return true;
    } catch {
        return false;
    }
}
