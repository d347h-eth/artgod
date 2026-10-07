#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { devLocalDesktop } from "./local-desktop-command.mjs";
import { runLockedTauri } from "./build-tauri.mjs";

if (process.platform !== "linux")
    throw new Error(
        "This build-only desktop development check requires Linux.",
    );

// Use normal local preparation and the managed Admin server. Replacing Cargo
// run with Cargo build keeps this check away from live application data.
await devLocalDesktop([], {
    runTauri(operation, args, options) {
        return runLockedTauri(
            operation,
            [
                ...args,
                "--runner",
                fileURLToPath(
                    new URL("./fixtures/cargo-build-only.sh", import.meta.url),
                ),
            ],
            options,
        );
    },
});
