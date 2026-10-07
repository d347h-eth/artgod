import { createHash } from "node:crypto";
import { mkdir, readFile, cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { runRedactedCommand } from "../secret-output-redaction.mjs";

const checkout = "/home/runner/checkout";
const resultRoot = "/home/runner/result";
const evidencePath = path.join(resultRoot, "evidence", "job.json");
const record = {
    startedAt: new Date().toISOString(),
    status: "running",
    bootstrapNodeVersion: process.version,
    checks: [],
};
const environment = { ...process.env };
let bundleDirectory;
let listBundleFiles;
const save = async () =>
    await writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\n`);

function required(key) {
    const value = environment[key];
    if (!value) throw new Error(`Missing reproduction input: ${key}.`);
    return value;
}

async function run(label, command, args, cwd = checkout, stream = true) {
    const check = { label, command, args, status: "running" };
    record.checks.push(check);
    await save();
    try {
        const result = await runRedactedCommand(command, args, {
            cwd,
            env: environment,
            stream,
        });
        check.status = "passed";
        await save();
        return result.stdout.trim();
    } catch (error) {
        check.status = "failed";
        await save();
        throw error;
    }
}

async function lockDigests() {
    const { DESKTOP_CARGO_PROJECTS } = await import(
        path.join(checkout, "scripts/build/cargo-projects.mjs")
    );
    const digests = {};
    for (const { lockfilePath } of Object.values(DESKTOP_CARGO_PROJECTS)) {
        digests[lockfilePath] = createHash("sha256")
            .update(await readFile(path.join(checkout, lockfilePath)))
            .digest("hex");
    }
    return digests;
}

async function main() {
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await save();
    const repository = required("ARTGOD_REPRO_REPOSITORY");
    const revision = required("ARTGOD_REPRO_REVISION");
    if (
        !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(repository) ||
        !/^[a-f0-9]{40}$/.test(revision)
    )
        throw new Error(
            "Reproduction requires a public GitHub repository URL and full commit SHA.",
        );
    if (revision !== required("ARTGOD_RECIPE_REVISION"))
        throw new Error(
            "Runner recipe and requested checkout revisions differ.",
        );
    record.repository = repository;
    record.requestedRevision = revision;
    record.images = {
        ubuntu: {
            reference: required("ARTGOD_REPRO_UBUNTU_IMAGE"),
            publishedAt: required("ARTGOD_REPRO_UBUNTU_PUBLISHED_AT"),
        },
        bootstrap: {
            reference: required("ARTGOD_REPRO_NODE_BOOTSTRAP_IMAGE"),
            publishedAt: required("ARTGOD_REPRO_NODE_BOOTSTRAP_PUBLISHED_AT"),
        },
    };
    record.osRelease = await readFile("/etc/os-release", "utf8");
    record.architecture = process.arch;
    if (process.platform !== "linux" || process.arch !== "x64")
        throw new Error("Reproduction requires Linux x64.");
    await mkdir(checkout);
    await run(
        "Initialize isolated checkout",
        "git",
        ["init", checkout],
        "/home/runner",
    );
    await run("Select public source", "git", [
        "remote",
        "add",
        "origin",
        repository,
    ]);
    await run("Fetch committed revision", "git", [
        "fetch",
        "--depth=1",
        "origin",
        revision,
    ]);
    await run("Checkout committed revision", "git", [
        "checkout",
        "--detach",
        "FETCH_HEAD",
    ]);
    record.actualRevision = await run("Verify actual source revision", "git", [
        "rev-parse",
        "HEAD",
    ]);
    if (record.actualRevision !== revision)
        throw new Error("Checkout HEAD differs from the requested revision.");
    ({ listLinuxBundleFiles: listBundleFiles } = await import(
        path.join(checkout, "scripts/build/verify-linux-bundled-runtime.mjs")
    ));
    await mkdir(path.join(checkout, "tmp"));
    environment.TMPDIR = path.join(checkout, "tmp");
    const { assertPinnedInputAge } = await import(
        path.join(checkout, "scripts/build/pinned-build-inputs.mjs")
    );
    const { DEFAULT_MINIMUM_AGE_DAYS } = await import(
        path.join(checkout, "scripts/security/dependency-age-policy.mjs")
    );
    for (const [name, image] of Object.entries(record.images))
        assertPinnedInputAge(
            { fileName: name, publishedAt: image.publishedAt },
            DEFAULT_MINIMUM_AGE_DAYS,
        );
    record.locksBefore = await lockDigests();
    await writeFile(
        path.join(resultRoot, "evidence", "apt-packages.txt"),
        await run(
            "Record apt package inventory",
            "dpkg-query",
            ["-W"],
            checkout,
            false,
        ),
    );

    const nodeArchive = await run(
        "Acquire reviewed canonical Node",
        process.execPath,
        [
            "./scripts/build/desktop-runtime-inputs.mjs",
            "--node-archive",
            "linux-x64",
        ],
    );
    const nodeRoot = "/home/runner/tools/node";
    await mkdir(nodeRoot, { recursive: true });
    await run("Extract verified Node", "tar", [
        "-xJf",
        nodeArchive,
        "--strip-components=1",
        "-C",
        nodeRoot,
    ]);
    environment.PATH = `${nodeRoot}/bin:${environment.PATH}`;
    const manifest = JSON.parse(
        await readFile(path.join(checkout, "package.json"), "utf8"),
    );
    record.nodeVersion = await run("Check canonical Node", "node", [
        "--version",
    ]);
    if (record.nodeVersion !== `v${manifest.engines.node}`)
        throw new Error("Build Node does not match engines.node.");
    await run("Enable verified Node's Corepack", "corepack", ["enable"]);
    const toolchain = (
        await readFile(path.join(checkout, "rust-toolchain.toml"), "utf8")
    ).match(/^channel\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1];
    if (!toolchain) throw new Error("Expected exact Rust toolchain channel.");
    const installer = path.join(checkout, "tmp", "rustup-init.sh");
    await run("Fetch Rust bootstrap", "curl", [
        "--proto",
        "=https",
        "--tlsv1.2",
        "-sSf",
        "https://sh.rustup.rs",
        "-o",
        installer,
    ]);
    await run("Install declared Rust toolchain", "sh", [
        installer,
        "-y",
        "--profile",
        "minimal",
        "--default-toolchain",
        toolchain,
    ]);
    environment.PATH = `${environment.CARGO_HOME}/bin:${environment.PATH}`;
    await run("Install Linux Rust target", "rustup", [
        "target",
        "add",
        "x86_64-unknown-linux-gnu",
    ]);
    record.rustVersion = await run("Record Rust version", "rustc", [
        "--version",
    ]);
    record.cargoVersion = await run("Record Cargo version", "cargo", [
        "--version",
    ]);
    record.yarnVersion = await run("Record Yarn version", "yarn", [
        "--version",
    ]);
    if (record.yarnVersion !== manifest.packageManager.split("@")[1])
        throw new Error("Build Yarn does not match packageManager.");
    await run("Install locked project dependencies", "yarn", [
        "install",
        "--immutable",
        "--mode=skip-build",
    ]);
    await run("Check source versions", "yarn", ["check:version"]);
    await run("Test documentation contracts", "yarn", ["test:docs"]);
    await run("Check documentation", "yarn", ["check:docs"]);
    const {
        LINUX_RELEASE_BUILD_SCRIPT_NAME,
        resolveLinuxReleaseOutputDirectories,
    } = await import(
        path.join(checkout, "scripts/build/verify-linux-release-build.mjs")
    );
    record.outputDirectories = await resolveLinuxReleaseOutputDirectories({
        projectRoot: checkout,
        environment,
        runCommand: async (command, args, options) => ({
            stdout: await run(
                "Resolve Cargo build output",
                command,
                args,
                options.cwd,
                false,
            ),
        }),
    });
    bundleDirectory = record.outputDirectories.bundleDirectory;
    await save();
    await run("Verify unsigned Linux release build", "yarn", [
        LINUX_RELEASE_BUILD_SCRIPT_NAME,
        "--report",
        path.join(resultRoot, "evidence", "project-checks.json"),
    ]);
    record.locksAfter = await lockDigests();
    if (
        JSON.stringify(record.locksBefore) !== JSON.stringify(record.locksAfter)
    )
        throw new Error("Build changed a reviewed Cargo lock.");
    record.status = "passed";
}

try {
    await main();
} catch (error) {
    record.status = "failed";
    record.error = error.message;
    process.exitCode = 1;
    console.error(error);
} finally {
    // Preserve declared package files even when a later build/verification gate
    // failed. Their qualification is the job/report status, not their presence.
    if (bundleDirectory) {
        try {
            record.artifacts = [];
            for (const filePath of await listBundleFiles(bundleDirectory)) {
                const relativePath = path.relative(bundleDirectory, filePath);
                const destination = path.join(
                    resultRoot,
                    "artifacts",
                    relativePath,
                );
                await mkdir(path.dirname(destination), { recursive: true });
                await cp(filePath, destination);
                record.artifacts.push(relativePath);
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                record.collectionError = error.message;
                record.status = "failed";
                process.exitCode = 1;
            }
        }
    }
    record.finishedAt = new Date().toISOString();
    await save();
}
