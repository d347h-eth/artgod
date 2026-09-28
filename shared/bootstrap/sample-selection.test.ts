import { describe, expect, it } from "vitest";
import { BOOTSTRAP_ENUMERATION_MODE as Mode } from "./pipeline.js";
import { BOOTSTRAP_SAMPLE_SOURCE as Source } from "./probe.js";
import {
    bootstrapSampleCandidates,
    bootstrapTokenDiscovery,
    BOOTSTRAP_SCOPE_SAMPLE_CANDIDATE_LIMIT,
} from "./sample-selection.js";
import { BOOTSTRAP_CONTRACT_CASES } from "../testing/bootstrap-probe.js";

describe("bounded sample selection", () => {
    it.each(BOOTSTRAP_CONTRACT_CASES)(
        "preserves $name declared range for every override",
        (fixture) => {
            const scope = {
                mode: Mode.ManualRange,
                startTokenId: fixture.start,
                tokenCount: fixture.count,
            } as const;
            for (const requestedTokenId of [null, fixture.sample, "999999"]) {
                const before = structuredClone(scope);
                const result = bootstrapSampleCandidates({
                    scope,
                    requestedTokenId,
                    discoveredTokenId: "1",
                });
                expect(scope).toEqual(before);
                if (requestedTokenId !== null)
                    expect(result).toEqual([
                        { tokenId: requestedTokenId, source: Source.Requested },
                    ]);
                else expect(result[0].source).toBe(Source.DeclaredScope);
                expect(result.length).toBeLessThanOrEqual(
                    BOOTSTRAP_SCOPE_SAMPLE_CANDIDATE_LIMIT + 1,
                );
            }
        },
    );
    it("prefers a known member, deduplicates it, and bounds range/list work", () => {
        expect(
            bootstrapSampleCandidates({
                requestedTokenId: null,
                discoveredTokenId: "2",
                scope: {
                    mode: Mode.ManualRange,
                    startTokenId: "0",
                    tokenCount: 100,
                },
            }).map((x) => x.tokenId),
        ).toEqual(["2", "0", "1", "3"]);
        expect(
            bootstrapSampleCandidates({
                requestedTokenId: null,
                discoveredTokenId: "9",
                scope: {
                    mode: Mode.ManualTokenIds,
                    tokenIds: ["1", "2", "3", "4", "5", "9"],
                },
            }).map((x) => x.tokenId),
        ).toEqual(["9", "1", "2", "3"]);
        expect(
            bootstrapSampleCandidates({
                requestedTokenId: null,
                discoveredTokenId: null,
                scope: {
                    mode: Mode.ManualRange,
                    startTokenId: "10",
                    tokenCount: 1,
                },
            }),
        ).toEqual([{ tokenId: "10", source: Source.DeclaredScope }]);
    });
    it.each([null, { mode: Mode.Enumerable }])(
        "uses discovery with no manual scope: %j",
        (scope) => {
            expect(
                bootstrapSampleCandidates({
                    requestedTokenId: null,
                    discoveredTokenId: "17",
                    scope,
                }),
            ).toEqual([{ tokenId: "17", source: Source.Discovery }]);
            expect(
                bootstrapSampleCandidates({
                    requestedTokenId: null,
                    discoveredTokenId: null,
                    scope,
                }),
            ).toEqual([]);
        },
    );
    it("does not turn enumeration order into a range minimum", () => {
        const enumeration = { checked: true, tokenId: "42", error: null };
        const owned = (tokenId: string) => ({
            tokenId,
            exists: true,
            error: null,
        });
        expect(
            bootstrapTokenDiscovery(enumeration, [owned("42")]),
        ).toMatchObject({ sampleTokenId: "42", rangeStartCandidate: null });
        expect(
            bootstrapTokenDiscovery(enumeration, [
                owned("42"),
                owned("0"),
                owned("1"),
            ]),
        ).toMatchObject({ sampleTokenId: "42", rangeStartCandidate: "0" });
        expect(
            bootstrapTokenDiscovery(enumeration, [
                owned("1"),
                { tokenId: "42", exists: null, error: "timeout" },
            ]),
        ).toMatchObject({ sampleTokenId: "1", rangeStartCandidate: "1" });
        expect(
            bootstrapTokenDiscovery(
                { checked: false, tokenId: null, error: null },
                [],
            ),
        ).toMatchObject({ sampleTokenId: null, rangeStartCandidate: null });
    });
});
