import type {
    Erc721RollbackSnapshot,
    Erc721RollbackSnapshotPort,
} from "../../application/reorg-rollback.js";
import {
    ChainSyncConflict,
    type VerifiedChainBlock,
} from "../../domain/chain-sync.js";
import type { Erc721TokenReference } from "../../domain/ownership.js";
import type { RpcProviderPort } from "../../ports/rpc.js";
import { Erc721TokenOwnership } from "./erc721-token-ownership.js";

export class RpcRollbackOwnershipSnapshot implements Erc721RollbackSnapshotPort {
    private readonly ownership: Erc721TokenOwnership;

    constructor(
        private readonly rpc: Pick<
            RpcProviderPort,
            "getBlock" | "readContractAtBlock"
        >,
    ) {
        this.ownership = new Erc721TokenOwnership(rpc);
    }

    async readSnapshot(input: {
        fork: VerifiedChainBlock;
        tokens: readonly Erc721TokenReference[];
    }): Promise<Erc721RollbackSnapshot> {
        const { fork } = input;
        const before = await this.rpc.getBlock(fork.number, {
            fresh: true,
        });
        if (before.number !== fork.number || before.hash !== fork.hash)
            throw new ChainSyncConflict(
                "Rollback ownership RPC returned the wrong block",
            );
        const owners: Erc721RollbackSnapshot["owners"] = [];
        // Materialize only affected tokens to commit the rollback atomically,
        // without holding a SQLite cursor or writer while awaiting RPC.
        for (const token of input.tokens) {
            owners.push({
                ...token,
                owner: await this.ownership.readOwner({
                    contract: token.contract,
                    tokenId: token.tokenId,
                    block: {
                        chainId: fork.chainId,
                        blockNumber: fork.number,
                        blockHash: fork.hash,
                    },
                }),
            });
        }
        const after = await this.rpc.getBlock(fork.number, {
            fresh: true,
        });
        if (after.number !== fork.number || after.hash !== fork.hash)
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
