import {
    BOOTSTRAP_STREAM_RECORD as RecordType,
    BOOTSTRAP_STREAM_MAX_RECORD_BYTES,
    BOOTSTRAP_OUTPUT_STATUS,
    BOOTSTRAP_OUTPUT_STEP,
    BOOTSTRAP_OPERATION,
    type BootstrapProgressRecord,
    type BootstrapStreamRecord,
} from "./operation-output.js";

export class BootstrapStreamError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

/** Incremental framing survives split UTF-8/JSON and never evaluates response text. */
export async function readBootstrapStream<T>(
    response: Response,
    onOutput: (record: BootstrapProgressRecord) => void,
): Promise<T> {
    if (!response.body)
        throw new BootstrapStreamError(
            "No operation output received. Retry the action.",
            502,
        );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let pendingBytes = 0;
    let sequence = 0;
    let terminal: BootstrapStreamRecord<T> | null = null;
    const consume = (line: string) => {
        if (!line.trim()) return;
        if (terminal) throw new Error("Output after completion");
        const record = JSON.parse(line) as BootstrapStreamRecord<T>;
        if (record.type === RecordType.Progress) {
            if (
                record.sequence !== sequence + 1 ||
                typeof record.message !== "string" ||
                typeof record.timestamp !== "string" ||
                !Object.values(BOOTSTRAP_OPERATION).includes(
                    record.operation,
                ) ||
                !Object.values(BOOTSTRAP_OUTPUT_STATUS).includes(
                    record.status,
                ) ||
                !Object.values(BOOTSTRAP_OUTPUT_STEP).includes(record.step) ||
                (record.url !== undefined && typeof record.url !== "string") ||
                (record.text !== undefined && typeof record.text !== "string")
            )
                throw new Error("Invalid progress record");
            sequence = record.sequence;
            onOutput(record);
        } else if (record.type === RecordType.Result && "result" in record)
            terminal = record;
        else if (
            record.type === RecordType.Error &&
            typeof record.message === "string" &&
            Number.isInteger(record.statusCode)
        )
            terminal = record;
        else throw new Error("Invalid operation record");
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (value) {
                let segmentStart = 0;
                for (let index = 0; index < value.byteLength; index++) {
                    if (value[index] !== 10) continue;
                    pendingBytes += index - segmentStart;
                    if (pendingBytes > BOOTSTRAP_STREAM_MAX_RECORD_BYTES)
                        throw new Error("Output record too large");
                    pendingBytes = 0;
                    segmentStart = index + 1;
                }
                pendingBytes += value.byteLength - segmentStart;
                if (pendingBytes > BOOTSTRAP_STREAM_MAX_RECORD_BYTES)
                    throw new Error("Output record too large");
            }
            pending += done
                ? decoder.decode()
                : decoder.decode(value, { stream: true });
            let newline: number;
            while ((newline = pending.indexOf("\n")) >= 0) {
                if (newline > BOOTSTRAP_STREAM_MAX_RECORD_BYTES)
                    throw new Error("Output record too large");
                consume(pending.slice(0, newline));
                pending = pending.slice(newline + 1);
            }
            if (pending.length > BOOTSTRAP_STREAM_MAX_RECORD_BYTES)
                throw new Error("Output record too large");
            if (done) break;
        }
        // A terminal record must itself be complete, including its line delimiter.
        if (pending.trim() || !terminal)
            throw new Error("Incomplete operation output");
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
            throw error;
        throw new BootstrapStreamError(
            "Operation output was interrupted. Retry the action.",
            502,
        );
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    const completed = terminal as BootstrapStreamRecord<T>;
    if (completed.type === RecordType.Error)
        throw new BootstrapStreamError(completed.message, completed.statusCode);
    if (completed.type !== RecordType.Result)
        throw new BootstrapStreamError(
            "Operation did not finish. Retry the action.",
            502,
        );
    return completed.result;
}
