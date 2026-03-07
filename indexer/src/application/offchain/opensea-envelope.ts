function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
}

export function getOpenSeaEventType(raw: unknown): string | null {
    const envelope = asRecord(raw);
    return typeof envelope.event_type === "string" ? envelope.event_type : null;
}

export function getOpenSeaOrderId(raw: unknown): string | null {
    const payload = getOpenSeaPayload(raw);
    const orderHash = payload.order_hash;
    return typeof orderHash === "string" && orderHash.length > 0
        ? orderHash.toLowerCase()
        : null;
}

export function getOpenSeaPayload(raw: unknown): Record<string, unknown> {
    const envelope = asRecord(raw);
    const payload = envelope.payload;
    return payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : envelope;
}

export function getOpenSeaEventContract(raw: unknown): string | null {
    const eventType = getOpenSeaEventType(raw);
    const payload = getOpenSeaPayload(raw);

    if (!eventType) return null;

    if (eventType === "collection_offer" || eventType === "trait_offer") {
        const criteria = asRecord(payload.asset_contract_criteria);
        return typeof criteria.address === "string"
            ? criteria.address.toLowerCase()
            : null;
    }

    const item = asRecord(payload.item);
    const nftId = item.nft_id;
    if (typeof nftId !== "string") return null;
    const parts = nftId.split("/");
    if (parts.length < 3) return null;
    const contract = parts[1];
    return typeof contract === "string" ? contract.toLowerCase() : null;
}

export function getOpenSeaSourceEventAt(raw: unknown): number | null {
    const envelope = asRecord(raw);
    const payload = getOpenSeaPayload(raw);
    const candidates = [
        payload.event_timestamp,
        envelope.sent_at,
        payload.created_date,
        payload.listing_date,
        payload.expiration_date,
    ];
    for (const value of candidates) {
        if (typeof value !== "string") continue;
        const ms = Date.parse(value);
        if (!Number.isFinite(ms)) continue;
        return Math.floor(ms / 1000);
    }
    return null;
}
