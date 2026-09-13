import { zeroAddress } from "viem";
import {
    isRpcProviderHeadLagError,
    isRpcProviderStateUnavailableError,
    isRpcProviderZeroDataError,
} from "./rpc-errors.js";

// ERC-721 ownership read used for sample validation and anchored range scans.
export const ERC721_OWNER_OF_FUNCTION = "ownerOf";

// Standard and commonly implemented errors that specifically mean a token is absent.
export const ERC721_ABSENT_TOKEN_ERROR = {
    NonexistentToken: "ERC721NonexistentToken",
    OwnerQuery: "OwnerQueryForNonexistentToken",
    LegacyOwnerQuery: "ERC721: owner query for nonexistent token",
    LegacyInvalidId: "ERC721: invalid token ID",
} as const;

// Include custom absence errors so Viem can decode modern ERC-721 implementations.
export const ERC721_OWNERSHIP_ABI = [
    {
        type: "function",
        name: ERC721_OWNER_OF_FUNCTION,
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ type: "address" }],
    },
    {
        type: "error",
        name: ERC721_ABSENT_TOKEN_ERROR.NonexistentToken,
        inputs: [{ name: "tokenId", type: "uint256" }],
    },
    { type: "error", name: ERC721_ABSENT_TOKEN_ERROR.OwnerQuery, inputs: [] },
] as const;

const MAX_OWNERSHIP_ERROR_CAUSE_DEPTH = 6;
const ABSENT_TOKEN_ERROR_NAMES = new Set<string>([
    ERC721_ABSENT_TOKEN_ERROR.NonexistentToken,
    ERC721_ABSENT_TOKEN_ERROR.OwnerQuery,
]);
const ABSENT_TOKEN_ERROR_REASONS = new Set<string>([
    ERC721_ABSENT_TOKEN_ERROR.LegacyOwnerQuery,
    ERC721_ABSENT_TOKEN_ERROR.LegacyInvalidId,
]);

// Classifies only decoded absence evidence; generic reverts and provider errors remain failures.
export function isErc721TokenAbsentError(error: unknown): boolean {
    if (
        isRpcProviderHeadLagError(error) ||
        isRpcProviderStateUnavailableError(error) ||
        isRpcProviderZeroDataError(error)
    )
        return false;
    let current = error;
    for (let depth = 0; depth < MAX_OWNERSHIP_ERROR_CAUSE_DEPTH; depth += 1) {
        if (!current || typeof current !== "object") return false;
        const candidate = current as {
            data?: { errorName?: string; args?: readonly unknown[] };
            reason?: string;
            cause?: unknown;
        };
        if (
            candidate.data?.errorName &&
            ABSENT_TOKEN_ERROR_NAMES.has(candidate.data.errorName)
        )
            return true;
        if (
            candidate.reason &&
            ABSENT_TOKEN_ERROR_REASONS.has(candidate.reason)
        )
            return true;
        current = candidate.cause;
    }
    return false;
}

// Reject malformed and zero owners instead of converting uncertain reads into absent tokens.
export function normalizeErc721Owner(owner: string): string {
    if (
        !/^0x[a-fA-F0-9]{40}$/.test(owner) ||
        owner.toLowerCase() === zeroAddress
    ) {
        throw new Error("ERC721 ownerOf returned an invalid owner");
    }
    return owner.toLowerCase();
}
