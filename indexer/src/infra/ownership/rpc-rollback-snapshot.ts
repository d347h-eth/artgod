import type {
    Erc721RollbackSnapshot,
    Erc721RollbackSnapshotPort,
} from "../../application/reorg-rollback.js";
import { ChainSyncConflict } from "../../domain/chain-sync.js";
import type { Erc721TokenReference } from "../../domain/ownership.js";
import type { RpcProviderPort } from "../../ports/rpc.js";
import { Erc721TokenOwnership } from "./erc721-token-ownership.js";

export class RpcRollbackOwnershipSnapshot implements Erc721RollbackSnapshotPort {
    private readonly ownership: Erc721TokenOwnership;

    constructor(
        private readonly rpc: Pick<
            RpcProviderPort,
            "getBlock" | "readContract"
        >,
    ) {
        this.ownership = new Erc721TokenOwnership(rpc);
    }

    async readSnapshot(input: {
        blockNumber: number;
        tokens: readonly Erc721TokenReference[];
    }): Promise<Erc721RollbackSnapshot> {
        const before = await this.rpc.getBlock(input.blockNumber, {
            fresh: true,
        });
        if (before.number !== input.blockNumber)
            throw new ChainSyncConflict(
                "Rollback ownership RPC returned the wrong block",
            );
        const owners: Erc721RollbackSnapshot["owners"] = [];
        // Materialize only affected tokens to commit the rollback atomically,
        // without holding a SQLite cursor or writer while awaiting RPC.
        for (const token of input.tokens) {
            owners.push({
                ...token,
                owner: await this.ownership.readOwner(
                    token.contract,
                    token.tokenId,
                    input.blockNumber,
                ),
            });
        }
        const after = await this.rpc.getBlock(input.blockNumber, {
            fresh: true,
        });
        if (after.number !== input.blockNumber || before.hash !== after.hash)
            throw new ChainSyncConflict(
                "Rollback ownership block changed during RPC reads",
            );
        return {
            block: {
                blockNumber: before.number,
                blockHash: before.hash,
                parentHash: before.parentHash,
                blockTimestamp: before.timestamp,
            },
            owners,
        };
    }
}
