import { spawn } from "node:child_process";
import path from "node:path";
import {
    PYROSCOPE_PACKAGE,
    PPROF_PACKAGE,
    assertLocalRuntimeProfiles,
} from "./local-desktop-dependencies.mjs";

const smoke = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(process.argv[1]);
const pprof = require(${JSON.stringify(PPROF_PACKAGE)});
assert.equal(typeof pprof.time.start, "function");
assert.equal(typeof pprof.time.stop, "function");
const module = await import(pathToFileURL(require.resolve(${JSON.stringify(PYROSCOPE_PACKAGE)})).href);
const pyro = module.default ?? module;
for (const method of ["init", "start", "stop"]) assert.equal(typeof pyro[method], "function");
console.log("Local desktop profiler imports passed:", process.argv[1]);
`;

// Importability only: never initialize a profiler or send telemetry during packaging.
export async function verifyLocalDesktopObservabilityDependencies({
    resourcesRootDir,
    nodeBinaryPath,
    environment = process.env,
}) {
    await assertLocalRuntimeProfiles(resourcesRootDir);
    const env = { ...environment };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    for (const [runtime, artifact] of [
        ["backend", "server.mjs"],
        ["indexer", "bootstrap-worker.mjs"],
    ]) {
        const issuer = path.join(
            resourcesRootDir,
            runtime,
            "dist-desktop",
            artifact,
        );
        await new Promise((resolve, reject) => {
            const child = spawn(
                nodeBinaryPath,
                ["--input-type=module", "--eval", smoke, issuer],
                {
                    cwd: resourcesRootDir,
                    env,
                    stdio: "inherit",
                },
            );
            child.once("error", reject);
            child.once("exit", (code, signal) =>
                code === 0
                    ? resolve()
                    : reject(
                          new Error(
                              `${runtime} local profiler smoke failed (${code ?? signal}).`,
                          ),
                      ),
            );
        });
    }
}
