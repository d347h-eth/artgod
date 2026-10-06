import type { ChainAttribution } from "./onchain.js";
import { ChainSyncConflict } from "./chain-sync.js";

export type BalanceContext = ChainAttribution & { blockTimestamp: number };

export type Erc721TokenReference = {
    collectionId: number;
    contract: string;
    tokenId: string;
};

export type Erc721OwnershipState = {
    owner: string | null;
    context: BalanceContext;
};

export function assertSameErc721Tokens(input: {
    expected: readonly Erc721TokenReference[];
    actual: readonly Erc721TokenReference[];
}): void {
    const expected = new Map(
        input.expected.map((token) => [
            `${token.collectionId}:${token.tokenId}`,
            token.contract.toLowerCase(),
        ]),
    );
    if (
        expected.size !== input.expected.length ||
        input.actual.length !== expected.size
    )
        throw new ChainSyncConflict("Rollback token scope changed");
    for (const token of input.actual) {
        const key = `${token.collectionId}:${token.tokenId}`;
        if (expected.get(key) !== token.contract.toLowerCase())
            throw new ChainSyncConflict("Rollback token scope changed");
        expected.delete(key);
    }
}

// A fork checkpoint describes the whole block's final state, including absence.
// Facts from that block or earlier cannot supersede this verified ownership.
export function resolveErc721Ownership(input: {
    latestTransfer: Erc721OwnershipState | null;
    checkpoint: Erc721OwnershipState | null;
}): Erc721OwnershipState {
    if (
        input.checkpoint &&
        (!input.latestTransfer ||
            input.checkpoint.context.blockNumber >=
                input.latestTransfer.context.blockNumber)
    )
        return input.checkpoint;
    if (input.latestTransfer) return input.latestTransfer;
    throw new Error("Missing persisted ERC721 ownership");
}
