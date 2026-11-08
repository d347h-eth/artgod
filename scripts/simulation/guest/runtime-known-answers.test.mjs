import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import {
    QUALIFICATION_CHECK as CHECK,
    QUALIFICATION_CHECKS,
    CHECK_COVERAGE_STATUS,
} from "../qualification-protocol.mjs";
import { formatFailureEvidence } from "./failure-evidence.mjs";
import {
    verifyRuntimeBigInt,
    verifyFixtureCrypto,
    qualifyRuntimeKnownAnswers,
    RUNTIME_KNOWN_ANSWER_POLICY as POLICY,
} from "./runtime-known-answers.mjs";

const Database = createRequire(
    new URL("../../../shared/package.json", import.meta.url),
)("better-sqlite3");

test("hot arithmetic known answers and actual SQLite signed64 bind/read boundaries pass without writes", () => {
    const database = new Database(":memory:");
    try {
        const evidence = verifyRuntimeBigInt(database);
        assert.equal(evidence.passes, 4096);
        assert.equal(
            evidence.arithmeticComparisons,
            POLICY.arithmeticPasses * 6,
        );
        assert.equal(evidence.sqliteComparisons, POLICY.arithmeticPasses * 2);
        assert.equal(
            database.prepare("SELECT total_changes() AS value").get().value,
            0,
        );
    } finally {
        database.close();
    }
});

test("Number substitution or dropped modular arithmetic is a runtime failure even when a loop completes", () => {
    const database = new Database(":memory:");
    try {
        for (const evaluate of [
            () => 1,
            (vector) => vector.left + vector.right,
        ])
            assert.throws(
                () => verifyRuntimeBigInt(database, { evaluate }),
                (error) => error.property.startsWith(`${CHECK.RuntimeBigInt}:`),
            );
    } finally {
        database.close();
    }
});

test("native Number coercion cannot pass the exact BigInt SQL read oracle", () => {
    const lossy = {
        prepare() {
            return {
                safeIntegers() {
                    return {
                        get(input, left, right) {
                            return {
                                echoed: Number(input),
                                sum: Number(left + right),
                            };
                        },
                    };
                },
            };
        },
    };
    assert.throws(
        () => verifyRuntimeBigInt(lossy),
        (error) => error.property === `${CHECK.RuntimeBigInt}:int64-maximum`,
    );
});

test("actual fixture key derivation matches all independent address and public-point literals", async () => {
    const result = await verifyFixtureCrypto();
    assert.equal(result.passes, POLICY.cryptoPasses);
    assert.equal(result.actors.length, 3);
    assert.equal(result.comparisons, 3 * (POLICY.cryptoPasses + 1) * 2);
    assert.doesNotThrow(() => JSON.stringify(result));
});

test("a correct address alone cannot hide an incorrect public point", async () => {
    await assert.rejects(
        verifyFixtureCrypto({
            loadAccounts: async () => ({
                privateKeyToAccount: () => ({
                    address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
                    publicKey: "0x00",
                }),
            }),
        }),
        (error) => error.property === `${CHECK.FixtureCrypto}:seller`,
    );
});

test("dynamic SDK initialization failure retains the prior BigInt proof and names only the failed substrate stage", async () => {
    const database = new Database(":memory:");
    try {
        await assert.rejects(
            qualifyRuntimeKnownAnswers(database, {
                loadFixtures: async () => {
                    throw new TypeError("Cannot mix BigInt and other types");
                },
            }),
            (error) => {
                const evidence = formatFailureEvidence(
                    error,
                    QUALIFICATION_CHECKS,
                );
                assert.equal(evidence.failedCheck, CHECK.FixtureCrypto);
                assert.equal(evidence.failedProperty, CHECK.FixtureCrypto);
                assert.equal(evidence.checks[CHECK.RuntimeBigInt], true);
                assert.equal(evidence.checks[CHECK.FixtureCrypto], false);
                assert.equal(
                    evidence.runtimeKnownAnswers.bigInt.passes,
                    POLICY.arithmeticPasses,
                );
                assert.equal(
                    evidence.coverage.find(
                        (row) => row.check === CHECK.RuntimeBigInt,
                    ).status,
                    CHECK_COVERAGE_STATUS.Passed,
                );
                assert.equal(
                    evidence.coverage.find(
                        (row) => row.check === CHECK.FixtureCrypto,
                    ).status,
                    CHECK_COVERAGE_STATUS.Failed,
                );
                assert.equal(
                    evidence.coverage.find(
                        (row) => row.check === CHECK.SqliteWal,
                    ).status,
                    CHECK_COVERAGE_STATUS.Unreached,
                );
                return true;
            },
        );
    } finally {
        database.close();
    }
});

test("the guest eager import closure excludes fixture crypto until the explicit dynamic stage", async () => {
    const result = await build({
        absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)),
        entryPoints: ["scripts/simulation/guest/guest.mjs"],
        bundle: true,
        platform: "node",
        format: "esm",
        metafile: true,
        external: ["better-sqlite3", "sharp"],
        write: false,
        logLevel: "silent",
    });
    const eager = new Set();
    const visit = (entry) => {
        if (eager.has(entry)) return;
        eager.add(entry);
        for (const dependency of result.metafile.inputs[entry].imports)
            if (!dependency.external && dependency.kind !== "dynamic-import")
                visit(dependency.path);
    };
    visit("scripts/simulation/guest/guest.mjs");
    for (const entry of eager)
        assert.ok(
            !entry.includes("world/wire.mjs") &&
                !entry.includes("@noble/curves") &&
                !entry.includes("runtime-known-answers.mjs"),
            `Unexpected eager runtime crypto dependency: ${entry}`,
        );
});
