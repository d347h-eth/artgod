import { db } from "@artgod/shared/database";
import { SqliteChainProgress } from "../../src/infra/storage/sqlite-chain-progress.js";
import { createAppliedSyncFixture } from "./applied-sync-fixture.js";
import { loadCollection } from "./ownership-fixture.js";
import { HEAVY_MAKER, heavyMakerBlock } from "../fixtures/heavy-maker.js";

/** A synthetic coordinator installs the two seeded collections before validators
 * run. Tests advance/sample this owner explicitly when a new requirement arrives. */
export function installHeavyMakerValidationChain() {
    const progress = new SqliteChainProgress();
    const existing = progress.chainProgress(HEAVY_MAKER.chainId);
    if (!existing) {
        db.prepare("UPDATE collections SET bootstrap_anchor_block=?").run(
            HEAVY_MAKER.blockNumber - 1,
        );
        db.exec("UPDATE orders SET validation_ready=1");
    }
    const owner = createAppliedSyncFixture({
        chainId: HEAVY_MAKER.chainId,
        anchor: heavyMakerBlock(HEAVY_MAKER.blockNumber - 1),
        collections: [9, 11].map((id) => loadCollection(1, id)),
    });
    function advance(number: number) {
        const from = progress.chainProgress(1)!.applied.number + 1;
        if (from > number) return;
        owner.commit(
            owner.applied({
                blocks: Array.from({ length: number - from + 1 }, (_, i) =>
                    heavyMakerBlock(from + i),
                ),
                shared: true,
                collectionIds: [9, 11],
            }),
        );
    }
    function sample() {
        const request = progress.captureHeadSample(1);
        progress.recordHeadSample(
            request,
            progress.chainProgress(1)!.applied,
            Date.now(),
        );
    }
    advance(HEAVY_MAKER.blockNumber);
    return { progress, advance, sample };
}
