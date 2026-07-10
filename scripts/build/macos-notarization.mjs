import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    appendFile,
    mkdir,
    readFile,
    readdir,
    stat,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);

const COMMAND_PREPARE = "prepare";
const COMMAND_SUBMIT = "submit";
const COMMAND_POLL = "poll";
const COMMAND_VALIDATE_REF = "validate-ref";
const COMMAND_FINALIZE = "finalize";

const ENV_APPLE_API_KEY_PATH = "APPLE_API_KEY_PATH";
const ENV_APPLE_API_KEY_ID = "APPLE_API_KEY_ID";
const ENV_APPLE_API_ISSUER = "APPLE_API_ISSUER";
const ENV_GITHUB_REPOSITORY = "GITHUB_REPOSITORY";
const ENV_GITHUB_REF = "GITHUB_REF";
const ENV_GITHUB_REF_NAME = "GITHUB_REF_NAME";
const ENV_GITHUB_REF_TYPE = "GITHUB_REF_TYPE";
const ENV_GITHUB_SHA = "GITHUB_SHA";
const ENV_GITHUB_RUN_ID = "GITHUB_RUN_ID";
const ENV_GITHUB_RUN_ATTEMPT = "GITHUB_RUN_ATTEMPT";
const ENV_NOTARIZATION_SOURCE_RUN_ID = "MACOS_NOTARIZATION_SOURCE_RUN_ID";

const NOTARY_OPTION_KEY = "--key";
const NOTARY_OPTION_KEY_ID = "--key-id";
const NOTARY_OPTION_ISSUER = "--issuer";
const REDACTED_VALUE = "[REDACTED]";

const STATE_SCHEMA_VERSION = 1;
const STATE_FILE_NAME = "notarization-state.json";
const ENVIRONMENT_LOG_FILE_NAME = "environment.log";
const SUBMIT_LOG_FILE_NAME = "notary-submit.log";
const POLL_LOG_FILE_NAME = "notary-poll.ndjson";
const NOTARY_LOG_FILE_NAME = "notary-result.json";

// Apple public status values used by the notary service contract.
export const NOTARY_STATUS_ACCEPTED = "Accepted";
export const NOTARY_STATUS_IN_PROGRESS = "In Progress";
export const NOTARY_STATUS_INVALID = "Invalid";
export const NOTARY_STATUS_REJECTED = "Rejected";

// GitHub's ref-type value for a release tag workflow.
export const GITHUB_REF_TYPE_TAG = "tag";

const PENDING_EXIT_CODE = 75;
const INITIAL_POLL_TIMEOUT_MS = 20 * 60 * 1000;
const RESUME_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;
const NOTARY_SUBMIT_TIMEOUT_MS = 30 * 60 * 1000;
const NOTARY_API_COMMAND_TIMEOUT_MS = 60 * 1000;
const COMMAND_TERMINATION_GRACE_MS = 5 * 1000;

class PendingNotarizationError extends Error {}

class CommandExecutionError extends Error {
    constructor(message, result) {
        super(message);
        this.result = result;
    }
}

async function main() {
    const command = process.argv[2];
    const artifactDirectory = path.resolve(
        process.argv[3] ?? path.join(rootDir, "release-assets"),
    );
    const stateDirectory = path.resolve(
        process.argv[4] ?? path.join(rootDir, "release-state", "macos"),
    );

    try {
        if (command === COMMAND_PREPARE) {
            await prepareNotarization(artifactDirectory, stateDirectory);
            return;
        }
        if (command === COMMAND_SUBMIT) {
            await submitNotarization(artifactDirectory, stateDirectory);
            return;
        }
        if (command === COMMAND_POLL) {
            await pollSubmittedNotarization(artifactDirectory, stateDirectory);
            return;
        }
        if (command === COMMAND_VALIDATE_REF) {
            assertReleaseTagRef(process.env);
            return;
        }
        if (command === COMMAND_FINALIZE) {
            await finalizeExistingNotarization(
                artifactDirectory,
                stateDirectory,
            );
            return;
        }

        throw new Error(
            `Usage: node scripts/build/macos-notarization.mjs <${COMMAND_PREPARE}|${COMMAND_SUBMIT}|${COMMAND_POLL}|${COMMAND_VALIDATE_REF}|${COMMAND_FINALIZE}> [artifact-directory] [state-directory]`,
        );
    } catch (error) {
        if (error instanceof PendingNotarizationError) {
            console.error(error.message);
            process.exitCode = PENDING_EXIT_CODE;
            return;
        }
        throw error;
    }
}

