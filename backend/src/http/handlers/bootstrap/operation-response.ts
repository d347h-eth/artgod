import { PassThrough } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
    BOOTSTRAP_STREAM_CONTENT_TYPE,
    BOOTSTRAP_STREAM_RECORD as RecordType,
    BOOTSTRAP_OUTPUT_STATUS as Status,
    BOOTSTRAP_OUTPUT_STEP as Step,
    BOOTSTRAP_STREAM_MAX_RECORD_BYTES,
    BOOTSTRAP_OPERATION,
    BOOTSTRAP_QUEUE_RESPONSE_UNAVAILABLE_MESSAGE,
    type BootstrapOperation,
    type BootstrapOutputReporter,
    type BootstrapStreamRecord,
} from "@artgod/shared/bootstrap/operation-output";
import { mapApiError } from "../../common/error-handlers.js";

/** Request-scoped output; no jobs, replay service or alternate auth boundary. */
export function bootstrapOperationResponse<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: BootstrapOperation,
    run: (report?: BootstrapOutputReporter) => T | Promise<T>,
): Promise<T> | FastifyReply {
    if (
        !request.headers.accept
            ?.split(",")
            .some((value) => value.trim() === BOOTSTRAP_STREAM_CONTENT_TYPE)
    )
        return Promise.resolve().then(() => run());

    const stream = new PassThrough();
    reply.raw.once("close", () => stream.destroy());
    let sequence = 0;
    const write = (record: BootstrapStreamRecord<T>) => {
        if (stream.destroyed || stream.writableEnded) return;
        const line = JSON.stringify(record) + "\n";
        // A slow/disconnected reader cannot grow an unbounded server-side buffer.
        if (
            Buffer.byteLength(line) + stream.writableLength >
            BOOTSTRAP_STREAM_MAX_RECORD_BYTES
        ) {
            stream.destroy(
                new Error("Bootstrap output exceeded its buffer limit"),
            );
            return;
        }
        stream.write(line);
    };
    const report: BootstrapOutputReporter = (output) =>
        write({
            ...output,
            type: RecordType.Progress,
            operation,
            sequence: ++sequence,
            timestamp: new Date().toISOString(),
        });
    reply.header(
        "content-type",
        `${BOOTSTRAP_STREAM_CONTENT_TYPE}; charset=utf-8`,
    );
    reply.header("cache-control", "no-store");
    // Sending a Node stream keeps Fastify's security hooks and response lifecycle.
    reply.send(stream);
    void Promise.resolve().then(async () => {
        report({
            step: Step.Operation,
            status: Status.Started,
            message: operation,
        });
        try {
            const result = await run(report);
            report({
                step: Step.Operation,
                status: Status.Completed,
                message: `${operation} finished`,
            });
            write({ type: RecordType.Result, result });
        } catch (error) {
            const failure = mapApiError(error, request.url);
            if (failure.statusCode === 500)
                failure.message =
                    operation === BOOTSTRAP_OPERATION.Queue
                        ? BOOTSTRAP_QUEUE_RESPONSE_UNAVAILABLE_MESSAGE
                        : `${operation} failed. Check the preceding output and retry ${operation}.`;
            report({
                step: Step.Operation,
                status: Status.Failed,
                message: failure.message,
            });
            write({ type: RecordType.Error, ...failure });
        } finally {
            stream.end();
        }
    });
    return reply;
}
