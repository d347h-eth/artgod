import { describe, expect, it } from "vitest";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import {
    mergeOrderRetirement,
    ORDER_RETIREMENT_REASON as REASON,
    type OrderRetirementObservation,
} from "../src/domain/order-retention.js";

const NOW = 1_800_000_000;
const WINDOW = POLICY.unknownOrderLifetimeSeconds;
const stale: OrderRetirementObservation = {
    reason: REASON.Stale,
    retiredAt: NOW - WINDOW / 2,
    validUntil: null,
};

describe("order retirement deadlines", () => {
    it("uses the remaining replay window, not the cleanup time", () => {
        const first = mergeOrderRetirement(undefined, stale, NOW);
        expect(first.expiresAt).toBe(stale.retiredAt + WINDOW);
        expect(mergeOrderRetirement(first, stale, NOW + 100)).toEqual(first);
    });

    it("caps inactive protection at the known order expiry", () => {
        const validUntil = NOW + 100;
        expect(
            mergeOrderRetirement(undefined, { ...stale, validUntil }, NOW),
        ).toMatchObject({ validUntil, expiresAt: validUntil });
    });

    it("does not renew protection for observations already outside admission", () => {
        expect(
            mergeOrderRetirement(
                undefined,
                { ...stale, retiredAt: NOW - WINDOW },
                NOW,
            ).expiresAt,
        ).toBe(NOW);
    });

    it.each([REASON.Terminal, REASON.SourceCancelled])(
        "protects %s against fresh observations through known validity",
        (reason) => {
            const validUntil = NOW + 3 * WINDOW;
            expect(
                mergeOrderRetirement(
                    undefined,
                    { ...stale, reason, validUntil },
                    NOW,
                ),
            ).toMatchObject({
                validUntil,
                expiresAt: validUntil + POLICY.orderReorgGraceSeconds,
            });
        },
    );

    it.each([100, 3 * WINDOW])(
        "replaces unknown expiry with a known deadline %s seconds ahead",
        (seconds) => {
            const cancellation = { ...stale, reason: REASON.SourceCancelled };
            const first = mergeOrderRetirement(undefined, cancellation, NOW);
            expect(first.expiresAt).toBe(NOW + WINDOW);
            const validUntil = NOW + seconds;
            expect(
                mergeOrderRetirement(
                    first,
                    { ...cancellation, validUntil },
                    NOW + 1,
                ),
            ).toMatchObject({
                validUntil,
                expiresAt: validUntil + POLICY.orderReorgGraceSeconds,
            });
        },
    );

    it("does not refresh cancellation retention or downgrade it on repeated/weaker evidence", () => {
        const first = mergeOrderRetirement(
            undefined,
            { ...stale, reason: REASON.SourceCancelled },
            NOW,
        );
        for (const reason of [
            REASON.Stale,
            REASON.Terminal,
            REASON.SourceCancelled,
        ]) {
            expect(
                mergeOrderRetirement(
                    first,
                    { ...stale, reason, retiredAt: NOW + 100 },
                    NOW + 100,
                ),
            ).toEqual(first);
        }
    });

    it("replaces inactivity with definitive cancellation without losing known expiry", () => {
        const validUntil = NOW + 3 * WINDOW;
        const first = mergeOrderRetirement(
            undefined,
            { ...stale, validUntil },
            NOW,
        );
        expect(
            mergeOrderRetirement(
                first,
                { ...stale, reason: REASON.SourceCancelled },
                NOW + 1,
            ),
        ).toMatchObject({
            reason: REASON.SourceCancelled,
            validUntil,
            expiresAt: validUntil + POLICY.orderReorgGraceSeconds,
        });
    });

    it("does not shorten a known deadline when sources disagree", () => {
        const cancellation = {
            ...stale,
            reason: REASON.SourceCancelled,
            validUntil: NOW + 3 * WINDOW,
        };
        const first = mergeOrderRetirement(undefined, cancellation, NOW);
        expect(
            mergeOrderRetirement(
                first,
                { ...cancellation, validUntil: NOW + 1 },
                NOW,
            ),
        ).toEqual(first);
    });
});
