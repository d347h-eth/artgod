import { execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const NATIVE_FAILURE_ARTIFACT = "native-failure.json";
export const NATIVE_FAILURE_POLICY = Object.freeze({
    timeoutMs: 2_000,
    kernelBytes: 65_536,
    procBytes: 8_192,
    errorBytes: 1_024,
});

const EXECUTABLE = "/bin/busybox";
const FILES = Object.freeze({
    CorePattern: "/proc/sys/kernel/core_pattern",
    CoreUsesPid: "/proc/sys/kernel/core_uses_pid",
});

function boundedText(value, maximumBytes) {
    const bytes = Buffer.isBuffer(value)
        ? value
        : Buffer.from(String(value ?? ""), "utf8");
    return {
        // Leave an incomplete trailing UTF-8 sequence buffered rather than
        // expanding it into replacement characters beyond the byte ceiling.
        text: new StringDecoder("utf8").write(bytes.subarray(0, maximumBytes)),
        truncated: bytes.length > maximumBytes,
    };
}

/** Read private guest kernel/proc evidence; never enable cores or mutate sysctls.
 * Node's execFile owns timeout, output bounds and child termination. Importing
 * the host QEMU executable here would also import its controller signal policy.
 */
export async function captureGuestNativeFailure({
    executeFile = execFile,
} = {}) {
    const capture = (args, maximumBytes) =>
        new Promise((resolve) => {
            const complete = (error, stdout, stderr) => {
                const out = boundedText(stdout, maximumBytes);
                const err = boundedText(stderr, maximumBytes);
                const outputLimit =
                    error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
                    out.truncated ||
                    err.truncated;
                resolve({
                    executable: EXECUTABLE,
                    args,
                    code: error
                        ? typeof error.code === "number"
                            ? error.code
                            : null
                        : 0,
                    signal: error?.signal ?? null,
                    timedOut: error?.killed === true && !outputLimit,
                    outputLimit,
                    stdout: out.text,
                    stderr: err.text,
                    ...(error
                        ? {
                              error: {
                                  code: error.code ?? null,
                                  message: boundedText(
                                      error.message,
                                      NATIVE_FAILURE_POLICY.errorBytes,
                                  ).text,
                              },
                          }
                        : {}),
                });
            };
            try {
                executeFile(
                    EXECUTABLE,
                    args,
                    {
                        encoding: "utf8",
                        timeout: NATIVE_FAILURE_POLICY.timeoutMs,
                        maxBuffer: maximumBytes,
                        killSignal: "SIGKILL",
                    },
                    complete,
                );
            } catch (error) {
                complete(error, "", "");
            }
        });
    const limitsPath = `/proc/${process.pid}/limits`;
    const [kernelRing, corePattern, coreUsesPid, resourceLimits] =
        await Promise.all([
            // SYSLOG_ACTION_READ_ALL returns the most recent bounded ring data.
            // No -c/-C option: observing the ring must not consume or clear it.
            capture(
                ["dmesg", "-s", String(NATIVE_FAILURE_POLICY.kernelBytes)],
                NATIVE_FAILURE_POLICY.kernelBytes,
            ),
            capture(
                ["cat", FILES.CorePattern],
                NATIVE_FAILURE_POLICY.procBytes,
            ),
            capture(
                ["cat", FILES.CoreUsesPid],
                NATIVE_FAILURE_POLICY.procBytes,
            ),
            // Read the coordinator's own limits, rather than the cat child's.
            capture(["cat", limitsPath], NATIVE_FAILURE_POLICY.procBytes),
        ]);
    return {
        version: 1,
        kernelRing,
        corePattern,
        coreUsesPid,
        resourceLimits: { pid: process.pid, ...resourceLimits },
    };
}
