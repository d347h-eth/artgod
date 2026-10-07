import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import manifest from "../../config/desktop-runtime-inputs.json" with { type: "json" };
import packageManifest from "../../package.json" with { type: "json" };
import {
    DESKTOP_RUNTIME_INPUT,
    prepareDesktopRuntimeArchive,
    resolveDesktopRuntimeInputContext,
    stageDesktopRuntimeExecutables,
    validateDesktopRuntimeInputs,
} from "./desktop-runtime-inputs.mjs";
import {
    DESKTOP_BUILD_TARGET_ENV_KEYS,
    DESKTOP_NODE_DIST_TARGET,
} from "./native-runtime-dependencies.mjs";
import { runRedactedCommand } from "./secret-output-redaction.mjs";

const scratchRoot = fileURLToPath(new URL("../../tmp/", import.meta.url));
const now = new Date("2026-10-03T00:00:00Z");
const validate = (value) =>
    validateDesktopRuntimeInputs(value, packageManifest.engines.node, now);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("reviewed runtime pins cover every concrete distribution target", () => {
    const inputs = validate(manifest);
    for (const runtime of Object.values(DESKTOP_RUNTIME_INPUT)) {
        assert.deepEqual(
            [...inputs[runtime].archives.keys()].sort(),
            Object.values(DESKTOP_NODE_DIST_TARGET)
                .filter(
                    (target) =>
                        target !== DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
                )
                .sort(),
        );
    }
});

test("version changes and incomplete, duplicate or inconsistent pins fail admission", () => {
    const mutations = [
        (value) => {
            value.node.version = "24.4.0";
        },
        (value) => {
            value.nats.archives.pop();
        },
        (value) => {
            value.node.archives[1] = value.node.archives[0];
        },
        (value) => {
            value.node.archives[0].sha256 = "invalid";
        },
        (value) => {
            value.nats.archives[0].releaseTag = "latest";
        },
        (value) => {
            value.node.archives[0].lastModifiedAt = "2025-02-30T00:00:00Z";
        },
        (value) => {
            value.node.archives[0].publishedAt = "2020-01-01T00:00:00Z";
        },
    ];
    for (const mutate of mutations) {
        const changed = structuredClone(manifest);
        mutate(changed);
        assert.throws(
            () => validate(changed),
            /match|archive|SHA-256|publication/,
        );
    }
});

test("both runtime owners enforce 30 full days before cache access", () => {
    for (const runtime of Object.values(DESKTOP_RUNTIME_INPUT)) {
        const value = structuredClone(manifest);
        if (runtime === DESKTOP_RUNTIME_INPUT.Nats) {
            for (const input of value.nats.archives)
                input.publishedAt = "2025-08-01T00:00:00Z";
        }
        const publishedAt = new Date(value[runtime].archives[0].publishedAt);
        const boundary = new Date(
            publishedAt.getTime() + 30 * 24 * 60 * 60 * 1000,
        );
        assert.doesNotThrow(() =>
            validateDesktopRuntimeInputs(
                value,
                packageManifest.engines.node,
                boundary,
            ),
        );
        assert.throws(
            () =>
                validateDesktopRuntimeInputs(
                    value,
                    packageManifest.engines.node,
                    new Date(boundary.getTime() - 1),
                ),
            /30-day age gate/,
        );
    }
    const value = structuredClone(manifest);
    value.minimumAgeDays = 29;
    assert.throws(() => validate(value), /at least 30 days/);
});

test("NATS overrides require the reviewed version and target contexts agree", () => {
    const inputs = validate(manifest);
    const options = { environment: {}, platform: "linux", arch: "x64" };
    assert.equal(
        resolveDesktopRuntimeInputContext(inputs, options).target,
        DESKTOP_NODE_DIST_TARGET.LinuxX64,
    );
    for (const override of [inputs.nats.version, undefined, ""]) {
        assert.doesNotThrow(() =>
            resolveDesktopRuntimeInputContext(inputs, {
                ...options,
                environment: {
                    [DESKTOP_BUILD_TARGET_ENV_KEYS.NatsVersion]: override,
                },
            }),
        );
    }
    assert.throws(
        () =>
            resolveDesktopRuntimeInputContext(inputs, {
                ...options,
                environment: {
                    [DESKTOP_BUILD_TARGET_ENV_KEYS.NatsVersion]: "2.10.19",
                },
            }),
        /not reviewed/,
    );
    assert.throws(
        () =>
            resolveDesktopRuntimeInputContext(inputs, {
                ...options,
                environment: {
                    [DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget]:
                        DESKTOP_NODE_DIST_TARGET.LinuxX64,
                    [DESKTOP_BUILD_TARGET_ENV_KEYS.NatsDistributionTarget]:
                        DESKTOP_NODE_DIST_TARGET.LinuxArm64,
                },
            }),
        /must match/,
    );
    assert.throws(
        () =>
            resolveDesktopRuntimeInputContext(inputs, {
                ...options,
                environment: {
                    [DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget]:
                        DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
                    [DESKTOP_BUILD_TARGET_ENV_KEYS.NatsDistributionTarget]:
                        DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
                },
            }),
        /macOS build host/,
    );
});

