#!/usr/bin/env node
import { runLocalBuildCommand, yarnCommand } from "./local-desktop-command.mjs";

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
    await runLocalBuildCommand(yarnCommand, args);
}
