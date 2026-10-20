import type { RpcProviderPort } from "../../src/ports/rpc.js";
import { SqliteCollectionRegistry } from "../../src/infra/collections/sqlite.js";
import { createAppliedSyncFixture } from "./applied-sync-fixture.js";

/** Explicit synthetic sync owner for validator integration fixtures. It installs
 * declared anchored ownership, applies each contiguous header through the real
 * atomic writer, then records a post-admission head sample. Validators never
 * create progress themselves; tests needing lag use the owners separately. */
export function validationChainFixture(input: {
    chainId: number;
    rpc: Pick<RpcProviderPort, "getBlock" | "getBlockNumber">;
    collectionIds: readonly number[];
}) {
    let owner: ReturnType<typeof createAppliedSyncFixture> | undefined;
    async function apply() {
        const sample = owner?.progress.captureHeadSample(input.chainId);
        const head = await input.rpc.getBlockNumber();
        if (!owner) {
            const registry = new SqliteCollectionRegistry();
            const collections = input.collectionIds.map(
                (id) => registry.getCollection(input.chainId, id)!,
            );
            const anchor = collections[0]?.bootstrapAnchorBlock;
            if (
                anchor == null ||
                collections.some(
                    (collection) => collection.bootstrapAnchorBlock !== anchor,
                )
            )
                throw new Error(
                    "Validation fixture requires one explicit installed anchor",
                );
            owner = createAppliedSyncFixture({
                chainId: input.chainId,
                anchor: await input.rpc.getBlock(anchor),
                collections,
            });
        }
        const captured =
            sample ?? owner.progress.captureHeadSample(input.chainId);
        const applied = owner.progress.chainProgress(input.chainId)!;
        if (head > applied.applied.number) {
            const headers = [];
            for (
                let number = applied.applied.number + 1;
                number <= head;
                number++
            )
                headers.push(await input.rpc.getBlock(number));
            owner.commit(
                owner.applied({
                    blocks: headers,
                    shared: true,
                    collectionIds: input.collectionIds,
                }),
            );
        }
        owner.progress.recordHeadSample(
            captured,
            await input.rpc.getBlock(head),
            Date.now(),
        );
        return owner;
    }
    return { apply };
}
