import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import {
    assertImportedSigningKey,
    assertValidSignatureStatus,
    createLinuxGpgSecretRedactor,
    parseSecretKeyListing,
    signLinuxFiles,
} from "./linux-gpg-signing.mjs";

const primaryFingerprint = "A".repeat(40);
const signingSubkeyFingerprint = "B".repeat(40);
const privateKeyPayload = "QWJjZGVmMDEyMzQ1Njc4OSsv".repeat(6);
const privateKey = [
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    privateKeyPayload,
    "-----END PGP PRIVATE KEY BLOCK-----",
    "",
].join("\n");
const passphrase = "linux-passphrase-sentinel-7F4C9A2E";
const ownertrust = `${primaryFingerprint}:6:`;

function createColonRecord(type, fields = {}) {
    const record = Array(16).fill("");
    record[0] = type;
    record[1] = fields.validity ?? "-";
    record[11] = fields.capabilities ?? "";
    record[14] = fields.secretMarker ?? "";
    return record.join(":");
}

function createFingerprintRecord(fingerprint) {
    const record = Array(11).fill("");
    record[0] = "fpr";
    record[9] = fingerprint;
    return record.join(":");
}

function createRecommendedKeyListing(options = {}) {
    return [
        createColonRecord("sec", {
            validity: options.primaryValidity,
            capabilities: "cS",
            secretMarker: "#",
        }),
        createFingerprintRecord(
            options.primaryFingerprint ?? primaryFingerprint,
        ),
        createColonRecord("ssb", {
            validity: options.subkeyValidity,
            capabilities: "s",
            secretMarker: options.subkeySecretMarker,
        }),
        createFingerprintRecord(signingSubkeyFingerprint),
        "",
    ].join("\n");
}

function createValidSignatureStatus() {
    return [
        "[GNUPG:] NEWSIG",
        `[GNUPG:] VALIDSIG ${signingSubkeyFingerprint} 2026-07-10 1783700000 0 4 0 22 8 00 ${primaryFingerprint}`,
        "",
    ].join("\n");
}

function createSigningEnvironment() {
    return {
        LINUX_GPG_PRIVATE_KEY_ASC: privateKey,
        LINUX_GPG_PASSPHRASE: passphrase,
        LINUX_GPG_KEY_ID: primaryFingerprint,
        LINUX_GPG_OWNERTRUST: ownertrust,
    };
}

function createFakeGpgRunner({ failSigning = false } = {}) {
    const observations = {
        cleanupCalls: 0,
        signArguments: null,
        signInput: null,
    };

    return {
        observations,
        async commandRunner(command, args, options) {
            for (const secretName of [
                "LINUX_GPG_PRIVATE_KEY_ASC",
                "LINUX_GPG_PASSPHRASE",
                "LINUX_GPG_KEY_ID",
                "LINUX_GPG_OWNERTRUST",
            ]) {
                assert.equal(options.env[secretName], undefined);
            }
            assert.doesNotMatch(
                inspect(options.redactor, { showHidden: true }),
                /linux-passphrase-sentinel|BEGIN PGP PRIVATE KEY/,
            );

            if (command === "gpgconf") {
                observations.cleanupCalls += 1;
                return createCommandResult();
            }
            assert.equal(command, "gpg");

            if (args.includes("--import-ownertrust")) {
                assert.equal(options.input, `${ownertrust}\n`);
                return createCommandResult();
            }
            if (args.includes("--import")) {
                assert.equal(options.input, privateKey);
                return createCommandResult();
            }
            if (args.includes("--list-secret-keys")) {
                return createCommandResult(createRecommendedKeyListing());
            }
            if (args.includes("--detach-sign")) {
                observations.signArguments = [...args];
                observations.signInput = options.input;
                if (failSigning) {
                    throw new Error("synthetic signing failure");
                }
                const outputIndex = args.indexOf("--output");
                await writeFile(args[outputIndex + 1], "synthetic-signature");
                return createCommandResult("[GNUPG:] SIG_CREATED D 22 8 00\n");
            }
            if (args.includes("--verify")) {
                return createCommandResult(createValidSignatureStatus());
            }

            throw new Error(
                `Unexpected fake GPG invocation: ${args.join(" ")}`,
            );
        },
    };
}

function createCommandResult(stdout = "", stderr = "") {
    return {
        stdout,
        stderr,
        combinedOutput: `${stdout}${stderr}`,
    };
}

test("parses the recommended offline-primary signing-subkey export", () => {
    const [key] = parseSecretKeyListing(createRecommendedKeyListing());

    assert.equal(key.fingerprint, primaryFingerprint);
    assert.equal(key.secretMarker, "#");
    assert.equal(key.subkeys.length, 1);
    assert.equal(key.subkeys[0].fingerprint, signingSubkeyFingerprint);
    assert.equal(key.subkeys[0].capabilities, "s");
});

