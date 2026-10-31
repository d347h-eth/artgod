import assert from "node:assert/strict";
import test from "node:test";
import { DESKTOP_CARGO_PROJECTS } from "../build/cargo-projects.mjs";
import { DESKTOP_RUST_TARGET } from "../build/native-runtime-dependencies.mjs";
import {
    checkCargoCryptoSecurity,
    CARGO_CRYPTO_TARGETS,
    CRYPTO_BIGINT_SECURITY_FLOOR,
    findCryptoViolations,
    parseCargoCryptoTree,
} from "./cargo-crypto-security.mjs";

const walletTree = [
    "artgod-desktop v0.0.0 (fixture)|",
    "eth-keystore v0.5.0 (fixture/vendor/eth-keystore)|",
    "k256 v0.14.0|arithmetic,std",
    `crypto-bigint v${CRYPTO_BIGINT_SECURITY_FLOOR}|zeroize`,
    "aes v0.8.4|zeroize",
].join("\n");

test("enabled patched graph passes, including repeated feature-bearing nodes", () => {
    const entries = parseCargoCryptoTree(
        `${walletTree}\naes v0.8.4|zeroize (*)\n`,
    );
    assert.deepEqual(
        findCryptoViolations(entries, { requireWalletStack: true }),
        [],
    );
});

test("reactivating legacy arithmetic or a prerelease below the patch floor fails", () => {
    for (const version of [
        "0.5.5",
        "0.7.5",
        `${CRYPTO_BIGINT_SECURITY_FLOOR}-rc.1`,
    ]) {
        const entries = parseCargoCryptoTree(
            `${walletTree}\ncrypto-bigint v${version}|zeroize`,
        );
        assert.equal(findCryptoViolations(entries).length, 1);
    }
});

test("AES wiping cannot be satisfied by an unrelated zeroize crate or another AES version", () => {
    const entries = parseCargoCryptoTree(
        `${walletTree}\naes v0.9.0|\nzeroize v1.8.2|alloc`,
    );
    assert.equal(findCryptoViolations(entries).length, 1);
});

test("empty, malformed and incomplete desktop graphs fail closed", () => {
    assert.throws(() => parseCargoCryptoTree(""), /empty/);
    assert.throws(
        () => parseCargoCryptoTree("changed cargo output"),
        /Unrecognized/,
    );
    assert.ok(
        findCryptoViolations(parseCargoCryptoTree("unrelated v1.0.0|"), {
            requireWalletStack: true,
        }).length,
    );
});

test("every maintained root is checked with default and all features across all targets", async () => {
    const calls = [];
    const result = await checkCargoCryptoSecurity({
        projectRoot: "fixture",
        offline: true,
        cargo: async (args, options) => {
            calls.push({ args, options });
            assert.equal(options.cwd, "fixture");
            assert.ok(args.includes("--locked"));
            assert.ok(args.includes("--offline"));
            assert.ok(
                CARGO_CRYPTO_TARGETS.includes(
                    args[args.indexOf("--target") + 1],
                ),
            );
            assert.equal(args[args.indexOf("--edges") + 1], "normal,build,dev");
            const manifest = args[args.indexOf("--manifest-path") + 1];
            return manifest === DESKTOP_CARGO_PROJECTS.Desktop.manifestPath
                ? walletTree
                : "helper v0.0.0|";
        },
    });
    assert.deepEqual(result.violations, []);
    assert.equal(
        result.graphCount,
        Object.keys(DESKTOP_CARGO_PROJECTS).length *
            2 *
            CARGO_CRYPTO_TARGETS.length,
    );
    for (const project of Object.values(DESKTOP_CARGO_PROJECTS)) {
        const selected = calls.filter(({ args }) =>
            args.includes(project.manifestPath),
        );
        for (const target of CARGO_CRYPTO_TARGETS) {
            const targeted = selected.filter(
                ({ args }) => args[args.indexOf("--target") + 1] === target,
            );
            assert.equal(targeted.length, 2);
            assert.equal(
                targeted.filter(({ args }) => args.includes("--all-features"))
                    .length,
                1,
            );
        }
    }
});

test("an all-features-only regression fails and Cargo failures propagate", async () => {
    const result = await checkCargoCryptoSecurity({
        cargo: async (args) =>
            args.includes("--all-features")
                ? `${walletTree}\ncrypto-bigint v0.5.5|zeroize`
                : walletTree,
    });
    assert.equal(
        result.violations.length,
        Object.keys(DESKTOP_CARGO_PROJECTS).length *
            CARGO_CRYPTO_TARGETS.length,
    );
    await assert.rejects(
        checkCargoCryptoSecurity({
            cargo: async () => {
                throw new Error("registry unavailable");
            },
        }),
        /registry unavailable/,
    );
});

test("the combined graph cannot hide a missing AES feature on one native target", async () => {
    const result = await checkCargoCryptoSecurity({
        cargo: async (args) =>
            args[args.indexOf("--target") + 1] ===
            DESKTOP_RUST_TARGET.WindowsX64
                ? walletTree.replace("aes v0.8.4|zeroize", "aes v0.8.4|")
                : walletTree,
    });
    assert.equal(
        result.violations.length,
        Object.keys(DESKTOP_CARGO_PROJECTS).length * 2,
    );
    assert.ok(
        result.violations.every((message) =>
            message.includes(DESKTOP_RUST_TARGET.WindowsX64),
        ),
    );
});