async function fixture() {
    await mkdir(scratchRoot, { recursive: true });
    const rootDir = await mkdtemp(
        path.join(scratchRoot, "runtime-input-test-"),
    );
    const value = structuredClone(manifest);
    const contents = new Map();
    for (const runtime of Object.values(DESKTOP_RUNTIME_INPUT)) {
        for (const input of value[runtime].archives) {
            const content = Buffer.from(`reviewed ${input.fileName}`);
            contents.set(input.url, content);
            input.sha256 = sha256(content);
            input.sizeBytes = content.length;
        }
    }
    const inputs = validate(value);
    const requests = [];
    const fetchImplementation = async (url, options = {}) => {
        requests.push({ url, method: options.method });
        if (url === "https://nodejs.org/dist/index.json") {
            return Response.json([
                {
                    version: `v${value.node.version}`,
                    date: value.node.releaseDate,
                },
            ]);
        }
        if (url.endsWith(`/releases/tags/v${value.nats.version}`)) {
            return Response.json({
                tag_name: `v${value.nats.version}`,
                draft: false,
                published_at: value.nats.archives[0].publishedAt,
                assets: value.nats.archives.map((input) => ({
                    id: Number(input.url.split("/").at(-1)),
                    name: input.fileName,
                    size: input.sizeBytes,
                    created_at: input.publishedAt,
                    updated_at: input.publishedAt,
                })),
            });
        }
        if (options.method === "HEAD") {
            const input = value.node.archives.find(
                (input) => input.url === url,
            );
            return new Response(null, {
                headers: {
                    "content-length": String(input.sizeBytes),
                    "last-modified": new Date(
                        input.lastModifiedAt,
                    ).toUTCString(),
                },
            });
        }
        assert.ok(contents.has(url), `Unexpected input request: ${url}`);
        return new Response(contents.get(url));
    };
    return { rootDir, value, inputs, contents, requests, fetchImplementation };
}

test("release dates and changed Node/NATS upload metadata fail before archive downloads", async () => {
    for (const runtime of Object.values(DESKTOP_RUNTIME_INPUT)) {
        const f = await fixture();
        const input = f.inputs[runtime].archives.get(
            DESKTOP_NODE_DIST_TARGET.LinuxX64,
        );
        const scratchDirectory = path.join(f.rootDir, "download");
        await mkdir(scratchDirectory);
        const fetchImplementation = async (url, options) => {
            const response = await f.fetchImplementation(url, options);
            if (url === input.url) {
                assert.equal(
                    options?.method,
                    "HEAD",
                    "archive bytes must not be downloaded",
                );
                response.headers.set(
                    "last-modified",
                    new Date(now).toUTCString(),
                );
            } else if (runtime === DESKTOP_RUNTIME_INPUT.Nats) {
                const metadata = await response.json();
                metadata.assets[0].updated_at = now
                    .toISOString()
                    .replace(".000Z", "Z");
                return Response.json(metadata);
            }
            return response;
        };
        await assert.rejects(
            prepareDesktopRuntimeArchive({
                rootDir: f.rootDir,
                runtime,
                input,
                scratchDirectory,
                fetchImplementation,
            }),
            /metadata mismatch|publication timestamp mismatch/,
        );
    }
});