test("accepts only the expected primary key and usable on-disk signing material", () => {
    assert.deepEqual(
        assertImportedSigningKey(
            createRecommendedKeyListing(),
            primaryFingerprint,
        ),
        new Set([signingSubkeyFingerprint]),
    );
    assert.throws(
        () =>
            assertImportedSigningKey(
                createRecommendedKeyListing({
                    primaryFingerprint: "C".repeat(40),
                }),
                primaryFingerprint,
            ),
        /fingerprint does not match/,
    );
    assert.throws(
        () =>
            assertImportedSigningKey(
                createRecommendedKeyListing({ subkeySecretMarker: "#" }),
                primaryFingerprint,
            ),
        /no usable on-disk secret signing key/,
    );
    assert.throws(
        () =>
            assertImportedSigningKey(
                createRecommendedKeyListing({ subkeyValidity: "e" }),
                primaryFingerprint,
            ),
        /no usable on-disk secret signing key/,
    );
});

test("accepts a valid signature only from the imported signing subkey", () => {
    assert.doesNotThrow(() =>
        assertValidSignatureStatus(
            createValidSignatureStatus(),
            primaryFingerprint,
            new Set([signingSubkeyFingerprint]),
        ),
    );
    assert.throws(
        () =>
            assertValidSignatureStatus(
                createValidSignatureStatus(),
                primaryFingerprint,
                new Set(["C".repeat(40)]),
            ),
        /unexpected signing key or subkey/,
    );
    assert.throws(
        () =>
            assertValidSignatureStatus(
                `[GNUPG:] BADSIG ${signingSubkeyFingerprint} Synthetic\n`,
                primaryFingerprint,
                new Set([signingSubkeyFingerprint]),
            ),
        /rejected status BADSIG/,
    );
});

test("redacts private-key payload and passphrase fragments", () => {
    const redactor = createLinuxGpgSecretRedactor(createSigningEnvironment());
    const privateKeyFragment = privateKeyPayload.slice(9, 21);
    const output = redactor.redact(
        `key:${privateKeyFragment};pass:${passphrase};fpr:${primaryFingerprint}`,
    );

    assert.equal(output, "key:[REDACTED];pass:[REDACTED];fpr:[REDACTED]");
    assert.doesNotMatch(
        inspect(redactor, { showHidden: true }),
        /linux-passphrase-sentinel|BEGIN PGP PRIVATE KEY/,
    );
});

test("signs through passphrase-fd and removes the temporary GPG home", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-gpg-signing-test-"),
    );
    const artifactPath = path.join(temporaryRoot, "ArtGod_test.AppImage");
    const logs = [];
    const fake = createFakeGpgRunner();
    const originalUmask = process.umask();

    try {
        await writeFile(artifactPath, "synthetic-artifact");
        await signLinuxFiles([artifactPath], {
            environment: createSigningEnvironment(),
            temporaryRoot,
            commandRunner: fake.commandRunner,
            logger: (message) => logs.push(message),
        });

        assert.equal(
            await readFile(`${artifactPath}.asc`, "utf8"),
            "synthetic-signature",
        );
        assert.equal(fake.observations.cleanupCalls, 1);
        assert.equal(fake.observations.signInput, `${passphrase}\n`);
        assert.ok(fake.observations.signArguments.includes("--passphrase-fd"));
        assert.ok(!fake.observations.signArguments.includes("--passphrase"));
        assert.ok(!fake.observations.signArguments.includes(passphrase));
        assert.deepEqual(logs, [
            'Created and verified detached signature for "ArtGod_test.AppImage".',
        ]);
        assert.deepEqual(
            (await readdir(temporaryRoot)).filter((name) =>
                name.startsWith("artgod-gpg-"),
            ),
            [],
        );
        assert.equal(process.umask(), originalUmask);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("removes the temporary GPG home after signing failure", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "artgod-gpg-failure-test-"),
    );
    const artifactPath = path.join(temporaryRoot, "ArtGod_test.deb");
    const fake = createFakeGpgRunner({ failSigning: true });

    try {
        await writeFile(artifactPath, "synthetic-artifact");
        await assert.rejects(
            signLinuxFiles([artifactPath], {
                environment: createSigningEnvironment(),
                temporaryRoot,
                commandRunner: fake.commandRunner,
                logger: () => {},
            }),
            /synthetic signing failure/,
        );
        assert.equal(fake.observations.cleanupCalls, 1);
        assert.deepEqual(
            (await readdir(temporaryRoot)).filter((name) =>
                name.startsWith("artgod-gpg-"),
            ),
            [],
        );
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("routes both release signing stages through the hardened helper", async () => {
    const releaseWorkflow = await readFile(
        new URL("../../.github/workflows/tauri-release.yml", import.meta.url),
        "utf8",
    );

    assert.match(
        releaseWorkflow,
        /linux-gpg-signing\.mjs sign-bundles release-assets/,
    );
    assert.match(
        releaseWorkflow,
        /linux-gpg-signing\.mjs sign-checksums SHA256SUMS\.txt/,
    );
    assert.doesNotMatch(releaseWorkflow, /--passphrase "\$LINUX_GPG/);
    assert.doesNotMatch(releaseWorkflow, /export GNUPGHOME=/);
    assert.doesNotMatch(releaseWorkflow, /echo "\$LINUX_GPG_PRIVATE_KEY_ASC"/);
});
