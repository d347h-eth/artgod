import assert from "node:assert/strict";
import test from "node:test";
import { buildLockedTauri } from "./build-tauri.mjs";

test("caller debug and target flags stay before Cargo lock enforcement", async () => {
    const environment = { XDG_CACHE_HOME: "/build/cache" };
    await buildLockedTauri(
        [
            "--no-bundle",
            "--ci",
            "--debug",
            "--target",
            "x86_64-unknown-linux-gnu",
        ],
        {
            environment,
            async runCommand(command, args, options) {
                assert.equal(command, "yarn");
                assert.deepEqual(args, [
                    "tauri",
                    "build",
                    "--no-bundle",
                    "--ci",
                    "--debug",
                    "--target",
                    "x86_64-unknown-linux-gnu",
                    "--",
                    "--locked",
                ]);
                assert.equal(options.env, environment);
            },
        },
    );
});

test("caller Cargo flags are retained and an explicit lock flag is not duplicated", async () => {
    for (const cargoArgs of [
        ["--features", "fixture"],
        ["--locked", "--features", "fixture"],
    ]) {
        await buildLockedTauri(["--no-bundle", "--", ...cargoArgs], {
            async runCommand(_command, args) {
                assert.equal(args.filter((arg) => arg === "--").length, 1);
                assert.equal(
                    args.filter((arg) => arg === "--locked").length,
                    1,
                );
                assert.deepEqual(args.slice(0, 4), [
                    "tauri",
                    "build",
                    "--no-bundle",
                    "--",
                ]);
                assert.ok(args.indexOf("--features") > args.indexOf("--"));
            },
        });
    }
});
