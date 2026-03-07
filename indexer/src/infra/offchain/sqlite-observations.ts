import { db } from "@artgod/shared/database";
import type {
    OffchainObservationInput,
    OffchainObservationPort,
} from "../../ports/offchain-observations.js";

export class SqliteOffchainObservationStore implements OffchainObservationPort {
    private insertObservation = db.prepare<{
        chainId: number;
        collectionId: number;
        source: string;
        channel: string;
        dedupeKey: string;
        eventType: string;
        orderId: string | null;
        runId: number | null;
        receivedAt: number;
        sourceEventAt: number | null;
        payloadJson: string;
    }>(
        "INSERT OR IGNORE INTO offchain_order_observations " +
            "(chain_id, collection_id, source, channel, dedupe_key, event_type, order_id, run_id, received_at, source_event_at, payload_json) " +
            "VALUES (@chainId, @collectionId, @source, @channel, @dedupeKey, @eventType, @orderId, @runId, @receivedAt, @sourceEventAt, @payloadJson)",
    );

    recordObservation(input: OffchainObservationInput): void {
        this.insertObservation.run({
            chainId: input.chainId,
            collectionId: input.collectionId,
            source: input.source,
            channel: input.channel,
            dedupeKey: input.dedupeKey,
            eventType: input.eventType,
            orderId: input.orderId ?? null,
            runId: input.runId ?? null,
            receivedAt: input.receivedAt,
            sourceEventAt: input.sourceEventAt ?? null,
            payloadJson: JSON.stringify(input.payload),
        });
    }
}
