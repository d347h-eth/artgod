import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES,
    preparePinnedTauriLinuxBundlerTools,
    validatePinnedToolsManifest,
} from "./prepare-tauri-linux-bundler-tools.mjs";

const testCliVersion = "2.11.3-test";

function createTestManifest() {
    return {
        schemaVersion: 1,
        tauriCliVersion: testCliVersion,
        tauriBundlerVersion: "test",
        target: "x86_64-unknown-linux-gnu",
        tools: TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES.map((fileName, index) => {
            const content = Buffer.from(`pinned-tool-${index}-${fileName}`);
            return {
                fileName,
                sourceRevision: String(index + 1).padStart(40, "a"),
                url: `https://example.invalid/${fileName}`,
                sizeBytes: content.length,
                sha256: sha256(content),
                content,
            };
        }),
    };
}

function serializableManifest(manifest) {
    return {
        ...manifest,
        tools: manifest.tools.map(({ content: _content, ...tool }) => tool),
    };
}

test("requires the complete Tauri Linux bundler tool set", () => {
    const manifest = serializableManifest(createTestManifest());
    manifest.tools.pop();

    assert.throws(
        () => validatePinnedToolsManifest(manifest, testCliVersion),
        /tool set mismatch/,
    );
});

test("downloads, verifies, and reuses only pinned executable bytes", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-tauri-tools-test-"),
    );
    const cacheDirectory = path.join(temporaryRoot, "cache");
    const manifestPath = path.join(temporaryRoot, "manifest.json");
    const manifest = createTestManifest();
    const contentByUrl = new Map(
        manifest.tools.map((tool) => [tool.url, tool.content]),
    );
    let fetchCount = 0;
    const fetchImplementation = async (url) => {
        fetchCount += 1;
        const content = contentByUrl.get(url);
        return new Response(content, { status: content ? 200 : 404 });
    };

    try {
        await writeFile(
            manifestPath,
            `${JSON.stringify(serializableManifest(manifest), null, 4)}\n`,
        );
        await preparePinnedTauriLinuxBundlerTools({
            manifestPath,
            cacheDirectory,
            expectedTauriCliVersion: testCliVersion,
            fetchImplementation,
            logger: () => {},
        });

        assert.equal(fetchCount, manifest.tools.length);
        for (const tool of manifest.tools) {
            const filePath = path.join(cacheDirectory, tool.fileName);
            assert.deepEqual(await readFile(filePath), tool.content);
            assert.equal((await stat(filePath)).mode & 0o777, 0o755);
        }

        await preparePinnedTauriLinuxBundlerTools({
            manifestPath,
            cacheDirectory,
            expectedTauriCliVersion: testCliVersion,
            fetchImplementation,
            logger: () => {},
        });
        assert.equal(fetchCount, manifest.tools.length);

        const replacedTool = manifest.tools[0];
        await writeFile(
            path.join(cacheDirectory, replacedTool.fileName),
            "mutated-by-bundler",
        );
        await preparePinnedTauriLinuxBundlerTools({
            manifestPath,
            cacheDirectory,
            expectedTauriCliVersion: testCliVersion,
            fetchImplementation,
            logger: () => {},
        });
        assert.equal(fetchCount, manifest.tools.length + 1);
        assert.deepEqual(
            await readFile(path.join(cacheDirectory, replacedTool.fileName)),
            replacedTool.content,
        );
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("rejects downloaded bytes before they reach Tauri's executable cache", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-tauri-tools-mismatch-test-"),
    );
    const cacheDirectory = path.join(temporaryRoot, "cache");
    const manifestPath = path.join(temporaryRoot, "manifest.json");
    const manifest = createTestManifest();

    try {
        await writeFile(
            manifestPath,
            `${JSON.stringify(serializableManifest(manifest), null, 4)}\n`,
        );
        await assert.rejects(
            preparePinnedTauriLinuxBundlerTools({
                manifestPath,
                cacheDirectory,
                expectedTauriCliVersion: testCliVersion,
                fetchImplementation: async () =>
                    new Response("untrusted-moving-tool", { status: 200 }),
                logger: () => {},
            }),
            /size mismatch|SHA-256 mismatch/,
        );
        await assert.rejects(
            stat(
                path.join(
                    cacheDirectory,
                    TAURI_LINUX_BUNDLER_TOOL_FILE_NAMES[0],
                ),
            ),
            { code: "ENOENT" },
        );
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}
