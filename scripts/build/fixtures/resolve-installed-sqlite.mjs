import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDesktopRuntimePackageSource } from "../desktop-runtime-dependency-staging.mjs";
import { NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES } from "../native-runtime-dependencies.mjs";

// Probe the same installed-package boundary as the native compiler without
// modifying its binding or metadata. No replacement PnP API is supplied.
const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRoot = await resolveDesktopRuntimePackageSource({
    packageName: NATIVE_RUNTIME_DEPENDENCY_PACKAGE_NAMES.BetterSqlite3,
    issuerPath: path.join(rootDir, "package.json"),
});
const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, "package.json"), "utf8"),
);
console.log(
    JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        pnp: !!process.versions.pnp,
    }),
);
