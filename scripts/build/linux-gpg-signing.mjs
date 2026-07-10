import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
    collectSensitivePayloadFragments,
    createSecretRedactor,
    runRedactedCommand,
} from "./secret-output-redaction.mjs";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);

const COMMAND_SIGN_BUNDLES = "sign-bundles";
const COMMAND_FINALIZE_RELEASE = "finalize-release";

const ENV_GPG_PRIVATE_KEY = "LINUX_GPG_PRIVATE_KEY_ASC";
const ENV_GPG_PASSPHRASE = "LINUX_GPG_PASSPHRASE";
const ENV_GPG_KEY_ID = "LINUX_GPG_KEY_ID";
const ENV_GPG_OWNERTRUST = "LINUX_GPG_OWNERTRUST";
const ENV_RUNNER_TEMP = "RUNNER_TEMP";

const GPG_BINARY = "gpg";
const GPGCONF_BINARY = "gpgconf";
const GPG_UNSAFE_PASSPHRASE_OPTION = "--passphrase";
const GPG_PASSPHRASE_FD_OPTION = "--passphrase-fd";
const GPG_STATUS_PREFIX = "[GNUPG:]";
const GPG_STATUS_VALID_SIGNATURE = "VALIDSIG";
const GPG_REJECTED_SIGNATURE_STATUSES = new Set([
    "BADSIG",
    "ERRSIG",
    "EXPSIG",
    "EXPKEYSIG",
    "REVKEYSIG",
]);

const GPG_PRIMARY_SECRET_RECORD = "sec";
const GPG_SUBKEY_SECRET_RECORD = "ssb";
const GPG_FINGERPRINT_RECORD = "fpr";
const GPG_UNUSABLE_VALIDITIES = new Set(["i", "d", "r", "e", "n"]);
const GPG_DISABLED_CAPABILITY = "D";
const GPG_SIGNING_CAPABILITY = "s";
const GPG_SECRET_KEY_STUB = "#";
const GPG_SECRET_KEY_ON_DISK = "+";

const OPENPGP_V4_FINGERPRINT_LENGTH = 40;
const PRIVATE_KEY_REDACTION_WINDOW_LENGTH = 12;
const PASSPHRASE_REDACTION_MINIMUM_LENGTH = 4;
const GPG_HOME_MODE = 0o700;
const GPG_SESSION_UMASK = 0o077;
const GPG_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const GPG_CLEANUP_TIMEOUT_MS = 30 * 1000;
const SIGNATURE_SUFFIX = ".asc";
const LINUX_BUNDLE_SUFFIXES = [".AppImage", ".deb"];

async function main() {
    const command = process.argv[2];

    try {
        assertLinuxHost();
        if (command === COMMAND_SIGN_BUNDLES) {
            const artifactDirectory = path.resolve(
                process.argv[3] ?? path.join(rootDir, "release-assets"),
            );
            await signLinuxFiles(
                await resolveLinuxBundleFiles(artifactDirectory),
            );
            return;
        }
        if (command === COMMAND_FINALIZE_RELEASE) {
            const artifactDirectory = path.resolve(
                process.argv[3] ?? path.join(rootDir, "release-assets"),
            );
            const checksumPath = path.resolve(
                process.argv[4] ?? path.join(rootDir, "SHA256SUMS.txt"),
            );
            await verifyLinuxBundleSignaturesAndSignChecksum(
                await resolveLinuxBundleFiles(artifactDirectory),
                checksumPath,
            );
            return;
        }

        throw new Error(
            `Usage: node scripts/build/linux-gpg-signing.mjs <${COMMAND_SIGN_BUNDLES} [artifact-directory]|${COMMAND_FINALIZE_RELEASE} [artifact-directory] [checksum-path]>`,
        );
    } catch (error) {
        try {
            const redactor = createLinuxGpgSecretRedactor(process.env);
            console.error(
                redactor.redact(
                    error instanceof Error ? error.stack : String(error),
                ),
            );
        } catch {
            console.error(
                "Linux GPG signing failed before a safe output redactor could be created.",
            );
        }
        process.exitCode = 1;
    }
}

