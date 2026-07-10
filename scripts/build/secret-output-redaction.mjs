import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const REDACTED_VALUE = "[REDACTED]";
const MINIMUM_REDACTION_VALUE_LENGTH = 4;
const DEFAULT_COMMAND_TERMINATION_GRACE_MS = 5 * 1000;
const BROKEN_PIPE_ERROR_CODE = "EPIPE";
const DERIVED_CREDENTIAL_REDACTIONS = [
    {
        pattern: /(authorization[\t ]*:[\t ]*)[^\r\n]+/gi,
        replacement: `$1${REDACTED_VALUE}`,
    },
    {
        pattern: /\bbearer[\t ]+[a-z0-9._~+/=-]+/gi,
        replacement: `Bearer ${REDACTED_VALUE}`,
    },
    {
        pattern: /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi,
        replacement: REDACTED_VALUE,
    },
];

// Keeps raw command output private while exposing a sanitized failure message.
export class RedactedCommandError extends Error {
    #result;

    constructor(message, result) {
        super(message);
        this.#result = result;
    }

    readRawResult() {
        return this.#result;
    }
}

// Redacts complete secret values and their common serialized forms.
export function createSecretRedactor(secretValues) {
    const redactionValues = collectRedactionValues(secretValues);
    const redactDerivedCredentials = (value) => {
        let redacted = String(value);
        for (const { pattern, replacement } of DERIVED_CREDENTIAL_REDACTIONS) {
            redacted = redacted.replace(pattern, replacement);
        }
        return redacted;
    };

    return Object.freeze({
        redact(value) {
            let redacted = redactDerivedCredentials(value);
            for (const secretValue of redactionValues) {
                redacted = redacted.split(secretValue).join(REDACTED_VALUE);
            }
            return redacted;
        },
        redactDerivedCredentials,
        hasSecretValues() {
            return redactionValues.length > 0;
        },
        findCompletePrefix(value) {
            return redactionValues.find((secretValue) =>
                value.startsWith(secretValue),
            );
        },
        isPossiblePrefix(value) {
            return redactionValues.some((secretValue) =>
                secretValue.startsWith(value),
            );
        },
    });
}

const EMPTY_SECRET_REDACTOR = createSecretRedactor([]);

// Extracts overlapping payload fragments so line wrapping cannot expose a key.
export function collectSensitivePayloadFragments(value, windowLength) {
    const payloadTokens = String(value)
        .split(/\s+/)
        .filter(
            (token) =>
                token.length >= windowLength && /^[a-z0-9+/=]+$/i.test(token),
        );
    const payload = payloadTokens.join("");
    const payloadWindows = [];
    for (let index = 0; index <= payload.length - windowLength; index += 1) {
        payloadWindows.push(payload.slice(index, index + windowLength));
    }
    return [...payloadTokens, ...payloadWindows];
}

// Streams text only after derived and exact credentials have been removed.
export function createRedactedOutputWriter(target, redactor) {
    let linePending = "";
    let exactPending = "";

    const drainExactValues = (final) => {
        let publicOutput = "";
        while (exactPending) {
            const completeMatch = redactor.findCompletePrefix(exactPending);
            const possibleMatch = redactor.isPossiblePrefix(exactPending);

            if (!final && possibleMatch) {
                break;
            }
            if (completeMatch) {
                publicOutput += REDACTED_VALUE;
                exactPending = exactPending.slice(completeMatch.length);
                continue;
            }
            if (final && redactor.isPossiblePrefix(exactPending)) {
                publicOutput += REDACTED_VALUE;
                exactPending = "";
                break;
            }

            publicOutput += exactPending[0];
            exactPending = exactPending.slice(1);
        }
        if (publicOutput) {
            target.write(publicOutput);
        }
    };
    const flushCompleteLines = () => {
        const completeLineEnd = Math.max(
            linePending.lastIndexOf("\n"),
            linePending.lastIndexOf("\r"),
        );
        if (completeLineEnd < 0) {
            return;
        }
        exactPending += redactor.redactDerivedCredentials(
            linePending.slice(0, completeLineEnd + 1),
        );
        linePending = linePending.slice(completeLineEnd + 1);
        drainExactValues(false);
    };

    return {
        write(chunk) {
            linePending += chunk.toString();
            flushCompleteLines();
        },
        end() {
            exactPending += redactor.redactDerivedCredentials(linePending);
            linePending = "";
            drainExactValues(true);
        },
    };
}

