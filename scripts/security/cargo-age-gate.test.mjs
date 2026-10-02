import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DESKTOP_CARGO_PROJECTS } from "../build/cargo-projects.mjs";
import { checkCargoDependencyAge } from "./cargo-age-gate.mjs";
import {
    CRATES_IO_REGISTRY_SOURCE,
    DEFAULT_CARGO_AGE_GATE_CONFIG_RELATIVE_PATH,
    fetchCrateVersions,
    parseCommonArgs,
    readCargoLockPackages,
} from "./cargo-age-gate-utils.mjs";

const temporaryRoot = fileURLToPath(new URL("../../tmp/", import.meta.url));
const now = new Date("2026-10-03T00:00:00Z");
const oldVersion = {
    number: "1.0.0",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    yanked: false,
};
const newVersion = { ...oldVersion, createdAt: now };

async function fixture({ missingProject } = {}) {
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
        JSON.stringify({ minimumAgeDays: 30, freshVersionExceptions: [] }),
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
[[package]]
name = "${name.toLowerCase()}"
version = "1.0.0"
source = "${CRATES_IO_REGISTRY_SOURCE}"
`,
        );
    }
    return { projectRoot };
}

test("default age admission covers all roots and deduplicates shared dependencies", async () => {
    const f = await fixture();
    const requested = [];
    const result = await checkCargoDependencyAge({
        ...f,
        now,
        fetchVersions: async (name) => {
            requested.push(name);
            return [oldVersion];
        },
    });
    assert.equal(
        result.projectCount,
        Object.keys(DESKTOP_CARGO_PROJECTS).length,
    );
    assert.equal(result.packageCount, 4);
    assert.equal(requested.filter((name) => name === "common").length, 1);
    assert.deepEqual(result.violations, []);
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

test("registry version reads observe its one-request-per-second policy, including failures", async () => {
    let clock = 0;
    const requests = [];
    const options = {
        delay: async (milliseconds) => {
            clock += milliseconds;
        },
        fetchImplementation: async () => {
            requests.push(clock);
            clock += 100;
            return Response.json({
                versions: [
                    {
                        num: "1.0.0",
                        created_at: oldVersion.createdAt.toISOString(),
                        yanked: false,
                    },
                ],
            });
        },
    };
    await fetchCrateVersions("one", options);
    await fetchCrateVersions("two", options);
    await assert.rejects(
        fetchCrateVersions("three", {
            ...options,
            fetchImplementation: async () =>
                new Response(null, { status: 429 }),
        }),
        /429/,
    );
    await fetchCrateVersions("four", options);
    assert.deepEqual(requests, [0, 1100, 3200]);
});
