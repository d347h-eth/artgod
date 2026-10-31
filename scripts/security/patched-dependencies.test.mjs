import assert from "node:assert/strict";
import { once } from "node:events";
import { readdir } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRequire = createRequire(
    new URL("../../frontend/package.json", import.meta.url),
);
const pluginRequire = createRequire(
    frontendRequire.resolve("@sveltejs/vite-plugin-svelte"),
);
for (const entryPoint of ["deepmerge", "deepmerge/dist/umd.js"]) {
    const merge = pluginRequire(entryPoint);

    // The upstream release has no fix for CVE-2026-93753. Exercise the actual
    // patched build dependency so a missing/stale Yarn patch fails security CI.
    test(`${entryPoint} never gives merged configuration an attacker-controlled prototype`, () => {
        const attack = JSON.parse('{"session":{"__proto__":{"admin":true}}}');
        for (const target of [
            {},
            { session: null },
            { session: undefined },
            Object.create(null),
        ]) {
            const result = merge(target, attack);
            assert.equal(result.session.admin, undefined);
            assert.equal(
                Object.getPrototypeOf(result.session),
                Object.prototype,
            );
            assert.equal(Object.hasOwn(result.session, "__proto__"), false);
        }
        const hostileTarget = JSON.parse(
            '{"__proto__":{"admin":true},"enabled":true}',
        );
        const result = merge(hostileTarget, { name: "safe" });
        assert.equal(result.admin, undefined);
        assert.equal(Object.getPrototypeOf(result), Object.prototype);
        assert.deepEqual(result, { enabled: true, name: "safe" });
        assert.equal({}.admin, undefined);
    });

    test(`${entryPoint} preserves nested config, array and symbol merging`, () => {
        const symbol = Symbol("config");
        assert.deepEqual(
            merge(
                { nested: { a: 1 }, list: [1], [symbol]: { a: 1 } },
                { nested: { b: 2 }, list: [2], [symbol]: { b: 2 } },
            ),
            { nested: { a: 1, b: 2 }, list: [1, 2], [symbol]: { a: 1, b: 2 } },
        );
    });
}

// These security resolutions cross major versions. Exercise the actual
// transitive consumers so an API or matching change cannot silently break them.
const indexerRequire = createRequire(
    new URL("../../indexer/package.json", import.meta.url),
);
const testcontainersRequire = createRequire(
    indexerRequire.resolve("testcontainers"),
);
const archiverRequire = createRequire(
    testcontainersRequire.resolve("archiver"),
);
const archiverUtilsRequire = createRequire(
    archiverRequire.resolve("archiver-utils"),
);
const globRequire = createRequire(archiverUtilsRequire.resolve("glob"));
const readdirGlobRequire = createRequire(
    archiverRequire.resolve("readdir-glob"),
);
const eslintRequire = createRequire(frontendRequire.resolve("eslint"));

const sourcePattern = "src/**/*.js";
const ignoredPatterns = ["src/**/*.test.js", "src/ignored/**"];
const expectedSourceFiles = ["src/main.js", "src/nested/tool.js"];

async function createGlobFixture() {
    const tmpRoot = fileURLToPath(new URL("../../tmp/", import.meta.url));
    await mkdir(tmpRoot, { recursive: true });
    const root = await mkdtemp(path.join(tmpRoot, "security-glob-"));
    for (const [name, content] of Object.entries({
        "src/main.js": "export const value = 1;",
        "src/nested/tool.js": "export const tool = 2;",
        "src/main.test.js": "const unused = true;",
        "src/ignored/private.js": "const unused = true;",
        "README.md": "fixture",
    })) {
        const file = path.join(root, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
    }
    return root;
}

test("Archiver preserves synchronous glob expansion and exclusions", async () => {
    const root = await createGlobFixture();
    const { file } = archiverRequire("archiver-utils");
    const matches = file.expand({ cwd: root }, [
        sourcePattern,
        ...ignoredPatterns.map((pattern) => `!${pattern}`),
    ]);
    assert.deepEqual(matches.sort(), expectedSourceFiles);
});

test("Testcontainers' Archiver preserves streamed archive file selection", async () => {
    const root = await createGlobFixture();
    const archive = testcontainersRequire("archiver")("tar");
    const entries = [];
    let bytes = 0;
    archive.on("entry", ({ name }) => entries.push(name));
    archive.on("data", (chunk) => (bytes += chunk.length));
    const ended = once(archive, "end");
    archive.glob(sourcePattern, { cwd: root, ignore: ignoredPatterns });
    await Promise.all([archive.finalize(), ended]);
    assert.deepEqual(entries.sort(), expectedSourceFiles);
    assert.ok(bytes > 0);
});

test("ESLint preserves recursive file selection and ignored paths", async () => {
    const root = await createGlobFixture();
    const { ESLint } = frontendRequire("eslint");
    const eslint = new ESLint({
        cwd: root,
        overrideConfigFile: true,
        overrideConfig: [
            { ignores: ignoredPatterns },
            {
                files: ["src/**/*.{js,ts}"],
                rules: { "no-unused-vars": "error" },
            },
        ],
    });
    const results = await eslint.lintFiles([sourcePattern]);
    assert.deepEqual(
        results
            .map(({ filePath }) =>
                path.relative(root, filePath).replaceAll(path.sep, "/"),
            )
            .sort(),
        expectedSourceFiles,
    );
    assert.ok(
        results.every(
            ({ errorCount, warningCount }) => !errorCount && !warningCount,
        ),
    );
});

test("glob stops reading directories when an active walk is aborted", async () => {
    const root = await createGlobFixture();
    const { glob } = archiverUtilsRequire("glob");
    const controller = new AbortController();
    const reason = new Error("cancel fixture traversal");
    let reads = 0;
    await assert.rejects(
        glob("**/*", {
            cwd: root,
            signal: controller.signal,
            fs: {
                readdir(directory, options, callback) {
                    reads++;
                    // Count unwanted background work without allowing a broken
                    // version to continue traversing the rest of the fixture.
                    if (reads > 1) {
                        queueMicrotask(() => callback(null, []));
                        return;
                    }
                    readdir(directory, options, (error, entries) => {
                        controller.abort(reason);
                        callback(error, entries);
                    });
                },
            },
        }),
        (error) => error === reason,
    );
    assert.equal(reads, 1);
});

for (const [consumer, consumerRequire] of [
    ["ESLint", eslintRequire],
    ["glob", globRequire],
    ["readdir-glob", readdirGlobRequire],
]) {
    test(`${consumer}'s minimatch bounds globstar-parent pattern expansion`, () => {
        const { Minimatch } = consumerRequire("minimatch");
        const expansionLimit = 2;
        const matcher = new Minimatch(
            "a/**/../b/**/../c/**/../d/**/../file.js",
            { optimizationLevel: 2, braceExpandMax: expansionLimit },
        );
        assert.ok(matcher.set.length > 0);
        assert.ok(matcher.set.length <= expansionLimit);
    });
}