async function prepareNotarization(artifactDirectory, stateDirectory) {
    assertMacOSHost();

    const dmgPath = await resolveSingleDmg(artifactDirectory);
    await mkdir(stateDirectory, { recursive: true });

    const artifact = await readArtifactMetadata(dmgPath);
    const state = {
        schemaVersion: STATE_SCHEMA_VERSION,
        artifact,
        source: readReleaseSource(process.env),
        submission: null,
        stapledArtifact: null,
        updatedAt: new Date().toISOString(),
    };
    await writeState(stateDirectory, state);

    const environmentLogPath = path.join(
        stateDirectory,
        ENVIRONMENT_LOG_FILE_NAME,
    );
    await writeFile(environmentLogPath, "", "utf8");

    for (const [command, args] of [
        ["sw_vers", []],
        ["xcodebuild", ["-version"]],
        ["xcrun", ["notarytool", "--version"]],
        ["hdiutil", ["verify", dmgPath]],
        ["codesign", ["--verify", "--strict", "--verbose=4", dmgPath]],
    ]) {
        const result = await runCommand(command, args, { stream: true });
        await appendFile(
            environmentLogPath,
            formatCommandTranscript(command, args, result),
            "utf8",
        );
    }

    console.log(
        `Prepared macOS notarization input ${artifact.name}: ${artifact.sizeBytes} bytes, SHA-256 ${artifact.sha256}`,
    );
}

async function submitNotarization(artifactDirectory, stateDirectory) {
    assertMacOSHost();

    const dmgPath = await resolveSingleDmg(artifactDirectory);
    const state = await readState(stateDirectory);
    await assertArtifactMatchesState(dmgPath, state);
    if (state.submission?.id) {
        throw new Error(
            `Refusing to create a duplicate notarization submission; state already contains ${state.submission.id}.`,
        );
    }

    const authArgs = readNotaryAuthentication(process.env);
    let submitResult;
    try {
        // Submit once and persist the returned ID before any status polling.
        submitResult = await runCommand(
            "xcrun",
            ["notarytool", "submit", dmgPath, ...authArgs, "--verbose"],
            { stream: true, timeoutMs: NOTARY_SUBMIT_TIMEOUT_MS },
        );
    } catch (error) {
        if (error instanceof CommandExecutionError) {
            const redactedOutput = redactNotarySecrets(
                error.result.combinedOutput,
                process.env,
            );
            await writeFile(
                path.join(stateDirectory, SUBMIT_LOG_FILE_NAME),
                redactedOutput,
                "utf8",
            );
            const recoveredSubmissionId = tryParseSubmissionId(
                error.result.combinedOutput,
            );
            if (recoveredSubmissionId) {
                state.submission = createSubmissionState(recoveredSubmissionId);
                await writeState(stateDirectory, state);
                console.error(
                    `Recovered Apple submission ${recoveredSubmissionId} from failed notarytool output; do not resubmit this DMG.`,
                );
            }
        }
        throw error;
    }
    await writeFile(
        path.join(stateDirectory, SUBMIT_LOG_FILE_NAME),
        redactNotarySecrets(submitResult.combinedOutput, process.env),
        "utf8",
    );

    const submissionId = parseSubmissionId(submitResult.combinedOutput);
    state.submission = createSubmissionState(submissionId);
    await writeState(stateDirectory, state);

    console.log(`Created Apple notarization submission ${submissionId}.`);
}

