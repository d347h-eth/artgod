import { TRAIT_CATALOG_QUERY_PARAMS } from "../types/browse.js";
import type { TraitFilter } from "../types/browse.js";

// A leading colon is invalid in the legacy key:value grammar. Keep existing
// URLs readable while allowing punctuation in either component of a new pair.
const TUPLE_PREFIX = ":pair:";
export function encodeTraitQueryPair(key: string, value: string): string {
    if (key.includes(":") || key.includes(",") || value.includes(","))
        return TUPLE_PREFIX + JSON.stringify([key, value]);
    return key + ":" + value;
}

export function traitQuerySegments(raw: string): string[] {
    const value = raw.trim();
    return value.startsWith(TUPLE_PREFIX)
        ? [value]
        : value
              .split(",")
              .map((segment) => segment.trim())
              .filter(Boolean);
}

export function decodeTraitQuerySegment(segment: string): TraitFilter | null {
    if (segment.startsWith(TUPLE_PREFIX)) {
        let pair: unknown;
        try {
            pair = JSON.parse(segment.slice(TUPLE_PREFIX.length));
        } catch {
            return null;
        }
        if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            typeof pair[0] !== "string" ||
            typeof pair[1] !== "string"
        )
            return null;
        const key = pair[0].trim(),
            value = pair[1].trim();
        return key && value ? { key, value } : null;
    }
    const separator = segment.indexOf(":");
    if (separator < 1) return null;
    const key = segment.slice(0, separator).trim(),
        value = segment.slice(separator + 1).trim();
    return key && value ? { key, value } : null;
}

/** Keep ordinary grouped requests compact and send delimiter-bearing canonical keys losslessly. */
export function appendTraitCatalogKeys(
    query: URLSearchParams,
    keys: readonly string[],
): void {
    const simple = keys.filter((key) => !key.includes(","));
    if (simple.length)
        query.append(TRAIT_CATALOG_QUERY_PARAMS.Keys, simple.join(","));
    for (const key of keys)
        if (key.includes(","))
            query.append(TRAIT_CATALOG_QUERY_PARAMS.ExactKey, key);
}
