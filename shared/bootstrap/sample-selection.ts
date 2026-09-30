import { BOOTSTRAP_ENUMERATION_MODE } from "./pipeline.js";
import {
    BOOTSTRAP_SAMPLE_SOURCE,
    type BootstrapSampleSource,
    type BootstrapProbeTokenCandidate,
    type BootstrapTokenDiscovery,
} from "./probe.js";
import { bootstrapScopeContainsToken, type BootstrapScope } from "./scope.js";

// A preview must not scan an arbitrary collection. The operator can choose any ID.
export const BOOTSTRAP_SCOPE_SAMPLE_CANDIDATE_LIMIT = 4;
export const BOOTSTRAP_CONVENTIONAL_TOKEN_IDS = ["0", "1"] as const;

export function bootstrapSampleCandidates(input: {
    requestedTokenId: string | null;
    discoveredTokenId: string | null;
    scope: BootstrapScope | null;
}): { tokenId: string; source: BootstrapSampleSource }[] {
    if (input.requestedTokenId !== null)
        return [
            {
                tokenId: input.requestedTokenId,
                source: BOOTSTRAP_SAMPLE_SOURCE.Requested,
            },
        ];
    const candidates = new Map<string, BootstrapSampleSource>();
    const { scope, discoveredTokenId } = input;
    if (scope && scope.mode !== BOOTSTRAP_ENUMERATION_MODE.Enumerable) {
        if (
            discoveredTokenId !== null &&
            bootstrapScopeContainsToken(scope, discoveredTokenId)
        )
            candidates.set(
                discoveredTokenId,
                BOOTSTRAP_SAMPLE_SOURCE.DeclaredScope,
            );
        const ids =
            scope.mode === BOOTSTRAP_ENUMERATION_MODE.ManualRange
                ? Array.from(
                      {
                          length: Math.min(
                              scope.tokenCount,
                              BOOTSTRAP_SCOPE_SAMPLE_CANDIDATE_LIMIT,
                          ),
                      },
                      (_, i) =>
                          (BigInt(scope.startTokenId) + BigInt(i)).toString(),
                  )
                : scope.tokenIds.slice(
                      0,
                      BOOTSTRAP_SCOPE_SAMPLE_CANDIDATE_LIMIT,
                  );
        for (const id of ids) {
            if (candidates.size >= BOOTSTRAP_SCOPE_SAMPLE_CANDIDATE_LIMIT)
                break;
            candidates.set(id, BOOTSTRAP_SAMPLE_SOURCE.DeclaredScope);
        }
    }
    if (discoveredTokenId !== null && !candidates.has(discoveredTokenId))
        candidates.set(discoveredTokenId, BOOTSTRAP_SAMPLE_SOURCE.Discovery);
    return Array.from(candidates, ([tokenId, source]) => ({ tokenId, source }));
}

export function bootstrapTokenDiscovery(
    enumeration: BootstrapTokenDiscovery["enumeration"],
    candidates: BootstrapProbeTokenCandidate[],
): BootstrapTokenDiscovery {
    const confirmed = (id: string) =>
        candidates.some(
            (candidate) =>
                candidate.tokenId === id && candidate.exists === true,
        );
    // An unknown read of 0 cannot justify moving the range to 1. Enumeration
    // returning 0 contradicts an absence response and also requires review.
    const zeroAbsent = candidates.some(
        (candidate) => candidate.tokenId === "0" && candidate.exists === false,
    );
    const rangeStartCandidate = confirmed("0")
        ? "0"
        : zeroAbsent && enumeration.tokenId !== "0" && confirmed("1")
          ? "1"
          : null;
    return {
        enumeration,
        candidates,
        rangeStartCandidate,
        sampleTokenId:
            enumeration.tokenId !== null && confirmed(enumeration.tokenId)
                ? enumeration.tokenId
                : (BOOTSTRAP_CONVENTIONAL_TOKEN_IDS.find(confirmed) ?? null),
    };
}
