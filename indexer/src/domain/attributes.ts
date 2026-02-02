export type NormalizedAttribute = {
    key: string;
    value: string;
};

type RawAttribute = {
    key: unknown;
    value: unknown;
};

export function normalizeAttributePair(
    key: unknown,
    value: unknown,
): NormalizedAttribute | null {
    const keyValue = typeof key === "string" ? key.trim() : "";
    if (!keyValue) return null;
    if (value === undefined || value === null) return null;
    const valueText = String(value).trim();
    if (!valueText) return null;
    return { key: keyValue, value: valueText };
}

export function normalizeUniqueAttributeList(
    raw: RawAttribute[],
): NormalizedAttribute[] {
    const normalized: NormalizedAttribute[] = [];
    for (const entry of raw) {
        const pair = normalizeAttributePair(entry.key, entry.value);
        if (!pair) continue;
        normalized.push(pair);
    }
    return dedupeAttributePairs(normalized);
}

export function dedupeAttributePairs(
    pairs: NormalizedAttribute[],
): NormalizedAttribute[] {
    const seen = new Set<string>();
    const deduplicated: NormalizedAttribute[] = [];
    for (const pair of pairs) {
        const signature = `${pair.key}:${pair.value}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        deduplicated.push(pair);
    }
    return deduplicated;
}
