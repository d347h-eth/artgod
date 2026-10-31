import assert from "node:assert/strict";
import {
    appendFile,
    mkdir,
    mkdtemp,
    readFile,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DESKTOP_CARGO_PROJECTS } from "../build/cargo-projects.mjs";
import {
    CARGO_AGE_GATE_RESULT_TYPE,
    checkCargoDependencyAge,
    formatCargoAgeGateProgress,
} from "./cargo-age-gate.mjs";
import {
    CRATES_IO_REGISTRY_SOURCE,
    CRATES_IO_API_BASE_URL,
    DEFAULT_CRATES_IO_METADATA_CONCURRENCY,
    DEFAULT_CARGO_AGE_GATE_CONFIG_RELATIVE_PATH,
    createCratesIoMetadataReader,
    cratesIoSparseIndexUrl,
    mapWithConcurrency,
    parseCommonArgs,
    readCargoLockPackages,
} from "./cargo-age-gate-utils.mjs";

const temporaryRoot = fileURLToPath(new URL("../../tmp/", import.meta.url));
const now = new Date("2026-10-03T00:00:00Z");
const checksum = "a".repeat(64);
const oldVersion = {
    number: "1.0.0",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    yanked: false,
    checksum,
};
const newVersion = { ...oldVersion, createdAt: now };

async function fixture({ missingProject, freshVersionExceptions = [] } = {}) {
    await mkdir(temporaryRoot, { recursive: true });
    const projectRoot = await mkdtemp(
        path.join(temporaryRoot, "cargo-admission-test-"),
    );
    const configPath = path.join(
        projectRoot,
        DEFAULT_CARGO_AGE_GATE_CONFIG_RELATIVE_PATH,
    );
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
        configPath,
        JSON.stringify({ minimumAgeDays: 30, freshVersionExceptions }),
    );
    for (const [name, project] of Object.entries(DESKTOP_CARGO_PROJECTS)) {
        if (name === missingProject) continue;
        const lockfile = path.join(projectRoot, project.lockfilePath);
        await mkdir(path.dirname(lockfile), { recursive: true });
        await writeFile(
            lockfile,
            `version = 4
[[package]]
name = "common"
version = "1.0.0"
source = "${CRATES_IO_REGISTRY_SOURCE}"
checksum = "${checksum}"
[[package]]
name = "${name.toLowerCase()}"
version = "1.0.0"
source = "${CRATES_IO_REGISTRY_SOURCE}"
checksum = "${checksum}"
`,
        );
    }
    return { projectRoot };
}

test("default age admission covers all roots and deduplicates shared dependencies", async () => {
    const f = await fixture();
    const requested = [];
    const progress = [];
    const result = await checkCargoDependencyAge({
        ...f,
        now,
        fetchVersions: async (name) => {
            requested.push(name);
            return [oldVersion];
        },
        onProgress: (entry) => progress.push(entry),
    });
    assert.equal(
        result.projectCount,
        Object.keys(DESKTOP_CARGO_PROJECTS).length,
    );
    assert.equal(result.packageCount, 4);
    assert.equal(requested.filter((name) => name === "common").length, 1);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(
        progress.map(({ completed, total }) => [completed, total]),
        [
            [1, 4],
            [2, 4],
            [3, 4],
            [4, 4],
        ],
    );
    assert.equal(
        new Set(progress.map(({ packageEntry }) => packageEntry.name)).size,
        4,
    );
    assert.ok(
        progress.every(
            ({ result }) => result.type === CARGO_AGE_GATE_RESULT_TYPE.Eligible,
        ),
    );
});

