import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const promptSourceDirectory = path.join(
    rootDir,
    "src-tauri",
    "sidecars",
    "artgod-secret-prompt",
    "src",
);

// These retired production inputs must remain recognizable only to this regression.
const RETIRED_PROMPT_RESPONSE_ENV_KEYS = [
    "ARTGOD_SECRET_PROMPT_TEST_MODE",
    "ARTGOD_SECRET_PROMPT_TEST_RESPONSE",
];
const ENV_RESPONSE_READ_PATTERN = /\benv::(?:var|var_os|vars|vars_os)\s*\(/;

test("keeps environment-submitted responses out of the production prompt helper", async () => {
    const sources = await readRustSources(promptSourceDirectory);

    for (const source of sources) {
        for (const retiredKey of RETIRED_PROMPT_RESPONSE_ENV_KEYS) {
            assert.ok(
                !source.contents.includes(retiredKey),
                `${source.relativePath} reintroduced retired prompt input ${retiredKey}.`,
            );
        }
        assert.doesNotMatch(
            source.contents,
            ENV_RESPONSE_READ_PATTERN,
            `${source.relativePath} reads production helper responses from the environment.`,
        );
    }
});

async function readRustSources(directory, relativeDirectory = "") {
    const sources = [];
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const relativePath = path.join(relativeDirectory, entry.name);
        assert.ok(
            entry.isDirectory() || entry.isFile(),
            `${relativePath} must not be a symbolic or special filesystem entry.`,
        );
        if (entry.isDirectory()) {
            sources.push(
                ...(await readRustSources(
                    path.join(directory, entry.name),
                    relativePath,
                )),
            );
            continue;
        }
        if (path.extname(entry.name) !== ".rs") {
            continue;
        }
        sources.push({
            relativePath,
            contents: await readFile(path.join(directory, entry.name), "utf8"),
        });
    }

    return sources;
}
