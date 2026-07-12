import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import {
    resolveSecretEnvelopeFrameLength,
    SECRET_ENVELOPE_HEADER_LENGTH,
} from "./secret-envelope.js";

export type ParentSecretChannelFailureHandler = (error: Error) => void;

export type ParentSecretChannel = Readonly<{
    envelope: Buffer;
    releaseAfterCleanup(): void;
}>;

/** Reads one exact secret frame while retaining stdin as the parent liveness channel. */
export function readSecretEnvelopeFromParent(
    input: Readable,
    onParentChannelFailure: ParentSecretChannelFailureHandler,
): Promise<ParentSecretChannel> {
    return new Promise<ParentSecretChannel>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let bufferedLength = 0;
        let expectedFrameLength: number | null = null;
        let envelopeDelivered = false;
        let channelTerminated = false;

        const wipeChunks = (): void => {
            for (const chunk of chunks) {
                chunk.fill(0);
            }
            chunks.length = 0;
            bufferedLength = 0;
        };

        const detachListeners = (): void => {
            input.off("data", onData);
            input.off("end", onEnd);
            input.off("error", onError);
            input.off("close", onClose);
        };

        const rejectBeforeDelivery = (error: Error): void => {
            if (channelTerminated) {
                return;
            }
            channelTerminated = true;
            detachListeners();
            input.pause();
            wipeChunks();
            reject(error);
        };

        const failAfterDelivery = (error: Error): void => {
            if (channelTerminated) {
                return;
            }
            channelTerminated = true;
            detachListeners();
            input.pause();
            onParentChannelFailure(error);
        };

        const releaseAfterCleanup = (): void => {
            if (channelTerminated) {
                return;
            }
            channelTerminated = true;
            detachListeners();
            input.pause();
        };

        const resolveExpectedFrameLength = (): number | null => {
            if (bufferedLength < SECRET_ENVELOPE_HEADER_LENGTH) {
                return null;
            }

            const header = Buffer.alloc(SECRET_ENVELOPE_HEADER_LENGTH);
            let copiedLength = 0;
            for (const chunk of chunks) {
                const remainingLength =
                    SECRET_ENVELOPE_HEADER_LENGTH - copiedLength;
                if (remainingLength === 0) {
                    break;
                }
                copiedLength += chunk.copy(
                    header,
                    copiedLength,
                    0,
                    Math.min(chunk.length, remainingLength),
                );
            }

            try {
                return resolveSecretEnvelopeFrameLength(header);
            } finally {
                header.fill(0);
            }
        };

        const onData = (chunk: Buffer | string): void => {
            const incoming = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk);

            if (channelTerminated) {
                incoming.fill(0);
                return;
            }
            if (envelopeDelivered) {
                incoming.fill(0);
                failAfterDelivery(
                    new Error(
                        "Parent secret channel contains data after the complete frame",
                    ),
                );
                return;
            }
            if (incoming.length === 0) {
                return;
            }

            chunks.push(incoming);
            bufferedLength += incoming.length;

            try {
                expectedFrameLength ??= resolveExpectedFrameLength();
            } catch (error) {
                rejectBeforeDelivery(toError(error));
                return;
            }

            if (expectedFrameLength === null) {
                return;
            }
            if (bufferedLength > expectedFrameLength) {
                rejectBeforeDelivery(
                    new Error(
                        "Parent secret channel contains data after the complete frame",
                    ),
                );
                return;
            }
            if (bufferedLength < expectedFrameLength) {
                return;
            }

            const envelopeBuffer = Buffer.concat(chunks, expectedFrameLength);
            wipeChunks();
            envelopeDelivered = true;
            resolve({ envelope: envelopeBuffer, releaseAfterCleanup });
        };

        const onEnd = (): void => {
            if (envelopeDelivered) {
                failAfterDelivery(
                    new Error("Parent secret channel closed unexpectedly"),
                );
                return;
            }
            rejectBeforeDelivery(
                new Error(
                    bufferedLength === 0
                        ? "Secret envelope is missing"
                        : "Secret envelope is truncated",
                ),
            );
        };

        const onError = (error: Error): void => {
            const channelError = new Error("Parent secret channel failed", {
                cause: error,
            });
            if (envelopeDelivered) {
                failAfterDelivery(channelError);
                return;
            }
            rejectBeforeDelivery(channelError);
        };

        const onClose = (): void => {
            if (envelopeDelivered) {
                failAfterDelivery(
                    new Error("Parent secret channel closed unexpectedly"),
                );
                return;
            }
            rejectBeforeDelivery(new Error("Secret envelope is truncated"));
        };

        // Attach closure and protocol listeners before consuming any secret bytes.
        input.on("data", onData);
        input.once("end", onEnd);
        input.once("error", onError);
        input.once("close", onClose);
    });
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