test("selected versions get separate percentage lines while sharing metadata", async () => {
    const f = await fixture();
    await appendFile(
        path.join(f.projectRoot, DESKTOP_CARGO_PROJECTS.Desktop.lockfilePath),
        `\n[[package]]\nname = "common"\nversion = "2.0.0"\nsource = "${CRATES_IO_REGISTRY_SOURCE}"\nchecksum = "${checksum}"\n`,
    );
    const requested = [];
    const progress = [];
    const result = await checkCargoDependencyAge({
        ...f,
        args: parseCommonArgs(["--package", "common", "--package", "desktop"], {
            defaultProject: null,
        }),
        now,
        fetchVersions: async (name, { requiredVersions }) => {
            if (name === "common")
                assert.deepEqual(requiredVersions, ["1.0.0", "2.0.0"]);
            requested.push(name);
            return [oldVersion, { ...oldVersion, number: "2.0.0" }];
        },
        onProgress: (entry) => progress.push(entry),
    });
    assert.equal(result.packageCount, 3);
    assert.equal(requested.filter((name) => name === "common").length, 1);
    assert.equal(progress.length, 3);
    assert.deepEqual(
        progress
            .filter(({ packageEntry }) => packageEntry.name === "common")
            .map(({ packageEntry }) => packageEntry.version),
        ["1.0.0", "2.0.0"],
    );
    assert.deepEqual(
        progress
            .map(formatCargoAgeGateProgress)
            .map((line) => line.match(/^\[(\d+)\/3 \(([\d.]+)%\)\]/)?.slice(1)),
        [
            ["1", "33.3"],
            ["2", "66.7"],
            ["3", "100.0"],
        ],
    );
});

test("exception and violation details stay on each package's single progress line", async () => {
    const progress = [];
    const result = await checkCargoDependencyAge({
        ...(await fixture({
            freshVersionExceptions: [
                {
                    name: "secretprompt",
                    version: "1.0.0",
                    reason: "Reviewed\nsecurity fix",
                },
            ],
        })),
        now,
        fetchVersions: async (name) =>
            name === "desktop"
                ? []
                : [
                      ["secretprompt", "sensitiveprocess"].includes(name)
                          ? newVersion
                          : oldVersion,
                  ],
        onProgress: (entry) => progress.push(entry),
    });
    assert.equal(progress.length, result.packageCount);
    assert.equal(result.allowlisted.length, 1);
    assert.equal(result.violations.length, 2);
    const allowed = progress.find(
        ({ result }) => result.type === CARGO_AGE_GATE_RESULT_TYPE.Allowlisted,
    );
    const violations = progress.filter(
        ({ result }) => result.type === CARGO_AGE_GATE_RESULT_TYPE.Violation,
    );
    assert.equal(allowed.result.message, result.allowlisted[0]);
    assert.deepEqual(
        violations.map(({ result }) => result.message),
        result.violations,
    );
    assert.match(
        violations[0].result.message,
        /missing from crates.io metadata/,
    );
    assert.match(formatCargoAgeGateProgress(allowed), /Reviewed security fix/);
    assert.ok(
        progress
            .map(formatCargoAgeGateProgress)
            .every((line) => !/[\r\n]/.test(line)),
    );
});

test("metadata errors report the failed package and drain already-started checks", async () => {
    const requested = [];
    const progress = [];
    const failure = new Error("registry unavailable");
    await assert.rejects(
        checkCargoDependencyAge({
            ...(await fixture()),
            now,
            fetchVersions: async (name) => {
                requested.push(name);
                if (name === "desktop") throw failure;
                return [oldVersion];
            },
            onProgress: (entry) => progress.push(entry),
        }),
        (error) => error === failure,
    );
    assert.deepEqual(requested, [
        "common",
        "desktop",
        "secretprompt",
        "sensitiveprocess",
    ]);
    assert.equal(progress.length, 4);
    const failed = progress.find(
        ({ result }) => result.type === CARGO_AGE_GATE_RESULT_TYPE.Error,
    );
    assert.equal(failed.total, 4);
    assert.equal(failed.packageEntry.name, "desktop");
    assert.match(formatCargoAgeGateProgress(failed), /registry unavailable/);
});

test("an empty package selection emits no progress or invalid percentage", async () => {
    const progress = [];
    const result = await checkCargoDependencyAge({
        ...(await fixture()),
        args: parseCommonArgs(["--package", "absent"], {
            defaultProject: null,
        }),
        now,
        fetchVersions: async () => assert.fail("network must not run"),
        onProgress: (entry) => progress.push(entry),
    });
    assert.equal(result.packageCount, 0);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(progress, []);
});

test("a fresh prompt-only or standalone-only dependency fails default admission", async () => {
    for (const freshName of ["secretprompt", "sensitiveprocess"]) {
        const result = await checkCargoDependencyAge({
            ...(await fixture()),
            now,
            fetchVersions: async (name) => [
                name === freshName ? newVersion : oldVersion,
            ],
        });
        assert.equal(result.violations.length, 1);
        assert.match(result.violations[0], new RegExp(freshName));
    }
});

