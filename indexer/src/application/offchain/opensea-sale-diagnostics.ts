import {
    OFFCHAIN_OBSERVATION_CHANNEL,
    OFFCHAIN_ORDER_SOURCE,
} from "../../domain/offchain-jobs.js";
import {
    getOpenSeaEventIdentifiers,
    getOpenSeaEventType,
    OPENSEA_STREAM_EVENT_TYPE,
} from "@artgod/shared/opensea/payload";
import { asRecord } from "@artgod/shared/offchain/normalizer-utils";

export const OPENSEA_SALE_LOG = {
    Component: "OpenSeaSale",
    RevalidationQueued:
        "OpenSea sale queued for token revalidation without a usable order hash",
    Action: "queueTokenRevalidation",
} as const;

/** Safe even for malformed raw jobs being logged by the dead-letter consumer. */
export function getOpenSeaSaleDiagnosticContext(raw: unknown) {
    const observation = asRecord(raw);
    if (
        observation.source !== OFFCHAIN_ORDER_SOURCE.OpenSea ||
        observation.channel !== OFFCHAIN_OBSERVATION_CHANNEL.Stream ||
        getOpenSeaEventType(observation.payload) !==
            OPENSEA_STREAM_EVENT_TYPE.ItemSold
    )
        return null;
    return {
        chainId: positiveInteger(observation.chainId),
        collectionId: positiveInteger(observation.collectionId),
        sourceEventAt: positiveInteger(observation.sourceEventAt),
        ...getOpenSeaEventIdentifiers(observation.payload),
    };
}

function positiveInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : null;
}
