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
    if (input.enumerationMode === BOOTSTRAP_ENUMERATION_MODE.Enumerable) {
        return null;
    }

    if (input.enumerationMode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds) {
        return parseManualTokenIds(input.manualTokenIdsJson);
    }

    if (input.enumerationMode === BOOTSTRAP_ENUMERATION_MODE.ManualRange) {
        return resolveManualTokenRange(
            input.manualRangeStartTokenId,
            input.manualRangeTotalSupply,
        );
    }

    throw new Error(
        `Unsupported enumeration mode: ${String(input.enumerationMode)}`,
    );
}

function parseManualTokenIds(manualTokenIdsJson: string | null): string[] {
    if (!manualTokenIdsJson) {
        throw new Error("manual token id mode requires token ids payload");
    }

    const parsed = JSON.parse(manualTokenIdsJson) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("manual token ids payload is empty");
    }

    const tokenIds: string[] = [];
    for (const value of parsed) {
        if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
            throw new Error(
                "manual token ids payload contains invalid token id",
            );
        }
        tokenIds.push(value.trim());
    }
    return tokenIds;
}

function resolveManualTokenRange(
    startTokenId: string | null,
    totalSupply: number | null,
): Iterable<string> {
    if (
        !startTokenId ||
        !totalSupply ||
        !Number.isInteger(totalSupply) ||
        totalSupply <= 0
    ) {
        throw new Error(
            "manual token range requires start token id and supply",
        );
    }

    const start = BigInt(startTokenId);
    return iterateRange(start, totalSupply);
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
