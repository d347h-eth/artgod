import assert from "node:assert/strict";
import { QUALIFICATION_CHECK as CHECK } from "../qualification-protocol.mjs";
import { assertSimulationProperty } from "./oracle-assertions.mjs";

export const RUNTIME_KNOWN_ANSWER_POLICY = Object.freeze({
    arithmeticPasses: 4_096,
    cryptoPasses: 16,
});
export const BIGINT_OPERATION = Object.freeze({
    Add: "modular-add",
    Multiply: "modular-multiply",
    Remainder: "signed-remainder",
});

// Answers were calculated independently with CPython integer arithmetic, not
// viem/noble or this JS evaluator. p is the SEC 2 secp256k1 field modulus.
// Useful independent identities: (2^128+1)(2^128-1)=2^256-1;
// 2^256-1 mod p=2^32+976. Signed remainder has the dividend's sign in JS.
const P = "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f";
const MAX256 =
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const ARITHMETIC_VECTORS = Object.freeze([
    {
        id: "add-carry",
        operation: BIGINT_OPERATION.Add,
        left: MAX256,
        right: "1",
        modulus: P,
        expected: "4294968273",
    },
    {
        id: "add-reduced",
        operation: BIGINT_OPERATION.Add,
        left: "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2e",
        right: "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2e",
        modulus: P,
        expected:
            "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2d",
    },
    {
        id: "multiply-wide",
        operation: BIGINT_OPERATION.Multiply,
        left: "0x100000000000000000000000000000001",
        right: "0xffffffffffffffffffffffffffffffff",
        modulus: P,
        expected: "4294968272",
    },
    {
        id: "multiply-reduced",
        operation: BIGINT_OPERATION.Multiply,
        left: "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2e",
        right: "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2e",
        modulus: P,
        expected: "1",
    },
    {
        id: "remainder-wide",
        operation: BIGINT_OPERATION.Remainder,
        left: MAX256,
        right: "0",
        modulus: P,
        expected: "4294968272",
    },
    {
        id: "remainder-negative",
        operation: BIGINT_OPERATION.Remainder,
        left: "-7",
        right: "0",
        modulus: "3",
        expected: "-1",
    },
]);

// Exact signed-64-bit SQL results, including integers outside JS Number's safe
// range. SQLite computes the sum; the driver must preserve both bound/read types.
const SQLITE_VECTORS = Object.freeze([
    {
        id: "int64-maximum",
        input: "9223372036854775807",
        left: "9223372036854775806",
        right: "1",
        expected: "9223372036854775807",
    },
    {
        id: "int64-minimum",
        input: "-9223372036854775808",
        left: "-9223372036854775807",
        right: "-1",
        expected: "-9223372036854775808",
    },
    {
        id: "above-number-exact-range",
        input: "9007199254740993",
        left: "9007199254740992",
        right: "1",
        expected: "9007199254740993",
    },
    {
        id: "below-number-exact-range",
        input: "-9007199254740993",
        left: "-9007199254740992",
        right: "-1",
        expected: "-9007199254740993",
    },
]);

// Fixed public Ethereum key1/2/3 vectors. Public points were independently
// checked by affine secp256k1 addition using SEC 2's generator and modulus in
// CPython. Addresses are literal public known answers, never regenerated from
// the SDK under test. Reuse the actual fixture key/account owner as the input.
export const FIXTURE_CRYPTO_VECTORS = Object.freeze([
    {
        actor: "seller",
        key: 1n,
        address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
        publicKey:
            "0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
    },
    {
        actor: "bidder",
        key: 2n,
        address: "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf",
        publicKey:
            "0x04c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee51ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a",
    },
    {
        actor: "buyer",
        key: 3n,
        address: "0x6813eb9362372eef6200f3b1dbc3f819671cba69",
        publicKey:
            "0x04f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9388f7b0f632de8140fe337e62a37f3566500a99934c2231b6cb9fd7584b8e672",
    },
]);

function evaluateArithmetic(vector) {
    const { left, right, modulus } = vector;
    switch (vector.operation) {
        case BIGINT_OPERATION.Add:
            return (left + right) % modulus;
        case BIGINT_OPERATION.Multiply:
            return (left * right) % modulus;
        case BIGINT_OPERATION.Remainder:
            return left % modulus;
        default:
            throw new Error(
                `Unknown BigInt known-answer operation ${vector.operation}`,
            );
    }
}