// Signs and verifies files inside a temporary, always-removed GPG home.
export async function signLinuxFiles(filePaths, options = {}) {
    await runLinuxGpgSession({ filePathsToSign: filePaths, options });
}

// Re-verifies transferred bundles before signing the release checksum manifest.
export async function verifyLinuxBundleSignaturesAndSignChecksum(
    bundlePaths,
    checksumPath,
    options = {},
) {
    await runLinuxGpgSession({
        filePathsToVerify: bundlePaths,
        filePathsToSign: [checksumPath],
        options,
    });
}

async function runLinuxGpgSession({
    filePathsToVerify = [],
    filePathsToSign = [],
    options,
}) {
    const environment = options.environment ?? process.env;
    const config = readSigningConfig(environment);
    const redactor = createLinuxGpgSecretRedactor(environment);
    const commandRunner = options.commandRunner ?? runRedactedCommand;
    const logger = options.logger ?? console.log;
    const temporaryRoot = path.resolve(
        options.temporaryRoot ??
            environment[ENV_RUNNER_TEMP]?.trim() ??
            os.tmpdir(),
    );
    const previousUmask = process.umask(GPG_SESSION_UMASK);
    let gpgHome;
    let operationError;
    let cleanupError;

    try {
        gpgHome = await mkdtemp(path.join(temporaryRoot, "artgod-gpg-"));
        await chmod(gpgHome, GPG_HOME_MODE);
        const runGpg = createGpgRunner({
            gpgHome,
            redactor,
            commandRunner,
            environment,
            stdoutTarget: options.stdoutTarget,
            stderrTarget: options.stderrTarget,
        });

        await runGpg(["--import"], { input: config.privateKey });
        if (config.ownertrust) {
            await runGpg(["--import-ownertrust"], {
                input: `${config.ownertrust}\n`,
            });
        }

        const keyListing = await runGpg([
            "--with-colons",
            "--with-fingerprint",
            "--with-subkey-fingerprint",
            "--list-secret-keys",
        ]);
        const signingKeyFingerprints = assertImportedSigningKey(
            keyListing.stdout,
            config.primaryFingerprint,
        );

        for (const filePath of filePathsToVerify) {
            await verifyExistingSignature({
                filePath: path.resolve(filePath),
                config,
                signingKeyFingerprints,
                runGpg,
                logger: (message) => logger(redactor.redact(message)),
            });
        }
        for (const filePath of filePathsToSign) {
            await signAndVerifyFile({
                filePath: path.resolve(filePath),
                config,
                signingKeyFingerprints,
                runGpg,
                logger: (message) => logger(redactor.redact(message)),
            });
        }
    } catch (error) {
        operationError = error;
    } finally {
        if (gpgHome) {
            try {
                await commandRunner(
                    GPGCONF_BINARY,
                    ["--homedir", gpgHome, "--kill", "all"],
                    {
                        cwd: rootDir,
                        env: createGpgEnvironment(gpgHome, environment),
                        redactor,
                        stream: true,
                        timeoutMs: GPG_CLEANUP_TIMEOUT_MS,
                        stdoutTarget: options.stdoutTarget,
                        stderrTarget: options.stderrTarget,
                    },
                );
            } catch (error) {
                cleanupError = error;
            }
            try {
                await rm(gpgHome, { recursive: true, force: true });
            } catch (error) {
                cleanupError ??= error;
            }
        }
        process.umask(previousUmask);
    }

    if (operationError && cleanupError) {
        throw new AggregateError(
            [operationError, cleanupError],
            "Linux signing and temporary GPG cleanup both failed.",
        );
    }
    if (operationError) {
        throw operationError;
    }
    if (cleanupError) {
        throw cleanupError;
    }
}

