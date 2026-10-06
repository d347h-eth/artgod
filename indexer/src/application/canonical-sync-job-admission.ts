import type { JobEnvelope } from "../domain/jobs.js";
import type { StoragePort } from "../ports/storage.js";

// Range jobs reread current facts. Ephemeral event hints retain a canonical block
// identity because they can already be in the broker when rollback deletes them.
export class CanonicalSyncJobAdmission {
    constructor(private readonly storage: Pick<StoragePort, "getBlockHash">) {}

    isCurrent(job: JobEnvelope): boolean {
        const block = job.onchainBlock;
        if (block === undefined) return true;
        return (
            !!block &&
            block.chainId === job.chainId &&
            Number.isSafeInteger(block.blockNumber) &&
            block.blockNumber >= 0 &&
            typeof block.blockHash === "string" &&
            this.storage.getBlockHash(job.chainId, block.blockNumber) ===
                block.blockHash
        );
    }
}
