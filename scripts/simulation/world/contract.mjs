/** Authored external-provider vocabulary shared by host and guest validation. */
export const METADATA_TRANSPORT = Object.freeze({
    Http: "http",
    DataUri: "data-uri",
});

export const SCRIPTED_CHAIN_END_BLOCK = 107;

// HTTP finish is a transport boundary, not proof that the client consumed a result.
export const RPC_RESPONSE_EVENT = Object.freeze({
    Finished: "rpc-response-finished",
});

/** External reply gates hold encoded bytes; they never substitute runtime work. */
export const RESPONSE_GATE_FUNCTION = Object.freeze({
    Counter: "getCounter",
    OrderStatus: "getOrderStatus",
});
export const RESPONSE_GATE_EVENT = Object.freeze({
    Armed: "response-gate-armed",
    Captured: "response-gate-captured",
    Released: "response-gate-released",
    Delivered: "response-gate-delivered",
    Aborted: "response-gate-aborted",
});

/** Optional immutable tail cadence; existing fixtures retain one-second blocks. */
export function tailBlockIntervalSeconds(value = 1) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60)
        throw new Error(
            "World tail block interval must be an integer from 1 to 60 seconds",
        );
    return value;
}