test("fresh universal slices and assemblies ignore altered staging and legacy derived caches", async () => {
    const f = await fixture();
    const resourcesRootDir = path.join(f.rootDir, "resources");
    const context = resolveDesktopRuntimeInputContext(f.inputs, {
        environment: {
            [DESKTOP_BUILD_TARGET_ENV_KEYS.NodeDistributionTarget]:
                DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
            [DESKTOP_BUILD_TARGET_ENV_KEYS.NatsDistributionTarget]:
                DESKTOP_NODE_DIST_TARGET.DarwinUniversal,
        },
        platform: "darwin",
        arch: "arm64",
    });
    const assemblies = [];
    const runCommand = async (command, args) => {
        if (command === "tar") {
            const destination = args[args.indexOf("-C") + 1];
            const output = path.join(destination, args.at(-1));
            await mkdir(path.dirname(output), { recursive: true });
            await writeFile(output, await readFile(args[1]));
        } else {
            assert.equal(command, "lipo");
            const slices = await Promise.all(
                args.slice(1, 3).map((file) => readFile(file)),
            );
            assemblies.push(slices);
            await writeFile(args.at(-1), Buffer.concat(slices));
        }
    };
    const options = {
        rootDir: f.rootDir,
        resourcesRootDir,
        context,
        platform: "darwin",
        runCommand,
    };
    const binaries = await stageDesktopRuntimeExecutables({
        ...options,
        fetchImplementation: f.fetchImplementation,
    });
    const expected = await readFile(binaries.node);
    for (const runtime of Object.values(DESKTOP_RUNTIME_INPUT)) {
        await writeFile(binaries[runtime], "modified staged executable");
        const legacy = path.join(
            f.rootDir,
            ".cache",
            runtime === DESKTOP_RUNTIME_INPUT.Node
                ? "desktop-node-runtime"
                : "desktop-nats-runtime",
        );
        const prefix =
            runtime === DESKTOP_RUNTIME_INPUT.Node ? "node" : "nats-server";
        const record = f.inputs[runtime];
        const paths = ["darwin-arm64", "darwin-x64"].map((target) =>
            path.join(
                legacy,
                "extracted",
                `${prefix}-v${record.version}-${target}`,
                record.archives.get(target).binaryMember,
            ),
        );
        paths.push(
            path.join(
                legacy,
                "assembled",
                `${prefix}-v${record.version}-darwin-universal`,
                prefix,
            ),
        );
        for (const stalePath of paths) {
            await mkdir(path.dirname(stalePath), { recursive: true });
            await writeFile(stalePath, "modified cache");
        }
    }
    await stageDesktopRuntimeExecutables({
        ...options,
        fetchImplementation: async () => {
            assert.fail("verified archives must work offline");
        },
    });
    assert.deepEqual(await readFile(binaries.node), expected);
    assert.equal(assemblies.length, 4);
    assert.deepEqual(assemblies[0], assemblies[2]);
    assert.deepEqual(assemblies[1], assemblies[3]);
});

test("Linux tar extraction stages the declared executables from verified archives offline", async () => {
    const f = await fixture();
    for (const runtime of Object.values(DESKTOP_RUNTIME_INPUT)) {
        const input = f.inputs[runtime].archives.get(
            DESKTOP_NODE_DIST_TARGET.LinuxX64,
        );
        const source = path.join(f.rootDir, "archive-source", runtime);
        await mkdir(path.dirname(path.join(source, input.binaryMember)), {
            recursive: true,
        });
        await writeFile(
            path.join(source, input.binaryMember),
            `fresh ${runtime} executable`,
        );
        const archivePath = path.join(f.rootDir, input.fileName);
        await runRedactedCommand("tar", [
            runtime === DESKTOP_RUNTIME_INPUT.Node ? "-cJf" : "-czf",
            archivePath,
            "-C",
            source,
            input.binaryMember,
        ]);
        const bytes = await readFile(archivePath);
        const record = f.value[runtime].archives.find(
            (record) => record.target === input.target,
        );
        record.sizeBytes = bytes.length;
        record.sha256 = sha256(bytes);
        const cache = path.join(
            f.rootDir,
            ".cache",
            runtime === DESKTOP_RUNTIME_INPUT.Node
                ? "desktop-node-runtime"
                : "desktop-nats-runtime",
            "downloads",
            `v${input.version}`,
        );
        await mkdir(cache, { recursive: true });
        await writeFile(path.join(cache, input.fileName), bytes);
        const prefix =
            runtime === DESKTOP_RUNTIME_INPUT.Node ? "node" : "nats-server";
        const legacyBinary = path.join(
            f.rootDir,
            ".cache",
            runtime === DESKTOP_RUNTIME_INPUT.Node
                ? "desktop-node-runtime"
                : "desktop-nats-runtime",
            "extracted",
            `${prefix}-v${input.version}-${input.target}`,
            input.binaryMember,
        );
        await mkdir(path.dirname(legacyBinary), { recursive: true });
        await writeFile(
            legacyBinary,
            "changed extracted cache must not be staged",
        );
    }
    const context = resolveDesktopRuntimeInputContext(validate(f.value), {
        environment: {},
        platform: "linux",
        arch: "x64",
    });
    const binaries = await stageDesktopRuntimeExecutables({
        rootDir: f.rootDir,
        resourcesRootDir: path.join(f.rootDir, "resources"),
        context,
        fetchImplementation: async () => {
            assert.fail("network must not be needed");
        },
    });
    for (const runtime of Object.values(DESKTOP_RUNTIME_INPUT)) {
        assert.equal(
            await readFile(binaries[runtime], "utf8"),
            `fresh ${runtime} executable`,
        );
    }
});