async function verifyExistingSignature({
    filePath,
    config,
    signingKeyFingerprints,
    runGpg,
    logger,
}) {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
        throw new Error(`Signature input is not a regular file: ${filePath}`);
    }
    const signaturePath = `${filePath}${SIGNATURE_SUFFIX}`;
    const signatureStat = await stat(signaturePath);
    if (!signatureStat.isFile() || signatureStat.size === 0) {
        throw new Error(
            `Missing non-empty detached signature for ${filePath}.`,
        );
    }

    const verification = await runGpg([
        "--status-fd",
        "1",
        "--logger-fd",
        "2",
        "--verify",
        signaturePath,
        filePath,
    ]);
    assertValidSignatureStatus(
        verification.stdout,
        config.primaryFingerprint,
        signingKeyFingerprints,
    );
    logger(
        `Verified transferred detached signature for ${JSON.stringify(path.basename(filePath))}.`,
    );
}

// Builds the Linux signer redactor without exposing its source credentials.
export function createLinuxGpgSecretRedactor(environment) {
    const privateKey = environment[ENV_GPG_PRIVATE_KEY];
    const passphrase = environment[ENV_GPG_PASSPHRASE];
    const ownertrust = environment[ENV_GPG_OWNERTRUST];
    return createSecretRedactor([
        privateKey,
        passphrase,
        environment[ENV_GPG_KEY_ID],
        ownertrust,
        ...collectSensitivePayloadFragments(
            privateKey ?? "",
            PRIVATE_KEY_REDACTION_WINDOW_LENGTH,
        ),
        ...String(passphrase ?? "")
            .split(/\s+/)
            .filter(
                (fragment) =>
                    fragment.length >= PASSPHRASE_REDACTION_MINIMUM_LENGTH,
            ),
    ]);
}

// Parses GPG's stable colon listing into primary and subkey records.
export function parseSecretKeyListing(output) {
    const keys = [];
    let currentKey;
    let pendingFingerprintRecord;

    for (const line of output.split(/\r?\n/)) {
        if (!line) {
            continue;
        }
        const fields = line.split(":");
        const recordType = fields[0];
        if (recordType === GPG_PRIMARY_SECRET_RECORD) {
            currentKey = createSecretKeyRecord(fields);
            currentKey.subkeys = [];
            keys.push(currentKey);
            pendingFingerprintRecord = currentKey;
            continue;
        }
        if (recordType === GPG_SUBKEY_SECRET_RECORD && currentKey) {
            const subkey = createSecretKeyRecord(fields);
            currentKey.subkeys.push(subkey);
            pendingFingerprintRecord = subkey;
            continue;
        }
        if (recordType === GPG_FINGERPRINT_RECORD && pendingFingerprintRecord) {
            pendingFingerprintRecord.fingerprint = fields[9]?.toUpperCase();
            pendingFingerprintRecord = null;
        }
    }

    return keys;
}

// Verifies that one expected primary key and usable signing material were imported.
export function assertImportedSigningKey(output, expectedPrimaryFingerprint) {
    const expectedFingerprint = normalizeFingerprint(
        expectedPrimaryFingerprint,
    );
    const keys = parseSecretKeyListing(output);
    if (keys.length !== 1) {
        throw new Error(
            `Expected exactly one imported secret primary key, found ${keys.length}.`,
        );
    }

    const [primaryKey] = keys;
    if (primaryKey.fingerprint !== expectedFingerprint) {
        throw new Error(
            "Imported secret primary-key fingerprint does not match LINUX_GPG_KEY_ID.",
        );
    }
    if (!isUsableKeyRecord(primaryKey)) {
        throw new Error("Imported secret primary key is unusable.");
    }

    const signingKeyFingerprints = [primaryKey, ...primaryKey.subkeys]
        .filter(isUsableSigningSecretRecord)
        .map((record) => record.fingerprint);
    if (signingKeyFingerprints.length === 0) {
        throw new Error(
            "Imported release key has no usable on-disk secret signing key or subkey.",
        );
    }
    return new Set(signingKeyFingerprints);
}

