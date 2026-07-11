import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const capabilitiesDirectory = path.join(rootDir, "src-tauri", "capabilities");
const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");

// Tauri owns this namespace for WebView-facing shell plugin permissions.
const TAURI_SHELL_PERMISSION_PREFIX = "shell:";
const TAURI_CAPABILITY_EXTENSIONS = new Set([".json", ".toml"]);

test("keeps shell process APIs denied to every WebView capability", async () => {
    const capabilityFileNames = (
        await findCapabilityFiles(capabilitiesDirectory)
    ).sort();
    assert.ok(
        capabilityFileNames.length > 0,
        "No Tauri WebView capability files were found.",
    );

    for (const fileName of capabilityFileNames) {
        assert.equal(
            path.extname(fileName),
            ".json",
            `${fileName} is not covered by the JSON capability security parser.`,
        );
        const capability = JSON.parse(
            await readFile(path.join(capabilitiesDirectory, fileName), "utf8"),
        );
        assertNoWebViewShellPermissions(
            capability,
            path.join("src-tauri", "capabilities", fileName),
        );
    }

    const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
    const inlineCapabilities = tauriConfig.app?.security?.capabilities ?? [];
    for (const [index, capability] of inlineCapabilities.entries()) {
        if (typeof capability === "object" && capability !== null) {
            assertNoWebViewShellPermissions(
                capability,
                `src-tauri/tauri.conf.json inline capability ${index}`,
            );
        }
    }
});

function assertNoWebViewShellPermissions(capability, source) {
    assert.ok(
        Array.isArray(capability.permissions),
        `${source} has no permissions array.`,
    );

    for (const permission of capability.permissions) {
        const identifier =
            typeof permission === "string" ? permission : permission.identifier;
        assert.equal(
            typeof identifier,
            "string",
            `${source} contains a permission without an identifier.`,
        );
        assert.ok(
            !identifier.startsWith(TAURI_SHELL_PERMISSION_PREFIX),
            `${source} exposes ${identifier} to a WebView; secret-prompt process access must remain Rust-only.`,
        );
    }
}

async function findCapabilityFiles(directory, relativeDirectory = "") {
    const capabilityFileNames = [];
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const relativePath = path.join(relativeDirectory, entry.name);
        assert.ok(
            entry.isDirectory() || entry.isFile(),
            `${relativePath} must not be a symbolic or special filesystem entry.`,
        );
        if (entry.isDirectory()) {
            capabilityFileNames.push(
                ...(await findCapabilityFiles(
                    path.join(directory, entry.name),
                    relativePath,
                )),
            );
            continue;
        }

        if (TAURI_CAPABILITY_EXTENSIONS.has(path.extname(entry.name))) {
            assert.ok(
                entry.isFile(),
                `${relativePath} must be a regular capability file.`,
            );
            capabilityFileNames.push(relativePath);
        }
    }

    return capabilityFileNames;
}