test("a missing maintained lockfile fails before any metadata request", async () => {
    await assert.rejects(
        checkCargoDependencyAge({
            ...(await fixture({ missingProject: "SecretPrompt" })),
            now,
            fetchVersions: async () => {
                assert.fail("network must not run");
            },
            onProgress: () =>
                assert.fail("all lockfiles must be validated first"),
        }),
        /ENOENT/,
    );
});

test("explicit manifest or lockfile selection derives its matching independent root", () => {
    const project = DESKTOP_CARGO_PROJECTS.SecretPrompt;
    for (const argv of [
        ["--manifest-path", project.manifestPath],
        ["--lockfile", project.lockfilePath],
    ]) {
        const args = parseCommonArgs(argv);
        assert.equal(args.manifestPath, project.manifestPath);
        assert.equal(args.lockfilePath, project.lockfilePath);
    }
    assert.throws(
        () =>
            parseCommonArgs([
                "--manifest-path",
                project.manifestPath,
                "--lockfile",
                DESKTOP_CARGO_PROJECTS.Desktop.lockfilePath,
            ]),
        /same independent Cargo root/,
    );
});

test("a scoped diagnostic checks only the selected lockfile", async () => {
    const f = await fixture({ missingProject: "SecretPrompt" });
    const args = parseCommonArgs([
        "--manifest-path",
        DESKTOP_CARGO_PROJECTS.Desktop.manifestPath,
    ]);
    const result = await checkCargoDependencyAge({
        ...f,
        args,
        now,
        fetchVersions: async () => [oldVersion],
    });
    assert.equal(result.projectCount, 1);
    assert.equal(result.packageCount, 2);
});

test("all maintained locks contain their owning Cargo package", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    for (const project of Object.values(DESKTOP_CARGO_PROJECTS)) {
        const manifest = await readFile(
            path.join(root, project.manifestPath),
            "utf8",
        );
        const name = manifest.match(/^name = "([^"]+)"/m)?.[1];
        const packages = await readCargoLockPackages(
            path.join(root, project.lockfilePath),
        );
        assert.ok(
            packages.some((pkg) => pkg.name === name),
            `${project.lockfilePath} must contain ${name}`,
        );
    }
});

function indexEntry(name, overrides = {}) {
    return {
        name,
        vers: oldVersion.number,
        pubtime: oldVersion.createdAt.toISOString(),
        cksum: checksum,
        yanked: false,
        ...overrides,
    };
}

function indexResponse(entries) {
    return new Response(
        entries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
}

function apiEntry(overrides = {}) {
    return {
        num: oldVersion.number,
        created_at: oldVersion.createdAt.toISOString(),
        checksum,
        yanked: false,
        ...overrides,
    };
}

test("sparse-index URLs follow Cargo's short-name and lowercase layout", () => {
    for (const [name, suffix] of [
        ["a", "1/a"],
        ["cc", "2/cc"],
        ["syn", "3/s/syn"],
        ["tokio", "to/ki/tokio"],
        ["Inflector", "in/fl/inflector"],
    ]) {
        assert.equal(
            new URL(cratesIoSparseIndexUrl(name)).pathname,
            `/${suffix}`,
        );
    }
    assert.throws(() => cratesIoSparseIndexUrl("../crate"), /Invalid/);
});

test("sparse reads stream split JSON and ignore unrelated versions without publication dates", async () => {
    const bytes = new TextEncoder().encode(
        [
            JSON.stringify(indexEntry("demo", { extra: "é" })),
            JSON.stringify(
                indexEntry("demo", { vers: "2.0.0", pubtime: undefined }),
            ),
        ].join("\r\n"),
    );
    const split = bytes.indexOf(0xc3) + 1;
    const requests = [];
    const read = createCratesIoMetadataReader({
        fetchImplementation: async (url) => {
            requests.push(url);
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(bytes.slice(0, split));
                        controller.enqueue(bytes.slice(split));
                        controller.close();
                    },
                }),
            );
        },
        delay: async () =>
            assert.fail("sparse reads must not use the API delay"),
    });
    assert.deepEqual(await read("demo", { requiredVersions: ["1.0.0"] }), [
        oldVersion,
    ]);
    assert.deepEqual(requests, [cratesIoSparseIndexUrl("demo")]);
});