async function pollSubmittedNotarization(artifactDirectory, stateDirectory) {
    assertMacOSHost();

    const dmgPath = await resolveSingleDmg(artifactDirectory);
    const state = await readState(stateDirectory);
    assertResumeContext(state, {
        repository: requireEnvironmentValue(process.env, ENV_GITHUB_REPOSITORY),
        refName: requireEnvironmentValue(process.env, ENV_GITHUB_REF_NAME),
        refType: requireEnvironmentValue(process.env, ENV_GITHUB_REF_TYPE),
        sha: requireEnvironmentValue(process.env, ENV_GITHUB_SHA),
        sourceRunId: requireEnvironmentValue(process.env, ENV_GITHUB_RUN_ID),
    });
    await assertArtifactMatchesState(dmgPath, state);

    if (!state.submission?.id) {
        throw new Error(
            "Notarization state does not contain an Apple submission ID.",
        );
    }

    await pollAndFinalize({
        dmgPath,
        state,
        stateDirectory,
        authArgs: readNotaryAuthentication(process.env),
        timeoutMs: INITIAL_POLL_TIMEOUT_MS,
    });
}

async function finalizeExistingNotarization(artifactDirectory, stateDirectory) {
    assertMacOSHost();

    const dmgPath = await resolveSingleDmg(artifactDirectory);
    const state = await readState(stateDirectory);
    assertResumeContext(state, {
        repository: requireEnvironmentValue(process.env, ENV_GITHUB_REPOSITORY),
        refName: requireEnvironmentValue(process.env, ENV_GITHUB_REF_NAME),
        refType: requireEnvironmentValue(process.env, ENV_GITHUB_REF_TYPE),
        sha: requireEnvironmentValue(process.env, ENV_GITHUB_SHA),
        sourceRunId: requireEnvironmentValue(
            process.env,
            ENV_NOTARIZATION_SOURCE_RUN_ID,
        ),
    });
    await assertArtifactMatchesState(dmgPath, state);

    if (!state.submission?.id) {
        throw new Error(
            "Notarization state does not contain an Apple submission ID.",
        );
    }

    await pollAndFinalize({
        dmgPath,
        state,
        stateDirectory,
        authArgs: readNotaryAuthentication(process.env),
        timeoutMs: RESUME_POLL_TIMEOUT_MS,
    });
}

async function pollAndFinalize({
    dmgPath,
    state,
    stateDirectory,
    authArgs,
    timeoutMs,
}) {
    const submissionId = state.submission.id;
    const deadline = Date.now() + timeoutMs;
    const pollLogPath = path.join(stateDirectory, POLL_LOG_FILE_NAME);

    while (true) {
        const checkedAt = new Date().toISOString();
        let info;
        try {
            // Query the existing submission so transient polling failures never resubmit.
            const infoResult = await runCommand(
                "xcrun",
                [
                    "notarytool",
                    "info",
                    submissionId,
                    ...authArgs,
                    "--output-format",
                    "json",
                ],
                { stream: true, timeoutMs: NOTARY_API_COMMAND_TIMEOUT_MS },
            );
            info = JSON.parse(infoResult.stdout);
        } catch (error) {
            await appendPollRecord(pollLogPath, {
                checkedAt,
                error: formatError(error, process.env),
            });
            console.error(
                `Unable to query notarization ${submissionId}; polling will retry. ${formatError(error, process.env)}`,
            );
        }

        if (info) {
            const status = readNotaryStatus(info);
            state.submission.status = status;
            state.submission.lastCheckedAt = checkedAt;
            await writeState(stateDirectory, state);
            await appendPollRecord(pollLogPath, {
                checkedAt,
                status,
                info,
            });

            if (status === NOTARY_STATUS_ACCEPTED) {
                await verifyAcceptedSubmissionAndStaple({
                    dmgPath,
                    state,
                    stateDirectory,
                    authArgs,
                });
                return;
            }
            if (
                status === NOTARY_STATUS_INVALID ||
                status === NOTARY_STATUS_REJECTED
            ) {
                await fetchNotaryLog(submissionId, authArgs, stateDirectory);
                throw new Error(
                    `Apple notarization ${submissionId} completed with status ${status}.`,
                );
            }
            if (status !== NOTARY_STATUS_IN_PROGRESS) {
                throw new Error(
                    `Apple notarization ${submissionId} returned unknown status ${JSON.stringify(status)}.`,
                );
            }
        }

        if (Date.now() >= deadline) {
            throw new PendingNotarizationError(
                `Apple notarization ${submissionId} is still pending. Preserve the notarization input/state artifacts and resume this release from the same tag with source run ${state.source.runId}.`,
            );
        }
        await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    }
}

