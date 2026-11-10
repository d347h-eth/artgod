import assert from "node:assert/strict";
import {
    resolveNatsJobStreamName,
    resolveNatsJobSubject,
} from "../../../shared/queue/nats-job-stream.ts";
import { QUEUE_NAMES } from "../../../indexer/src/domain/queues.ts";

/** Bounded read-only proof of one externally emitted raw input in the real broker. */
export async function observeRetainedRawInput(connection, streamPrefix, input) {
    const manager = await connection.jetstreamManager();
    const stream = resolveNatsJobStreamName(streamPrefix);
    const subject = resolveNatsJobSubject(
        streamPrefix,
        QUEUE_NAMES.OffchainOrdersRaw,
    );
    const streamInfo = await manager.streams.info(stream);
    const consumers = await manager.consumers.list(stream).next();
    const consumer = consumers.find(
        (entry) => entry.config.filter_subject === subject,
    );
    assert.ok(consumer, "Production raw-ingestion durable consumer must exist");
    let sequence = Math.max(1, streamInfo.state.first_seq);
    let retainedSequence;
    for (
        let scanned = 0;
        scanned < 256 && sequence <= streamInfo.state.last_seq;
        scanned++
    ) {
        let message;
        try {
            message = await manager.streams.getMessage(stream, {
                seq: sequence,
                next_by_subj: subject,
            });
        } catch (error) {
            // JetStream's API serializes missing retained messages as 404.
            if (error.code === "404") break;
            throw error;
        }
        sequence = message.seq + 1;
        const job = message.json();
        if (
            job.queue === QUEUE_NAMES.OffchainOrdersRaw &&
            job.payload?.orderId === input.orderId &&
            job.payload?.sourceEventAt === input.sourceEventAt
        ) {
            retainedSequence = message.seq;
            break;
        }
    }
    return {
        stream,
        consumer: consumer.name,
        pending: consumer.num_pending,
        ackPending: consumer.num_ack_pending,
        streamMessages: streamInfo.state.messages,
        matchingInputRetained: retainedSequence !== undefined,
        retainedSequence: retainedSequence ?? null,
    };
}
