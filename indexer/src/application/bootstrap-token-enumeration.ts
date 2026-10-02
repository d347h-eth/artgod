import { parseBootstrapScope } from "@artgod/shared/bootstrap/scope";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    type BootstrapEnumerationMode,
} from "@artgod/shared/bootstrap/pipeline";
import { ERC721_ENUMERABLE_ABI } from "../abi/index.js";
import type { Hex, RpcProviderPort } from "../ports/rpc.js";
import { BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP } from "./bootstrap-enumeration-executor.js";

// Enumerates the contract at one anchor while reporting at least each whole percent.
export async function resolveEnumerableBootstrapTokenIds(
    rpc: Pick<RpcProviderPort, "readContract">,
    contract: Hex,
    anchorBlock: number,
    onProgress?: (progress: { resolved: number; total: number }) => void,
): Promise<string[]> {
    const totalSupply = await rpc.readContract<bigint>({
        address: contract,
        abi: ERC721_ENUMERABLE_ABI,
        functionName: "totalSupply",
        blockNumber: anchorBlock,
    });
    const supply = Number(totalSupply);
    if (!Number.isSafeInteger(supply) || supply < 0) {
        throw new Error(`Invalid totalSupply: ${String(totalSupply)}`);
    }
    // One token is the smallest increment; the cap preserves larger runs' cadence.
    const progressStep = Math.max(
        1,
        Math.min(
            BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP,
            Math.floor(supply / 100),
        ),
    );
    const tokenIds: string[] = [];
    onProgress?.({ resolved: 0, total: supply });
    for (let index = 0; index < supply; index += 1) {
        const tokenId = await rpc.readContract<bigint>({
            address: contract,
            abi: ERC721_ENUMERABLE_ABI,
            functionName: "tokenByIndex",
            args: [BigInt(index)],
            blockNumber: anchorBlock,
        });
        tokenIds.push(tokenId.toString());
        const resolved = index + 1;
        if (
            resolved === supply ||
            resolved % progressStep === 0 ||
            resolved % BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP === 0
        ) {
            onProgress?.({ resolved, total: supply });
        }
    }
    return tokenIds;
}

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