test("missing selected publication dates or versions use the API fallback", async () => {
    for (const entries of [
        [indexEntry("demo", { pubtime: undefined })],
        [indexEntry("demo", { vers: "2.0.0" })],
    ]) {
        const requests = [];
        const read = createCratesIoMetadataReader({
            fetchImplementation: async (url) => {
                requests.push(url);
                return url.startsWith(CRATES_IO_API_BASE_URL)
                    ? Response.json({ versions: [apiEntry()] })
                    : indexResponse(entries);
            },
            delay: async () => {},
        });
        assert.deepEqual(await read("demo", { requiredVersions: ["1.0.0"] }), [
            oldVersion,
        ]);
        assert.deepEqual(requests, [
            cratesIoSparseIndexUrl("demo"),
            `${CRATES_IO_API_BASE_URL}/demo/versions`,
        ]);
    }
});

test("aged updates can read full version history, including yanked metadata", async () => {
    const read = createCratesIoMetadataReader({
        fetchImplementation: async (url) =>
            url.startsWith(CRATES_IO_API_BASE_URL)
                ? Response.json({
                      versions: [
                          apiEntry(),
                          apiEntry({ num: "2.0.0", yanked: true }),
                      ],
                  })
                : indexResponse([
                      indexEntry("demo"),
                      indexEntry("demo", { vers: "2.0.0", pubtime: undefined }),
                  ]),
        delay: async () => {},
    });
    assert.deepEqual(await read("demo"), [
        oldVersion,
        { ...oldVersion, number: "2.0.0", yanked: true },
    ]);
});

test("concurrent API fallbacks share one paced queue, including failures", async () => {
    let clock = 0;
    const requests = [];
    let active = 0;
    let peak = 0;
    const read = createCratesIoMetadataReader({
        delay: async (milliseconds) => {
            clock += milliseconds;
        },
        fetchImplementation: async (url) => {
            if (!url.startsWith(CRATES_IO_API_BASE_URL)) {
                return indexResponse([
                    indexEntry(url.split("/").at(-1), { pubtime: undefined }),
                ]);
            }
            requests.push(clock);
            active += 1;
            peak = Math.max(peak, active);
            await Promise.resolve();
            clock += 100;
            active -= 1;
            return url.includes("/two/")
                ? new Response(null, { status: 429 })
                : Response.json({ versions: [apiEntry()] });
        },
    });
    const results = await Promise.allSettled(
        ["one", "two", "three"].map((name) => read(name)),
    );
    assert.deepEqual(requests, [0, 1100, 2200]);
    assert.equal(peak, 1);
    assert.deepEqual(
        results.map(({ status }) => status),
        ["fulfilled", "rejected", "fulfilled"],
    );
    assert.match(results[1].reason.message, /429/);
});

test("malformed sparse metadata fails without silently falling back", async () => {
    const valid = indexEntry("demo");
    for (const body of [
        "",
        "not-json",
        JSON.stringify({ ...valid, name: "another" }),
        JSON.stringify({ ...valid, pubtime: "invalid-date" }),
        JSON.stringify({ ...valid, pubtime: "2026-02-31T00:00:00Z" }),
        JSON.stringify({ ...valid, cksum: "invalid-checksum" }),
        `${JSON.stringify(valid)}\n${JSON.stringify(valid)}`,
    ]) {
        let requests = 0;
        const read = createCratesIoMetadataReader({
            fetchImplementation: async () => {
                requests += 1;
                return new Response(body);
            },
            delay: async () => {},
        });
        await assert.rejects(read("demo"));
        assert.equal(requests, 1);
    }
});

