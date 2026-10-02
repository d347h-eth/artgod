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

test("Windows uses the pinned Tauri JavaScript entry point without a command shell", async () => {
    const cliScriptPath = "C:\\Program Files\\ArtGod\\tauri.js";
    await buildLockedTauri(["--no-bundle", "--debug"], {
        platform: "win32",
        resolveCliEntrypoint: () => cliScriptPath,
        async runCommand(command, args, options) {
            assert.equal(command, process.execPath);
            assert.deepEqual(args, [
                cliScriptPath,
                "build",
                "--no-bundle",
                "--debug",
                "--",
                "--locked",
            ]);
            assert.equal(options.shell, undefined);
        },
    });
});

test("Windows stops before launch when its installed CLI cannot resolve", async () => {
    await assert.rejects(
        buildLockedTauri(["--no-bundle"], {
            platform: "win32",
            resolveCliEntrypoint() {
                throw new Error("Missing project CLI install");
            },
            runCommand() {
                assert.fail("A missing CLI context must fail before launch.");
            },
        }),
        /Missing project CLI install/,
    );
});
