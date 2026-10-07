import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { projectYarnCommand } from "./project-yarn-command.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

test("literal Yarn commands use the Windows interpreter and direct POSIX launch", () => {
    const tokens = ["workspace", "@artgod/frontend", "run", "build"];
    assert.deepEqual(projectYarnCommand(tokens, "win32"), {
        command: "cmd.exe",
        args: [
            "/d",
            "/s",
            "/c",
            "yarn.cmd workspace @artgod/frontend run build",
        ],
    });
    assert.deepEqual(projectYarnCommand(tokens, "linux"), {
        command: "yarn",
        args: tokens,
    });
});

test("shell syntax and arbitrary input cannot enter the Yarn command string", () => {
    for (const tokens of [
        [],
        [""],
        ["build & other"],
        ["%PATH%"],
        ["!PATH!"],
        ["a|b"],
        ["a>b"],
        ["a<b"],
        ['"quoted"'],
        ["a\nb"],
        ["path with spaces"],
        [null],
    ]) {
        for (const platform of ["linux", "win32"]) {
            assert.throws(
                () => projectYarnCommand(tokens, platform),
                /literal command tokens/,
            );
        }
    }
});

test("the supported launcher starts the installed project Yarn on the host platform", () => {
    const { command, args } = projectYarnCommand(["--version"]);
    const result = spawnSync(command, args, {
        cwd: rootDir,
        env: {
            ...process.env,
            YARN_ENABLE_NETWORK: "0",
            COREPACK_ENABLE_NETWORK: "0",
        },
        encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(
        readFileSync(path.join(rootDir, "package.json"), "utf8"),
    );
    assert.equal(result.stdout.trim(), manifest.packageManager.split("@")[1]);
});
