import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    buildLockedTauri,
    runLockedTauri,
    TAURI_OPERATION,
} from "./build-tauri.mjs";
import { projectYarnCommand } from "./project-yarn-command.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

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
            platform: "linux",
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
            platform: "linux",
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

test("Yarn Node resolves and launches the real pinned CLI through Windows dispatch", () => {
    const probe = "./scripts/build/fixtures/launch-installed-tauri.mjs";
    const { command, args } = projectYarnCommand(["node", probe]);
    const environment = {
        ...process.env,
        YARN_ENABLE_NETWORK: "0",
        COREPACK_ENABLE_NETWORK: "0",
    };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    const result = spawnSync(command, args, {
        cwd: rootDir,
        env: environment,
        encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:.*build/);
    assert.match(result.stdout, /--bundles/);
    const plain = spawnSync(process.execPath, [probe], {
        cwd: rootDir,
        env: environment,
        encoding: "utf8",
    });
    assert.notEqual(plain.status, 0);
    assert.match(
        plain.stderr,
        /Cannot find module '@tauri-apps\/cli\/tauri.js'/,
    );
});

test("development lock enforcement stays before application arguments", async () => {
    for (const cargoArgs of [[], ["--features", "fixture"], ["--locked"]]) {
        await runLockedTauri(
            TAURI_OPERATION.Dev,
            [
                "--no-watch",
                "--target",
                "host-target",
                "--",
                ...cargoArgs,
                "--",
                "--locked",
                "value with spaces",
            ],
            {
                platform: "linux",
                async runCommand(command, args) {
                    assert.equal(command, "yarn");
                    assert.deepEqual(args.slice(0, 6), [
                        "tauri",
                        TAURI_OPERATION.Dev,
                        "--no-watch",
                        "--target",
                        "host-target",
                        "--",
                    ]);
                    const applicationSeparator = args.indexOf("--", 6);
                    assert.equal(
                        args
                            .slice(6, applicationSeparator)
                            .filter((arg) => arg === "--locked").length,
                        1,
                    );
                    assert.deepEqual(args.slice(applicationSeparator), [
                        "--",
                        "--locked",
                        "value with spaces",
                    ]);
                },
            },
        );
    }
});

test("both operations reject a missing or stale lock through the real Cargo runner", async () => {
    await mkdir(path.join(rootDir, "tmp"), { recursive: true });
    const fixtureRoot = await mkdtemp(
        path.join(rootDir, "tmp", "locked-tauri-cargo-"),
    );
    for (const operation of Object.values(TAURI_OPERATION)) {
        const project = path.join(fixtureRoot, operation);
        await mkdir(path.join(project, "src"), { recursive: true });
        const manifest = (version) =>
            `[package]\nname = "lock_fixture"\nversion = "${version}"\nedition = "2021"\n[workspace]\n`;
        await writeFile(path.join(project, "Cargo.toml"), manifest("0.1.0"));
        await writeFile(
            path.join(project, "src", "main.rs"),
            'fn main() { println!("{:?}", std::env::args().skip(1).collect::<Vec<_>>()); }',
        );
        const environment = {
            ...process.env,
            CARGO_NET_OFFLINE: "true",
            CARGO_TARGET_DIR: path.join(project, "target"),
        };
        const invoke = async () =>
            await runLockedTauri(
                operation,
                operation === TAURI_OPERATION.Dev
                    ? ["--", "--", "value with spaces"]
                    : [],
                {
                    environment,
                    async runCommand(_command, args) {
                        // Exercise the actual Cargo contract with the owner's runner
                        // segment; the fixture is a console app, never a desktop GUI.
                        return spawnSync(
                            "cargo",
                            [
                                operation === TAURI_OPERATION.Dev
                                    ? "run"
                                    : "build",
                                "--offline",
                                ...args.slice(args.indexOf("--") + 1),
                            ],
                            {
                                cwd: project,
                                env: environment,
                                encoding: "utf8",
                            },
                        );
                    },
                },
            );
        const lockPath = path.join(project, "Cargo.lock");
        const missing = await invoke();
        assert.equal(missing.error, undefined);
        assert.notEqual(missing.status, 0);
        assert.match(missing.stderr, /lock ?file.*--locked/s);
        await assert.rejects(readFile(lockPath), { code: "ENOENT" });
        const generate = spawnSync(
            "cargo",
            ["generate-lockfile", "--offline"],
            { cwd: project, env: environment, encoding: "utf8" },
        );
        assert.equal(generate.status, 0, generate.stderr);
        const lockedBytes = await readFile(lockPath);
        const valid = await invoke();
        assert.equal(valid.status, 0, valid.stderr);
        if (operation === TAURI_OPERATION.Dev)
            assert.match(valid.stdout, /value with spaces/);
        assert.deepEqual(await readFile(lockPath), lockedBytes);
        await writeFile(path.join(project, "Cargo.toml"), manifest("0.2.0"));
        const stale = await invoke();
        assert.notEqual(stale.status, 0);
        assert.match(stale.stderr, /lock ?file.*--locked/s);
        assert.deepEqual(await readFile(lockPath), lockedBytes);
    }
});

test("the real pinned development CLI accepts the locked argument layout without launching an app", async () => {
    const result = await runLockedTauri(TAURI_OPERATION.Dev, ["--help"], {
        platform: "win32",
    });
    assert.match(result.stdout, /Usage:.*dev/);
    assert.match(result.stdout, /--no-watch/);
});
