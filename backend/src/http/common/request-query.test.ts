import { describe, expect, it } from "vitest";
import {
    COLLECTION_MEDIA_MODES,
    COLLECTION_MEDIA_PREFERENCE_VALUES,
    COLLECTION_MEDIA_QUERY_PARAMS,
} from "@artgod/shared/extensions";
import {
    parseMediaMode,
    parseMediaPreference,
    parseMediaVariant,
} from "./request-query.js";

// Extension-neutral fixture proves media variant key normalization.
const TEST_MEDIA_VARIANT_KEY = "preferred-variant";

describe("media request query parsing", () => {
    it("normalizes extension-open media mode and variant keys", () => {
        expect(parseMediaMode(" SNAPSHOT ")).toBe(
            COLLECTION_MEDIA_MODES.Snapshot,
        );
        expect(parseMediaVariant(" Preferred-Variant ")).toBe(
            TEST_MEDIA_VARIANT_KEY,
        );
    });

    it("accepts only the shared binary preference values", () => {
        expect(parseMediaPreference(" ENABLED ")).toBe(
            COLLECTION_MEDIA_PREFERENCE_VALUES.Enabled,
        );
        expect(parseMediaPreference("disabled")).toBe(
            COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled,
        );
        expect(() => parseMediaPreference("maybe")).toThrow(
            `Invalid ${COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference}; use ${COLLECTION_MEDIA_PREFERENCE_VALUES.Enabled} or ${COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled}`,
        );
    });

    it("rejects malformed media keys at the HTTP boundary", () => {
        expect(() => parseMediaVariant("not a key")).toThrow(
            `Invalid ${COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant}`,
        );
        expect(() => parseMediaMode("bad/key")).toThrow(
            `Invalid ${COLLECTION_MEDIA_QUERY_PARAMS.MediaMode}`,
        );
    });
});