// Verifies GPG's machine status against the expected primary and signing keys.
export function assertValidSignatureStatus(
    output,
    expectedPrimaryFingerprint,
    signingKeyFingerprints,
) {
    const expectedFingerprint = normalizeFingerprint(
        expectedPrimaryFingerprint,
    );
    const statusRecords = parseGpgStatusRecords(output);
    const rejectedStatus = statusRecords.find(({ name }) =>
        GPG_REJECTED_SIGNATURE_STATUSES.has(name),
    );
    if (rejectedStatus) {
        throw new Error(
            `GPG verification returned rejected status ${rejectedStatus.name}.`,
        );
    }

    const validSignatures = statusRecords.filter(
        ({ name }) => name === GPG_STATUS_VALID_SIGNATURE,
    );
    if (validSignatures.length !== 1) {
        throw new Error(
            `Expected exactly one GPG VALIDSIG record, found ${validSignatures.length}.`,
        );
    }

    const [validSignature] = validSignatures;
    const signingFingerprint = normalizeFingerprint(
        validSignature.arguments[0],
    );
    const primaryFingerprint = normalizeFingerprint(
        validSignature.arguments[9] ?? signingFingerprint,
    );
    if (primaryFingerprint !== expectedFingerprint) {
        throw new Error(
            "Verified signature primary-key fingerprint does not match LINUX_GPG_KEY_ID.",
        );
    }
    if (!signingKeyFingerprints.has(signingFingerprint)) {
        throw new Error(
            "Verified signature was made by an unexpected signing key or subkey.",
        );
    }
}

async function signAndVerifyFile({
    filePath,
    config,
    signingKeyFingerprints,
    runGpg,
    logger,
}) {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
        throw new Error(`Signing input is not a regular file: ${filePath}`);
    }
    const signaturePath = `${filePath}${SIGNATURE_SUFFIX}`;

    // Feed the passphrase over stdin so it never appears in process arguments.
    await runGpg(
        [
            "--status-fd",
            "1",
            "--logger-fd",
            "2",
            "--yes",
            "--pinentry-mode",
            "loopback",
            GPG_PASSPHRASE_FD_OPTION,
            "0",
            "--local-user",
            config.primaryFingerprint,
            "--armor",
            "--detach-sign",
            "--output",
            signaturePath,
            filePath,
        ],
        { input: `${config.passphrase}\n` },
    );

    const signatureStat = await stat(signaturePath);
    if (!signatureStat.isFile() || signatureStat.size === 0) {
        throw new Error(
            `GPG did not create a detached signature for ${filePath}.`,
        );
    }

    const verification = await runGpg([
        "--status-fd",
        "1",
        "--logger-fd",
        "2",
        "--verify",
        signaturePath,
        filePath,
    ]);
    assertValidSignatureStatus(
        verification.stdout,
        config.primaryFingerprint,
        signingKeyFingerprints,
    );
    logger(
        `Created and verified detached signature for ${JSON.stringify(path.basename(filePath))}.`,
    );
}

function createGpgRunner({
    gpgHome,
    redactor,
    commandRunner,
    environment,
    stdoutTarget,
    stderrTarget,
}) {
    return async (args, options = {}) => {
        if (
            args.some(
                (argument) =>
                    argument.startsWith(GPG_UNSAFE_PASSPHRASE_OPTION) &&
                    argument !== GPG_PASSPHRASE_FD_OPTION,
            )
        ) {
            throw new Error(
                "Refusing to pass a GPG passphrase through process arguments.",
            );
        }
        if (
            args.includes(GPG_PASSPHRASE_FD_OPTION) &&
            options.input === undefined
        ) {
            throw new Error("GPG passphrase-fd requires private stdin input.");
        }
        if (!redactor.hasSecretValues()) {
            throw new Error(
                "Refusing to run GPG signing without a populated output redactor.",
            );
        }
        return await commandRunner(
            GPG_BINARY,
            [
                "--no-options",
                "--batch",
                "--no-tty",
                "--homedir",
                gpgHome,
                ...args,
            ],
            {
                cwd: rootDir,
                env: createGpgEnvironment(gpgHome, environment),
                redactor,
                stream: true,
                timeoutMs: GPG_COMMAND_TIMEOUT_MS,
                input: options.input,
                stdoutTarget,
                stderrTarget,
            },
        );
    };
}

