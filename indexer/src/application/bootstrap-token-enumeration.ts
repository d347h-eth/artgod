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
): string[] | null {
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
            throw new Error("manual token ids payload contains invalid token id");
        }
        tokenIds.push(value.trim());
    }
    return tokenIds;
}

function resolveManualTokenRange(
    startTokenId: string | null,
    totalSupply: number | null,
): string[] {
    if (
        !startTokenId ||
        !totalSupply ||
        !Number.isInteger(totalSupply) ||
        totalSupply <= 0
    ) {
        throw new Error("manual token range requires start token id and supply");
    }

    const start = BigInt(startTokenId);
    const tokenIds: string[] = [];
    for (let index = 0; index < totalSupply; index += 1) {
        tokenIds.push((start + BigInt(index)).toString());
    }
    return tokenIds;
}
