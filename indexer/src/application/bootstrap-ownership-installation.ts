import { ChainSyncConflict } from "../domain/chain-sync.js";
import type {
    BootstrapSnapshotPort,
    SnapshotFinalizeInput,
} from "../ports/bootstrap.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import type { StoragePort } from "../ports/storage.js";

/** Ownership tasks read the saved anchor by hash. Recheck that identity before
 * installation and fence any rollback during this final RPC. Confirmed recovery
 * fails in-flight runs; their late responses cannot publish another snapshot. */
export class InstallBootstrapOwnershipSnapshot {
    constructor(
        private readonly rpc: Pick<RpcProviderPort, "getBlock">,
        private readonly chain: Pick<StoragePort, "captureSyncCheckpoint">,
        private readonly snapshots: Pick<
            BootstrapSnapshotPort,
            "finalizeSnapshot"
        >,
    ) {}

    async execute(
        input: Omit<SnapshotFinalizeInput, "checkpoint">,
    ): Promise<void> {
        const checkpoint = this.chain.captureSyncCheckpoint(input.chainId);
        const anchor = await this.rpc.getBlock(input.anchorBlock, {
            fresh: true,
        });
        if (
            anchor.number !== input.anchorBlock ||
            anchor.hash !== input.anchorHash ||
            anchor.timestamp !== input.anchorTimestamp
        )
            throw new ChainSyncConflict("Bootstrap ownership anchor changed");
        this.snapshots.finalizeSnapshot({ ...input, checkpoint });
    }
}