async function verifyAcceptedSubmissionAndStaple({
    dmgPath,
    state,
    stateDirectory,
    authArgs,
}) {
    // Compare Apple's terminal log with the preserved pre-staple DMG.
    const notaryLog = await fetchNotaryLog(
        state.submission.id,
        authArgs,
        stateDirectory,
    );
    assertAcceptedNotaryLog(notaryLog, {
        submissionId: state.submission.id,
        artifactName: state.artifact.name,
        sha256: state.artifact.sha256,
    });

    // Attach and validate Apple's ticket on the same DMG that was submitted.
    await runCommand("xcrun", ["stapler", "staple", "-v", dmgPath], {
        stream: true,
    });
    await runCommand("xcrun", ["stapler", "validate", "-v", dmgPath], {
        stream: true,
    });
    await runCommand(
        "spctl",
        [
            "--assess",
            "--type",
            "open",
            "--context",
            "context:primary-signature",
            "--verbose=4",
            dmgPath,
        ],
        { stream: true },
    );

    state.stapledArtifact = await readArtifactMetadata(dmgPath);
    state.updatedAt = new Date().toISOString();
    await writeState(stateDirectory, state);
    console.log(
        `Notarization ${state.submission.id} is accepted; stapled and validated ${state.artifact.name}.`,
    );
}

async function fetchNotaryLog(submissionId, authArgs, stateDirectory) {
    const result = await runCommand(
        "xcrun",
        ["notarytool", "log", submissionId, ...authArgs],
        { stream: true, timeoutMs: NOTARY_API_COMMAND_TIMEOUT_MS },
    );
    const notaryLog = JSON.parse(result.stdout);
    await writeFile(
        path.join(stateDirectory, NOTARY_LOG_FILE_NAME),
        `${JSON.stringify(notaryLog, null, 4)}\n`,
        "utf8",
    );
    return notaryLog;
}

// Extracts the stable submission identifier from notarytool human output.
export function parseSubmissionId(output) {
    const marker = "Submission ID received";
    const markerIndex = output.indexOf(marker);
    const candidateOutput =
        markerIndex >= 0 ? output.slice(markerIndex + marker.length) : output;
    const idMatch = candidateOutput.match(
        /^[\t ]*id:[\t ]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\t ]*$/im,
    );
    if (!idMatch) {
        throw new Error(
            "Unable to extract the Apple notarization submission ID from notarytool output.",
        );
    }
    return idMatch[1];
}

function tryParseSubmissionId(output) {
    try {
        return parseSubmissionId(output);
    } catch {
        return null;
    }
}

function createSubmissionState(submissionId) {
    return {
        id: submissionId,
        status: null,
        submittedAt: new Date().toISOString(),
        lastCheckedAt: null,
    };
}

// Reads Apple's public status field from a structured info response.
export function readNotaryStatus(info) {
    if (!info || typeof info.status !== "string" || !info.status.trim()) {
        throw new Error("Apple notarization info response has no status.");
    }
    return info.status.trim();
}