/** Hot parameter-driven operations and actual native SQLite reads; no constant-only loop. */
export function verifyRuntimeBigInt(
    database,
    { evaluate = evaluateArithmetic } = {},
) {
    assert.ok(
        database,
        "Runtime known answers require the actual qualification SQLite connection",
    );
    const vectors = ARITHMETIC_VECTORS.map((vector) => ({
        ...vector,
        left: BigInt(vector.left),
        right: BigInt(vector.right),
        modulus: BigInt(vector.modulus),
        expected: BigInt(vector.expected),
    }));
    const sql = SQLITE_VECTORS.map((vector) => ({
        ...vector,
        input: BigInt(vector.input),
        left: BigInt(vector.left),
        right: BigInt(vector.right),
        expected: BigInt(vector.expected),
    }));
    const statement = database
        .prepare("SELECT ? AS echoed, ? + ? AS sum")
        .safeIntegers(true);
    for (
        let pass = 0;
        pass < RUNTIME_KNOWN_ANSWER_POLICY.arithmeticPasses;
        pass++
    ) {
        for (let index = 0; index < vectors.length; index++) {
            const vector = vectors[(index + pass) % vectors.length];
            assertSimulationProperty(
                `${CHECK.RuntimeBigInt}:${vector.id}`,
                () => {
                    const actual = evaluate(vector);
                    assert.equal(typeof actual, "bigint");
                    assert.equal(
                        actual,
                        vector.expected,
                        `${vector.id} at hot pass ${pass}`,
                    );
                },
            );
        }
        const vector = sql[pass % sql.length];
        assertSimulationProperty(`${CHECK.RuntimeBigInt}:${vector.id}`, () => {
            const row = statement.get(vector.input, vector.left, vector.right);
            assert.equal(typeof row.echoed, "bigint");
            assert.equal(typeof row.sum, "bigint");
            assert.equal(row.echoed, vector.input);
            assert.equal(
                row.sum,
                vector.expected,
                `${vector.id} at native pass ${pass}`,
            );
        });
    }
    return {
        passes: RUNTIME_KNOWN_ANSWER_POLICY.arithmeticPasses,
        arithmeticComparisons:
            RUNTIME_KNOWN_ANSWER_POLICY.arithmeticPasses * vectors.length,
        arithmeticVectors: vectors.map((vector) => vector.id),
        sqliteComparisons: RUNTIME_KNOWN_ANSWER_POLICY.arithmeticPasses * 2,
        sqliteVectors: sql.map((vector) => vector.id),
    };
}

/** Lazy imports keep SDK/fixture initialization inside an observed M0 stage. */
export async function verifyFixtureCrypto({
    loadFixtures = () => import("../world/wire.mjs"),
    loadAccounts = () => import("viem/accounts"),
} = {}) {
    const { WORLD_FIXTURE_KEYS: keys, WORLD_FIXTURE_ACCOUNTS: accounts } =
        await loadFixtures();
    const { privateKeyToAccount } = await loadAccounts();
    for (const vector of FIXTURE_CRYPTO_VECTORS)
        assertSimulationProperty(
            `${CHECK.FixtureCrypto}:${vector.actor}`,
            () => {
                assert.equal(BigInt(keys[vector.actor]), vector.key);
                assert.equal(
                    accounts[vector.actor].address.toLowerCase(),
                    vector.address,
                );
                assert.equal(
                    accounts[vector.actor].publicKey.toLowerCase(),
                    vector.publicKey,
                );
            },
        );
    for (let pass = 0; pass < RUNTIME_KNOWN_ANSWER_POLICY.cryptoPasses; pass++)
        for (const vector of FIXTURE_CRYPTO_VECTORS)
            assertSimulationProperty(
                `${CHECK.FixtureCrypto}:${vector.actor}`,
                () => {
                    const account = privateKeyToAccount(keys[vector.actor]);
                    assert.equal(
                        account.address.toLowerCase(),
                        vector.address,
                        `address at crypto pass ${pass}`,
                    );
                    assert.equal(
                        account.publicKey.toLowerCase(),
                        vector.publicKey,
                        `public key at crypto pass ${pass}`,
                    );
                },
            );
    return {
        passes: RUNTIME_KNOWN_ANSWER_POLICY.cryptoPasses,
        comparisons:
            FIXTURE_CRYPTO_VECTORS.length *
            (RUNTIME_KNOWN_ANSWER_POLICY.cryptoPasses + 1) *
            2,
        actors: FIXTURE_CRYPTO_VECTORS.map(({ actor, address, publicKey }) => ({
            actor,
            address,
            publicKey,
        })),
    };
}

/** Failures here identify substrate correctness, never an ArtGod business property. */
export async function qualifyRuntimeKnownAnswers(database, cryptoDependencies) {
    const checks = {};
    const evidence = { node: process.version, v8: process.versions.v8 };
    let activeCheck = CHECK.RuntimeBigInt;
    try {
        checks[activeCheck] = false;
        evidence.bigInt = verifyRuntimeBigInt(database);
        checks[activeCheck] = true;
        activeCheck = CHECK.FixtureCrypto;
        checks[activeCheck] = false;
        evidence.fixtureCrypto = await verifyFixtureCrypto(cryptoDependencies);
        checks[activeCheck] = true;
        return { checks, evidence };
    } catch (error) {
        error.simulation = {
            ...(error.simulation ?? {}),
            checks,
            failedCheck: activeCheck,
            failedProperty: error.property ?? activeCheck,
            runtimeKnownAnswers: evidence,
        };
        throw error;
    }
}
