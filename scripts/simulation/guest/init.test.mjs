import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SCENARIO_DEVICE_ENV } from "../storage-profile.mjs";

const filename = fileURLToPath(new URL("./init.sh", import.meta.url));
const execute = (device, args = ["--check-scenario-device"]) =>
    spawnSync("sh", [filename, ...args], {
        env: {
            PATH: process.env.PATH,
            LANG: "C",
            ...(device === undefined ? {} : { [SCENARIO_DEVICE_ENV]: device }),
        },
        encoding: "utf8",
        timeout: 5_000,
    });

test("guest init validates the explicit kernel input-device wire contract before any mounts", () => {
    // Linux block-device names are deliberately asserted at the shell boundary.
    for (const device of ["/dev/vda", "/dev/vdb"]) {
        const result = execute(device);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `${device}\n`);
    }
    for (const device of [
        undefined,
        "",
        "/dev/sda",
        "/dev/vdc",
        "/dev/vda; printf unintended",
    ]) {
        const result = execute(device);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.match(
            result.stderr,
            new RegExp(`explicit ${SCENARIO_DEVICE_ENV}`),
        );
    }
});

test("ordinary host invocation is rejected before any mount or poweroff command", () => {
    const result = execute("/dev/vda", []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /guest PID 1/);
    assert.equal(result.stdout, "");
});
