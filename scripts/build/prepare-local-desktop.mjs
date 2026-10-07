#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./local-desktop-contract.mjs";
import { projectYarnCommand } from "./project-yarn-command.mjs";
import { runRedactedCommand } from "./secret-output-redaction.mjs";

// Both local commands prepare the same instrumented closure before Cargo starts.
export async function prepareLocalDesktop({
    development = false,
    environment = process.env,
    runCommand = runRedactedCommand,
} = {}) {
    for (const args of [
        ["build:sqlite-native", "--if-needed"],
        ...(!development ? [["build:admin"]] : []),
        ["build:userland"],
        ["node", "scripts/build/build-local-desktop-runtime.mjs"],
        ["node", "scripts/build/prepare-local-desktop-resources.mjs"],
        [
            "node",
            "scripts/build/prepare-local-desktop-sidecars.mjs",
            "--profile",
            development ? "debug" : "release",
        ],
    ]) {
        const invocation = projectYarnCommand(args);
        await runCommand(invocation.command, invocation.args, {
            cwd: projectRoot,
            env: environment,
            stream: true,
        });
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
    await prepareLocalDesktop();