test("HTTP, streaming and malformed fallback failures remain fatal", async () => {
    const failure = new Error("response stream failed");
    const readBrokenStream = createCratesIoMetadataReader({
        fetchImplementation: async () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.error(failure);
                    },
                }),
            ),
    });
    await assert.rejects(
        readBrokenStream("demo"),
        (error) => error === failure,
    );
    const readHttpFailure = createCratesIoMetadataReader({
        fetchImplementation: async () => new Response(null, { status: 503 }),
    });
    await assert.rejects(readHttpFailure("demo"), /503/);
    for (const versions of [
        [],
        [apiEntry({ created_at: null })],
        [apiEntry({ checksum: "invalid" })],
    ]) {
        const read = createCratesIoMetadataReader({
            fetchImplementation: async (url) =>
                url.startsWith(CRATES_IO_API_BASE_URL)
                    ? Response.json({ versions })
                    : indexResponse([
                          indexEntry("demo", { pubtime: undefined }),
                      ]),
            delay: async () => {},
        });
        await assert.rejects(read("demo"));
    }
});

test("parallel admission stays bounded, shares metadata and emits progress before all reads finish", async () => {
    const f = await fixture();
    const extra = Array.from(
        { length: DEFAULT_CRATES_IO_METADATA_CONCURRENCY + 2 },
        (_, i) =>
            `\n[[package]]\nname = "extra${i}"\nversion = "1.0.0"\nsource = "${CRATES_IO_REGISTRY_SOURCE}"\nchecksum = "${checksum}"\n`,
    ).join("");
    await appendFile(
        path.join(f.projectRoot, DESKTOP_CARGO_PROJECTS.Desktop.lockfilePath),
        extra,
    );
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const firstProgress = Promise.withResolvers();
    let active = 0;
    let peak = 0;
    let requests = 0;
    const progress = [];
    const run = checkCargoDependencyAge({
        ...f,
        now,
        fetchVersions: async () => {
            active += 1;
            requests += 1;
            peak = Math.max(peak, active);
            if (active === DEFAULT_CRATES_IO_METADATA_CONCURRENCY)
                started.resolve();
            if (requests === 1) {
                active -= 1;
                return [oldVersion];
            }
            await release.promise;
            active -= 1;
            return [oldVersion];
        },
        onProgress: (entry) => {
            progress.push(entry);
            firstProgress.resolve();
        },
    });
    await started.promise;
    await firstProgress.promise;
    assert.ok(progress.length > 0 && progress.length < progress[0].total);
    release.resolve();
    const result = await run;
    assert.equal(peak, DEFAULT_CRATES_IO_METADATA_CONCURRENCY);
    assert.equal(progress.length, result.packageCount);
    assert.deepEqual(result.violations, []);
});

test("a failed worker stops new work and waits for in-flight work before rejecting", async () => {
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    const started = Promise.withResolvers();
    const requested = [];
    const failure = new Error("first worker failed");
    const run = mapWithConcurrency([0, 1, 2, 3], 2, async (item) => {
        requested.push(item);
        if (item === 1) started.resolve();
        if (item === 0) {
            await first.promise;
            throw failure;
        }
        await second.promise;
        return item;
    });
    await started.promise;
    first.resolve();
    await Promise.resolve();
    second.resolve();
    await assert.rejects(run, (error) => error === failure);
    assert.deepEqual(requested, [0, 1]);
});

test("registry checksums cannot be bypassed by age or fresh-version exceptions", async () => {
    const result = await checkCargoDependencyAge({
        ...(await fixture({
            freshVersionExceptions: [
                {
                    name: "secretprompt",
                    version: "1.0.0",
                    reason: "Reviewed fix",
                },
            ],
        })),
        now,
        fetchVersions: async (name) => [
            {
                ...(name === "secretprompt" ? newVersion : oldVersion),
                checksum: "b".repeat(64),
            },
        ],
    });
    assert.equal(result.violations.length, 4);
    assert.ok(
        result.violations.every((message) => message.includes("checksum")),
    );
    assert.deepEqual(result.allowlisted, []);
});

test("conflicting checksums across maintained lockfiles fail before network access", async () => {
    const f = await fixture();
    const promptLock = path.join(
        f.projectRoot,
        DESKTOP_CARGO_PROJECTS.SecretPrompt.lockfilePath,
    );
    await writeFile(
        promptLock,
        (await readFile(promptLock, "utf8")).replace(checksum, "b".repeat(64)),
    );
    await assert.rejects(
        checkCargoDependencyAge({
            ...f,
            now,
            fetchVersions: async () =>
                assert.fail(
                    "conflicting locks must fail before fetching metadata",
                ),
        }),
        /Conflicting Cargo.lock checksums for common@1.0.0/,
    );
});