// Proves Apple accepted the exact prepared DMG bytes before stapling.
export function assertAcceptedNotaryLog(notaryLog, expected) {
    if (notaryLog?.jobId !== expected.submissionId) {
        throw new Error("Apple notarization log submission ID does not match.");
    }
    if (notaryLog.status !== NOTARY_STATUS_ACCEPTED) {
        throw new Error(
            `Apple notarization log status is ${JSON.stringify(notaryLog.status)}, not ${NOTARY_STATUS_ACCEPTED}.`,
        );
    }
    if (notaryLog.archiveFilename !== expected.artifactName) {
        throw new Error("Apple notarization log artifact name does not match.");
    }
    if (notaryLog.sha256?.toLowerCase() !== expected.sha256.toLowerCase()) {
        throw new Error(
            "Apple notarization log SHA-256 does not match the DMG.",
        );
    }
    if (
        notaryLog.issues !== null &&
        (!Array.isArray(notaryLog.issues) || notaryLog.issues.length > 0)
    ) {
        throw new Error("Accepted Apple notarization log contains issues.");
    }
}

// Prevents a delayed submission from being finalized under another release.
export function assertResumeContext(state, context) {
    if (
        state.source.refType !== GITHUB_REF_TYPE_TAG ||
        context.refType !== GITHUB_REF_TYPE_TAG
    ) {
        throw new Error(
            "Delayed macOS notarization must be resumed from the original release tag.",
        );
    }
    if (state.source.repository !== context.repository) {
        throw new Error("Notarization state repository does not match.");
    }
    if (state.source.refName !== context.refName) {
        throw new Error("Notarization state release tag does not match.");
    }
    if (state.source.sha !== context.sha) {
        throw new Error("Notarization state release commit does not match.");
    }
    if (state.source.runId !== context.sourceRunId) {
        throw new Error(
            "Notarization state source workflow run does not match.",
        );
    }
}

function readReleaseSource(environment) {
    return {
        repository: requireEnvironmentValue(environment, ENV_GITHUB_REPOSITORY),
        ref: requireEnvironmentValue(environment, ENV_GITHUB_REF),
        refName: requireEnvironmentValue(environment, ENV_GITHUB_REF_NAME),
        refType: requireEnvironmentValue(environment, ENV_GITHUB_REF_TYPE),
        sha: requireEnvironmentValue(environment, ENV_GITHUB_SHA),
        runId: requireEnvironmentValue(environment, ENV_GITHUB_RUN_ID),
        runAttempt: requireEnvironmentValue(
            environment,
            ENV_GITHUB_RUN_ATTEMPT,
        ),
        runnerImage: environment.ImageOS?.trim() || null,
        runnerImageVersion: environment.ImageVersion?.trim() || null,
    };
}

function readNotaryAuthentication(environment) {
    return [
        NOTARY_OPTION_KEY,
        requireEnvironmentValue(environment, ENV_APPLE_API_KEY_PATH),
        NOTARY_OPTION_KEY_ID,
        requireEnvironmentValue(environment, ENV_APPLE_API_KEY_ID),
        NOTARY_OPTION_ISSUER,
        requireEnvironmentValue(environment, ENV_APPLE_API_ISSUER),
    ];
}

