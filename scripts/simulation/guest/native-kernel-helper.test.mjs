import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createArtifactRunDirectory } from "../artifacts.mjs";
import { NATIVE_CORE_CONTEXT_POLICY as POLICY } from "./native-failure-evidence.mjs";
import {
    nativeKernelHelperScript,
    nativeKernelHelperBytes,
    assertNativeKernelHelper,
    NATIVE_KERNEL_HELPER_CHECK as CHECK,
    NATIVE_KERNEL_HELPER_ASSET as ASSET,
} from "./native-kernel-helper.mjs";

const valid = [POLICY.coordinator, POLICY.collectorArgument, "404", "11"];
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function script() {
    const directory = await createArtifactRunDirectory(
        `${root}/tmp/simulation-native-core-tests`,
        "dispatcher-",
    );
    const filename = `${directory}/usermode-helper`;
    // Host tests invoke only explicit no-exec check modes through sh. This file
    // is not made executable; no collector or fault fixture runs on the host.
    await writeFile(filename, nativeKernelHelperBytes(), { mode: 0o600 });
    return filename;
}
const check = (filename, mode, args) =>
    spawnSync("sh", [filename, mode, ...args], {
        env: { PATH: process.env.PATH, LANG: "C" },
        encoding: "utf8",
        timeout: 5000,
    });

test("static helper accepts only the exact post-shebang collector argv and finite kernel PID/signal identities", async () => {
    const filename = await script();
    assert.equal(spawnSync("sh", ["-n", filename]).status, 0);
    for (const args of [
        valid,
        [POLICY.coordinator, POLICY.collectorArgument, "2", "1"],
        [POLICY.coordinator, POLICY.collectorArgument, "2147483647", "64"],
    ]) {
        const result = check(filename, CHECK.Arguments, args);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "");
    }
    for (const args of [
        [],
        [POLICY.coordinator],
        [...valid, "extra"],
        ["/other/script", ...valid.slice(1)],
        [POLICY.coordinator, "--eval", "404", "11"],
        ...[
            "",
            "0",
            "1",
            "0404",
            "-1",
            "2147483648",
            "9".repeat(100),
            "404; printf unsafe",
            "$(printf unsafe)",
        ].map((pid) => [
            POLICY.coordinator,
            POLICY.collectorArgument,
            pid,
            "11",
        ]),
        ...["0", "65", "-11", "011", "11; printf unsafe"].map((signal) => [
            POLICY.coordinator,
            POLICY.collectorArgument,
            "404",
            signal,
        ]),
    ]) {
        const result = check(filename, CHECK.Arguments, args);
        assert.equal(result.status, 126, JSON.stringify(args));
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /fixed private replay guest request/);
    }
});

test("the helper private-guest guard refuses this host in a check mode that can never execute Node", async () => {
    const result = check(await script(), CHECK.Guest, valid);
    assert.equal(result.status, 126);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /private replay guest/);
    assert.ok(!result.stderr.includes("Cannot find module"));
});

test("v2 requires exact regular executable dispatcher bytes and records their pin before policy mutation", async () => {
    const bytes = nativeKernelHelperBytes();
    assert.equal(bytes.toString(), nativeKernelHelperScript());
    assert.equal(ASSET.guestPath, POLICY.dispatcher);
    const io = {
        lstat: async (filename) => {
            assert.equal(filename, ASSET.guestPath);
            return { isFile: () => true, size: bytes.length, mode: 0o100700 };
        },
        readFile: async (filename) => {
            assert.equal(filename, ASSET.guestPath);
            return bytes;
        },
    };
    const pin = await assertNativeKernelHelper(io);
    assert.equal(pin.sizeBytes, bytes.length);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    for (const change of [
        (value) => (value.isFile = () => false),
        (value) => (value.mode = 0o100600),
        (value) => value.size++,
    ]) {
        const metadata = await io.lstat(ASSET.guestPath);
        change(metadata);
        await assert.rejects(
            assertNativeKernelHelper({ ...io, lstat: async () => metadata }),
            /exact executable/,
        );
    }
    const changed = Buffer.from(bytes);
    changed[changed.length - 2] ^= 1;
    await assert.rejects(
        assertNativeKernelHelper({ ...io, readFile: async () => changed }),
        /bytes differ/,
    );
});