function createGpgEnvironment(gpgHome, environment) {
    const gpgEnvironment = {
        ...environment,
        GNUPGHOME: gpgHome,
        LC_ALL: "C",
    };
    delete gpgEnvironment[ENV_GPG_PRIVATE_KEY];
    delete gpgEnvironment[ENV_GPG_PASSPHRASE];
    delete gpgEnvironment[ENV_GPG_KEY_ID];
    delete gpgEnvironment[ENV_GPG_OWNERTRUST];
    return gpgEnvironment;
}

function readSigningConfig(environment) {
    const privateKey = requireEnvironmentValue(
        environment,
        ENV_GPG_PRIVATE_KEY,
    );
    const passphrase = requireEnvironmentValue(environment, ENV_GPG_PASSPHRASE);
    if (/\r|\n/.test(passphrase)) {
        throw new Error(
            `${ENV_GPG_PASSPHRASE} must contain exactly one line for passphrase-fd input.`,
        );
    }
    return {
        privateKey,
        passphrase,
        primaryFingerprint: normalizeFingerprint(
            requireEnvironmentValue(environment, ENV_GPG_KEY_ID),
        ),
        ownertrust: environment[ENV_GPG_OWNERTRUST]?.trim() || null,
    };
}

function requireEnvironmentValue(environment, key) {
    const value = environment[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Missing required environment variable ${key}.`);
    }
    return value;
}

function normalizeFingerprint(value) {
    const fingerprint = String(value ?? "")
        .trim()
        .toUpperCase();
    if (
        fingerprint.length !== OPENPGP_V4_FINGERPRINT_LENGTH ||
        !/^[A-F0-9]+$/.test(fingerprint)
    ) {
        throw new Error(
            `Expected a ${OPENPGP_V4_FINGERPRINT_LENGTH}-character OpenPGP primary fingerprint.`,
        );
    }
    return fingerprint;
}

function createSecretKeyRecord(fields) {
    return {
        validity: fields[1]?.slice(0, 1) ?? "",
        capabilities: fields[11] ?? "",
        secretMarker: fields[14] ?? "",
        fingerprint: null,
    };
}

function isUsableKeyRecord(record) {
    return Boolean(
        record.fingerprint &&
        !GPG_UNUSABLE_VALIDITIES.has(record.validity) &&
        !record.capabilities.includes(GPG_DISABLED_CAPABILITY),
    );
}

function isUsableSigningSecretRecord(record) {
    return Boolean(
        isUsableKeyRecord(record) &&
        record.capabilities.includes(GPG_SIGNING_CAPABILITY) &&
        (record.secretMarker === "" ||
            record.secretMarker === GPG_SECRET_KEY_ON_DISK) &&
        record.secretMarker !== GPG_SECRET_KEY_STUB,
    );
}

function parseGpgStatusRecords(output) {
    return output
        .split(/\r?\n/)
        .filter((line) => line.startsWith(`${GPG_STATUS_PREFIX} `))
        .map((line) => {
            const fields = line
                .slice(GPG_STATUS_PREFIX.length + 1)
                .trim()
                .split(/\s+/);
            return {
                name: fields[0],
                arguments: fields.slice(1),
            };
        });
}

async function resolveLinuxBundleFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const bundlePaths = entries
        .filter(
            (entry) =>
                entry.isFile() &&
                LINUX_BUNDLE_SUFFIXES.some((suffix) =>
                    entry.name.endsWith(suffix),
                ),
        )
        .map((entry) => path.join(directory, entry.name))
        .sort();
    if (bundlePaths.length === 0) {
        throw new Error(`No Linux release bundles found under ${directory}.`);
    }
    return bundlePaths;
}

function assertLinuxHost() {
    if (process.platform !== "linux") {
        throw new Error("Linux GPG release signing requires a Linux host.");
    }
}

const isMainModule =
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
    await main();
}