function requireEnvironmentValue(environment, key) {
    const value = environment[key]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable ${key}.`);
    }
    return value;
}

function assertReleaseTagRef(environment) {
    const refType = requireEnvironmentValue(environment, ENV_GITHUB_REF_TYPE);
    if (refType !== GITHUB_REF_TYPE_TAG) {
        throw new Error(
            "Select the original release tag, not a branch, when resuming macOS notarization.",
        );
    }
    console.log(
        `Validated delayed notarization release tag ${requireEnvironmentValue(environment, ENV_GITHUB_REF_NAME)}.`,
    );
}

async function resolveSingleDmg(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const dmgPaths = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".dmg"))
        .map((entry) => path.join(directory, entry.name));
    if (dmgPaths.length !== 1) {
        throw new Error(
            `Expected exactly one DMG under ${directory}, found ${dmgPaths.length}.`,
        );
    }
    return dmgPaths[0];
}

async function readArtifactMetadata(filePath) {
    const fileStat = await stat(filePath);
    return {
        name: path.basename(filePath),
        sizeBytes: fileStat.size,
        sha256: await hashFile(filePath),
    };
}

async function hashFile(filePath) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}

async function assertArtifactMatchesState(dmgPath, state) {
    if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
        throw new Error(
            `Unsupported notarization state schema ${JSON.stringify(state.schemaVersion)}.`,
        );
    }
    const actual = await readArtifactMetadata(dmgPath);
    if (
        actual.name !== state.artifact.name ||
        actual.sizeBytes !== state.artifact.sizeBytes ||
        actual.sha256 !== state.artifact.sha256
    ) {
        throw new Error(
            "Preserved DMG does not match the prepared notarization state.",
        );
    }
}

async function readState(stateDirectory) {
    return JSON.parse(
        await readFile(path.join(stateDirectory, STATE_FILE_NAME), "utf8"),
    );
}

async function writeState(stateDirectory, state) {
    state.updatedAt = new Date().toISOString();
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
        path.join(stateDirectory, STATE_FILE_NAME),
        `${JSON.stringify(state, null, 4)}\n`,
        "utf8",
    );
}

async function appendPollRecord(filePath, record) {
    await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function assertMacOSHost() {
    if (process.platform !== "darwin") {
        throw new Error("macOS notarization commands require a macOS host.");
    }
}

function formatCommandTranscript(command, args, result) {
    return [`$ ${command} ${args.join(" ")}`, result.combinedOutput, ""].join(
        "\n",
    );
}

function formatError(error, environment) {
    return redactNotarySecrets(
        error instanceof Error ? error.message : String(error),
        environment,
    );
}

function redactNotarySecrets(value, environment) {
    let redacted = value;
    for (const key of [
        ENV_APPLE_API_KEY_PATH,
        ENV_APPLE_API_KEY_ID,
        ENV_APPLE_API_ISSUER,
    ]) {
        const secretValue = environment[key]?.trim();
        if (secretValue) {
            redacted = redacted.split(secretValue).join(REDACTED_VALUE);
        }
    }
    return redacted;
}

function formatCommand(command, args) {
    const displayArgs = [...args];
    for (let index = 0; index < displayArgs.length - 1; index += 1) {
        if (
            displayArgs[index] === NOTARY_OPTION_KEY ||
            displayArgs[index] === NOTARY_OPTION_KEY_ID ||
            displayArgs[index] === NOTARY_OPTION_ISSUER
        ) {
            displayArgs[index + 1] = REDACTED_VALUE;
            index += 1;
        }
    }
    return `${command} ${displayArgs.join(" ")}`;
}

async function runCommand(command, args, options = {}) {
    const stream = options.stream === true;
    const timeoutMs = options.timeoutMs;
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: rootDir,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let combinedOutput = "";
        let timedOut = false;
        let forceKillTimer;
        const commandTimeoutTimer = timeoutMs
            ? setTimeout(() => {
                  timedOut = true;
                  child.kill("SIGTERM");
                  forceKillTimer = setTimeout(() => {
                      child.kill("SIGKILL");
                  }, COMMAND_TERMINATION_GRACE_MS);
              }, timeoutMs)
            : null;
        const clearCommandTimers = () => {
            if (commandTimeoutTimer) {
                clearTimeout(commandTimeoutTimer);
            }
            if (forceKillTimer) {
                clearTimeout(forceKillTimer);
            }
        };
        child.stdout.on("data", (chunk) => {
            const value = chunk.toString();
            stdout += value;
            combinedOutput += value;
            if (stream) {
                process.stdout.write(value);
            }
        });
        child.stderr.on("data", (chunk) => {
            const value = chunk.toString();
            stderr += value;
            combinedOutput += value;
            if (stream) {
                process.stderr.write(value);
            }
        });

        child.on("error", (error) => {
            clearCommandTimers();
            reject(error);
        });
        child.on("close", (code) => {
            clearCommandTimers();
            const result = { stdout, stderr, combinedOutput };
            if (code === 0) {
                resolve(result);
                return;
            }
            reject(
                new CommandExecutionError(
                    timedOut
                        ? `${formatCommand(command, args)} timed out after ${timeoutMs}ms`
                        : `${formatCommand(command, args)} failed with exit code ${code}${stderr ? `\n${stderr}` : ""}`,
                    result,
                ),
            );
        });
    });
}

const isMainModule =
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
    await main();
}
