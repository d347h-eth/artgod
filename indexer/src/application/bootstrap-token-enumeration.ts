import { parseBootstrapScope } from "@artgod/shared/bootstrap/scope";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    type BootstrapEnumerationMode,
} from "@artgod/shared/bootstrap/pipeline";

export type BootstrapManualTokenEnumerationInput = {
    enumerationMode: BootstrapEnumerationMode;
    manualTokenIdsJson: string | null;
    manualRangeStartTokenId: string | null;
    manualRangeTotalSupply: number | null;
};

// Resolves local/manual token scopes; enumerable mode remains RPC-driven.
export function resolveManualBootstrapTokenIds(
    input: BootstrapManualTokenEnumerationInput,
): Iterable<string> | null {
    const scope = parseBootstrapScope(
        input.enumerationMode === BOOTSTRAP_ENUMERATION_MODE.ManualRange
            ? {
                  mode: input.enumerationMode,
                  startTokenId: input.manualRangeStartTokenId,
                  tokenCount: input.manualRangeTotalSupply,
              }
            : input.enumerationMode ===
                BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
              ? {
                    mode: input.enumerationMode,
                    tokenIds: input.manualTokenIdsJson
                        ? JSON.parse(input.manualTokenIdsJson)
                        : null,
                }
              : { mode: input.enumerationMode },
    );
    switch (scope.mode) {
        case BOOTSTRAP_ENUMERATION_MODE.Enumerable:
            return null;
        case BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds:
            return scope.tokenIds;
        case BOOTSTRAP_ENUMERATION_MODE.ManualRange:
            return iterateRange(BigInt(scope.startTokenId), scope.tokenCount);
    }
}

function* iterateRange(start: bigint, totalSupply: number): Generator<string> {
    for (let index = 0; index < totalSupply; index += 1) {
        yield (start + BigInt(index)).toString();
    }
}

// Resolve a bounded scope at one anchor without backfilling events or querying a marketplace.
export async function resolvePresentBootstrapTokenIds(
    candidates: Iterable<string>,
    readOwner: (tokenId: string) => Promise<string | null>,
    onProgress?: (progress: { resolved: number; total: number | null }) => void,
    total: number | null = null,
): Promise<string[]> {
    // The existing metadata seeding boundary consumes a list; retain only confirmed minted IDs.
    const present: string[] = [];
    let scanned = 0;
    for (const tokenId of candidates) {
        if (await readOwner(tokenId)) present.push(tokenId);
        scanned += 1;
        onProgress?.({ resolved: scanned, total });
    }
    if (present.length === 0)
        throw new Error(
            "No tokens exist in the collection scope at the bootstrap anchor",
        );
    return present;
}
