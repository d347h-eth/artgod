import { setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { encodeEventTopics, erc20Abi, toHex } from "viem";
import { acquireSyncRange } from "../src/application/sync-range-processing.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    insertCollection,
    loadCollection,
} from "./helpers/ownership-fixture.js";
import {
    RecoveryRpc,
    REORG_FIXTURE,
} from "./helpers/reorg-recovery-fixture.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
describe("current protocol acquisition ownership", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    function fixture(withCollection = false) {
        const collections = withCollection
            ? [
                  loadCollection(
                      1,
                      insertCollection({
                          chainId: 1,
                          slug: "scope",
                          address: "0x0000000000000000000000000000000000000007",
                          anchorBlock: 100,
                      }),
                  ),
              ]
            : [];
        const f = createAppliedSyncFixture({
            chainId: 1,
            anchor: block(100),
            collections,
        });
        const rpc = new RecoveryRpc(200, 110);
        rpc.logs.push({
            address: REORG_FIXTURE.Weth,
            data: toHex(1n, { size: 32 }),
            topics: encodeEventTopics({
                abi: erc20Abi,
                eventName: "Transfer",
                args: {
                    from: REORG_FIXTURE.Owner,
                    to: REORG_FIXTURE.OrphanOwner,
                },
            }),
            blockNumber: 101,
            blockHash: block(101).hash,
            transactionHash: toHex(1n, { size: 32 }),
            logIndex: 0,
        });
        const logs = vi.spyOn(rpc, "getLogs");
        const acquire = (
            application: Parameters<typeof acquireSyncRange>[0]["application"],
            fromBlock = 101,
        ) =>
            acquireSyncRange({
                rpc,
                storage: f.storage,
                collectionScopeResolver: f.registry,
                collectionExtensions: { getInstall: () => null },
                chainId: 1,
                reorgDepth: 3,
                collections,
                range: { fromBlock, toBlock: fromBlock },
                application,
                wethAddress: REORG_FIXTURE.Weth,
            });
        return { ...f, collections, rpc, logs, acquire };
    }

    it("acquires global WETH effects when shared progress advances without any collections", async () => {
        const f = fixture();
        const result = await f.acquire(
            f.applied({ blocks: [block(101)], shared: true, collectionIds: [] })
                .application,
        );
        expect(
            result.data.global.makerTriggers.map((trigger) => trigger.maker),
        ).toEqual([REORG_FIXTURE.Owner, REORG_FIXTURE.OrphanOwner]);
        expect(
            f.logs.mock.calls.some(
                ([filter]) => filter.address === REORG_FIXTURE.Weth,
            ),
        ).toBe(true);
    });

    it("does not acquire WETH effects during historical enrichment", async () => {
        const f = fixture();
        const result = await f.acquire(
            f.historical({ blocks: [block(100)], collectionIds: [] })
                .application,
            100,
        );
        expect(result.data.global.makerTriggers).toEqual([]);
        expect(
            f.logs.mock.calls.some(
                ([filter]) => filter.address === REORG_FIXTURE.Weth,
            ),
        ).toBe(false);
    });

    it("does not repeat shared WETH acquisition during collection-only replay", async () => {
        const f = fixture(true);
        f.commit(
            f.applied({
                blocks: [block(101)],
                shared: true,
                collectionIds: [],
            }),
        );
        const result = await f.acquire(
            f.applied({
                blocks: [block(101)],
                shared: false,
                collectionIds: f.collections.map((collection) => collection.id),
            }).application,
        );
        expect(result.data.global.makerTriggers).toEqual([]);
        expect(
            f.logs.mock.calls.some(
                ([filter]) => filter.address === REORG_FIXTURE.Weth,
            ),
        ).toBe(false);
    });
});
