#!/usr/bin/env node
import { projectRoot } from "./local-desktop-contract.mjs";
import { projectYarnCommand } from "./project-yarn-command.mjs";
import { runRedactedCommand } from "./secret-output-redaction.mjs";

// This hook belongs exclusively to the opt-in local desktop target.
for (const args of [
    ["build:sqlite-native", "--if-needed"],
    ["build:admin"],
    ["build:userland"],
    ["node", "scripts/build/build-local-desktop-runtime.mjs"],
    ["node", "scripts/build/prepare-local-desktop-resources.mjs"],
    [
        "node",
        "scripts/build/prepare-local-desktop-sidecars.mjs",
        "--profile",
        "release",
    ],
]) {
    const invocation = projectYarnCommand(args);
    await runRedactedCommand(invocation.command, invocation.args, {
        cwd: projectRoot,
        stream: true,
    });
}
