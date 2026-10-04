import { zeroHash } from "viem";
import { db } from "@artgod/shared/database";
import type { SqliteStorage } from "../../src/infra/storage/sqlite.js";

// Direct adapter tests supply known fork ownership; production reads it from RPC.
export function commitRollbackFixture(input: {
    storage: SqliteStorage;
    chainId: number;
    fromBlock: number;
    owners: { collectionId: number; tokenId: string; owner: string | null }[];
}): void {
    const plan = input.storage.prepareRollback(input);
    const fork = db
        .prepare<
            [number, number]
        >("SELECT parent_hash, timestamp FROM blocks WHERE chain_id = ? AND block_number = ?")
        .get(input.chainId, input.fromBlock - 1) as
        | { parent_hash: string; timestamp: number }
        | undefined;
    if (plan.tokens.length !== input.owners.length)
        throw new Error(
            "Rollback fixture must specify every affected token owner",
        );
    input.storage.rollbackFromBlock({
        plan,
        snapshot: {
            block: {
                blockNumber: input.fromBlock - 1,
                blockHash:
                    input.storage.getBlockHash(
                        input.chainId,
                        input.fromBlock - 1,
                    ) ?? zeroHash,
                parentHash: fork?.parent_hash ?? zeroHash,
                blockTimestamp: fork?.timestamp ?? input.fromBlock - 1,
            },
            owners: plan.tokens.map((token) => {
                const owner = input.owners.find(
                    (item) =>
                        item.collectionId === token.collectionId &&
                        item.tokenId === token.tokenId,
                );
                if (!owner) throw new Error("Missing rollback fixture owner");
                return { ...token, owner: owner.owner };
            }),
        },
    });
}