// Persists diagnostics only after removing every known credential form.
export async function writeRedactedTextFile(filePath, value, redactor) {
    await writeFile(filePath, redactor.redact(value), "utf8");
}

// Executes a child process while keeping raw output internal and public output redacted.
export async function runRedactedCommand(command, args, options = {}) {
    const stream = options.stream === true;
    const timeoutMs = options.timeoutMs;
    const redactor = options.redactor ?? EMPTY_SECRET_REDACTOR;
    const stdoutWriter = stream
        ? createRedactedOutputWriter(
              options.stdoutTarget ?? process.stdout,
              redactor,
          )
        : null;
    const stderrWriter = stream
        ? createRedactedOutputWriter(
              options.stderrTarget ?? process.stderr,
              redactor,
          )
        : null;

    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            stdio: [
                options.input === undefined ? "ignore" : "pipe",
                "pipe",
                "pipe",
            ],
        });

        let stdout = "";
        let stderr = "";
        let combinedOutput = "";
        let timedOut = false;
        let stdinError;
        let forceKillTimer;
        let outputWritersEnded = false;
        const commandTimeoutTimer = timeoutMs
            ? setTimeout(() => {
                  timedOut = true;
                  child.kill("SIGTERM");
                  forceKillTimer = setTimeout(() => {
                      child.kill("SIGKILL");
                  }, options.terminationGraceMs ?? DEFAULT_COMMAND_TERMINATION_GRACE_MS);
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
        const endOutputWriters = () => {
            if (outputWritersEnded) {
                return;
            }
            outputWritersEnded = true;
            stdoutWriter?.end();
            stderrWriter?.end();
        };
        child.stdout.on("data", (chunk) => {
            const output = chunk.toString();
            stdout += output;
            combinedOutput += output;
            stdoutWriter?.write(output);
        });
        child.stderr.on("data", (chunk) => {
            const output = chunk.toString();
            stderr += output;
            combinedOutput += output;
            stderrWriter?.write(output);
        });
        child.stdin?.on("error", (error) => {
            if (error.code !== BROKEN_PIPE_ERROR_CODE) {
                stdinError = error;
            }
        });

        child.on("error", (error) => {
            clearCommandTimers();
            endOutputWriters();
            reject(
                new RedactedCommandError(redactor.redact(error.message), {
                    stdout,
                    stderr,
                    combinedOutput,
                }),
            );
        });
        child.on("close", (code) => {
            clearCommandTimers();
            endOutputWriters();
            const result = { stdout, stderr, combinedOutput };
            if (stdinError) {
                reject(
                    new RedactedCommandError(
                        redactor.redact(stdinError.message),
                        result,
                    ),
                );
                return;
            }
            if (code === 0) {
                resolve(result);
                return;
            }
            reject(
                new RedactedCommandError(
                    redactor.redact(
                        timedOut
                            ? `${formatCommand(command, args)} timed out after ${timeoutMs}ms`
                            : `${formatCommand(command, args)} failed with exit code ${code}${stderr ? `\n${stderr}` : ""}`,
                    ),
                    result,
                ),
            );
        });

        if (options.input !== undefined) {
            child.stdin.end(options.input);
        }
    });
}

function collectRedactionValues(secretValues) {
    const redactionValues = new Set();
    const addValue = (value) => {
        if (typeof value !== "string" || value.length === 0) {
            return;
        }
        redactionValues.add(value);
    };

    for (const sourceValue of secretValues) {
        if (typeof sourceValue !== "string") {
            continue;
        }
        for (const value of new Set([sourceValue, sourceValue.trim()])) {
            if (value.length === 0) {
                continue;
            }
            if (value.length < MINIMUM_REDACTION_VALUE_LENGTH) {
                throw new Error(
                    `Refusing to redact a non-empty secret shorter than ${MINIMUM_REDACTION_VALUE_LENGTH} characters.`,
                );
            }
            addValue(value);
            addValue(encodeURIComponent(value));
            addValue(JSON.stringify(value).slice(1, -1));
            addValue(Buffer.from(value, "utf8").toString("base64"));
            if (/^[a-z0-9-]+$/i.test(value)) {
                addValue(value.toLowerCase());
                addValue(value.toUpperCase());
            }
        }
    }

    return [...redactionValues].sort(
        (left, right) => right.length - left.length,
    );
}

function formatCommand(command, args) {
    return `${command} ${args.join(" ")}`;
}
