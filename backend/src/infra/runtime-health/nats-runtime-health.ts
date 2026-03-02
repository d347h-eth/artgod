import { connect } from "nats";
import type { RuntimeHealthQueuePort } from "../../application/use-cases/health/get-runtime-health.js";

const NATS_CONNECT_TIMEOUT_MS = 1_500;

export class NatsRuntimeHealthAdapter implements RuntimeHealthQueuePort {
    constructor(private readonly natsUrl: string) {}

    async assertJobsStreamExists(streamName: string): Promise<void> {
        const connection = await connect({
            servers: this.natsUrl,
            timeout: NATS_CONNECT_TIMEOUT_MS,
        });

        try {
            const manager = await connection.jetstreamManager();
            await manager.streams.info(streamName);
        } catch (error) {
            const message = toErrorMessage(error);
            if (isStreamNotFoundError(message, streamName)) {
                throw new Error(`JetStream stream not found: ${streamName}`);
            }
            throw error;
        } finally {
            await connection.drain().catch(() => undefined);
        }
    }
}

function isStreamNotFoundError(message: string, streamName: string): boolean {
    const normalized = message.toLowerCase();
    return (
        normalized.includes("stream not found") ||
        normalized.includes(`stream ${streamName.toLowerCase()} not found`) ||
        normalized.includes("code: 404")
    );
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    if (typeof error === "string" && error.trim().length > 0) {
        return error;
    }
    return "unknown error";
}
