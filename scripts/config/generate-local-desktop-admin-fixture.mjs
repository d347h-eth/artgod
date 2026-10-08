#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { format, resolveConfig } from "prettier";
import {
    parseManifest,
    resolveDefaultForTarget,
    buildDesktopAdminConfigSchema,
} from "./generate-env-example.mjs";

const manifest = parseManifest(
    await readFile(
        new URL("../../config/settings.manifest.toml", import.meta.url),
        "utf8",
    ),
);
const selection = JSON.parse(
    await readFile(
        new URL(
            "../../config/desktop-local-observability.json",
            import.meta.url,
        ),
    ),
);
const settings = selection.settings.map((key) => {
    const setting = manifest.settings.find((entry) => entry.key === key);
    if (
        !setting ||
        setting.desktop_managed === false ||
        !setting.targets?.includes("local") ||
        setting.targets.includes("desktop")
    ) {
        throw new Error(`Invalid local desktop fixture setting: ${key}`);
    }
    return {
        ...setting,
        targets: ["desktop"],
        defaults: { desktop: resolveDefaultForTarget(setting, "local") },
    };
});
const output = new URL(
    "../../frontend/src/lib/e2e/generated-local-desktop-observability.ts",
    import.meta.url,
);
const schema = buildDesktopAdminConfigSchema({ ...manifest, settings });
const source = await format(
    `// Generated from the canonical manifest and local desktop selection.\n// Run yarn config:generate:desktop-local; do not edit.\n// Keep the object as JSON so the native schema parity test can read it.\n// prettier-ignore\nexport const LOCAL_DESKTOP_OBSERVABILITY_SCHEMA = ${JSON.stringify(schema, null, 2)} as const;\n`,
    {
        ...(await resolveConfig(output.pathname)),
        parser: "typescript",
    },
);
if (process.argv.includes("--check")) {
    if ((await readFile(output, "utf8")) !== source)
        throw new Error(
            "Local desktop Admin fixture is stale. Run yarn config:generate:desktop-local.",
        );
    console.log("Local desktop Admin fixture is up to date.");
} else {
    await writeFile(output, source);
}
