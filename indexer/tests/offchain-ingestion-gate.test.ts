import { describe, expect, it } from "vitest";
import {
    COLLECTION_STATUS,
    OPENSEA_COLLECTION_STATUS,
    OPENSEA_STREAM_INGESTION_STATUS,
    type OpenSeaStreamIngestionStatus,
} from "@artgod/shared/types";
import { shouldProcessOffchainPayload } from "../src/application/offchain/ingestion-gate.js";
import {
    CollectionRecord,
    COLLECTION_STANDARD,
} from "../src/domain/collections.js";
import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    OFFCHAIN_ORDER_SOURCE,
    type OffchainOrderRawPayload,
} from "../src/domain/offchain-jobs.js";

describe("offchain ingestion gate", () => {
    it("skips OpenSea stream payloads for paused collections", () => {
        const collections = collectionLookup(
            collectionWithGate(OPENSEA_STREAM_INGESTION_STATUS.Paused),
        );

        expect(shouldProcessOffchainPayload(collections, rawPayload())).toBe(
            false,
        );
    });

    it("processes OpenSea stream payloads for enabled collections", () => {
        const collections = collectionLookup(
            collectionWithGate(OPENSEA_STREAM_INGESTION_STATUS.Enabled),
        );

        expect(shouldProcessOffchainPayload(collections, rawPayload())).toBe(
            true,
        );
    });

    it("does not block non-stream OpenSea payloads", () => {
        const collections = collectionLookup(
            collectionWithGate(OPENSEA_STREAM_INGESTION_STATUS.Paused),
        );

        expect(
            shouldProcessOffchainPayload(
                collections,
                rawPayload({ channel: OFFCHAIN_OBSERVATION_CHANNEL.Snapshot }),
            ),
        ).toBe(true);
    });

    it("keeps existing behavior when collection state is unavailable", () => {
        const collections = collectionLookup(null);

        expect(shouldProcessOffchainPayload(collections, rawPayload())).toBe(
            true,
        );
    });
});

function collectionLookup(collection: CollectionRecord | null) {
    return {
        getCollection(_chainId: number, _collectionId: number) {
            return collection;
        },
    };
}

function collectionWithGate(
    openseaStreamIngestionStatus: OpenSeaStreamIngestionStatus,
): CollectionRecord {
    return CollectionRecord.fromPersistence({
        chainId: 1,
        id: 10,
        slug: "gate-test",
        address: "0xabc0000000000000000000000000000000000000",
        standard: COLLECTION_STANDARD.Erc721,
        status: COLLECTION_STATUS.Live,
        tokenScopeKind: "contract_all_tokens",
        scopeStartTokenId: null,
        scopeTotalSupply: null,
        deploymentBlock: null,
        bootstrapAnchorBlock: null,
        bootstrapStartedAt: null,
        bootstrapFinishedAt: null,
        bootstrapLastSyncedBlock: null,
        openseaSlug: "gate-test",
        openseaStatus: OPENSEA_COLLECTION_STATUS.Ready,
        openseaStreamIngestionStatus,
        openseaReadyAt: null,
        openseaSnapshotStartedAt: null,
        openseaSnapshotCompletedAt: null,
        openseaReconcileStartedAt: null,
        openseaReconcileCompletedAt: null,
        openseaLastStreamEventAt: null,
        openseaLastStreamHealthyAt: null,
        openseaLastError: null,
    });
}

function rawPayload(
    overrides: Partial<OffchainOrderRawPayload> = {},
): OffchainOrderRawPayload {
    return {
        source: OFFCHAIN_ORDER_SOURCE.OpenSea,
        chainId: 1,
        collectionId: 10,
        receivedAt: 1_800_000_000_000,
        channel: OFFCHAIN_OBSERVATION_CHANNEL.Stream,
        dedupeKey: "test-dedupe",
        eventType: "test_event",
        orderId: "0xorder",
        runId: null,
        sourceEventAt: null,
        payload: {},
        ...overrides,
    };
}
