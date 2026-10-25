import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { getSettingDefaultNumber } from "@artgod/shared/config/generated-settings-defaults";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import { RetainCanonicalOrderEffects } from "../src/application/orders/retain-canonical-order-effects.js";
import {
    ORDER_VALIDATION_DEMAND_POLICY,
    eventValidationRequest,
    observedOrderValidationRequest,
} from "../src/domain/order-validation-demand.js";
import {
    GLOBAL_MAKER_TRIGGER_REASON,
    TOKEN_SCOPED_MAKER_TRIGGER_REASON,
} from "../src/domain/maker-triggers.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import { ORDER_STATUS } from "../src/domain/orders.js";
import {
    HEAVY_MAKER as H,
    heavyMakerBlock,
    seedHeavyMaker,
} from "./fixtures/heavy-maker.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import {
    emptyOnChainData,
    loadCollection,
} from "./helpers/ownership-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

loadTestEnv();
afterEach(() => db.raw.close());

it("keeps a 9,339-order maker invalidation bounded in the atomic writer and serves ready demand beside waiting work", async () => {
    setDbPath(await createTempDbPath());
    await createMigrationRunner().runMigrations();
    const { small } = seedHeavyMaker();
    db.exec(
        "UPDATE orders SET validation_ready=1; UPDATE collections SET bootstrap_anchor_block=999",
    );
    const now = H.now * 1_000;
    const orders = new SqliteOrdersDomain(H.weth, undefined, () => H.now);
    const demand = new SqliteOrderValidationDemand(orders);
    const makers = new SqliteMakerRevalidations(orders, demand, H.weth);
    const owner = createAppliedSyncFixture({
        chainId: 1,
        anchor: heavyMakerBlock(999),
        collections: [9, 11].map((id) => loadCollection(1, id)),
        orderEffects: new RetainCanonicalOrderEffects({ orders, makers }),
        now: () => now,
    });
    const rangeBlocks = getSettingDefaultNumber("BACKFILL_BATCH_SIZE");
    const samples: Array<{
        mode: string;
        milliseconds: number;
        serializedBytes: number;
        headers: number;
        transfers: number;
        criticalEffects: number;
        followUps: number;
    }> = [];
    let last = 999;
    for (const transfers of [0, 100]) {
        for (let sample = 0; sample < 12; sample++) {
            const blocks = Array.from({ length: rangeBlocks }, (_, i) =>
                heavyMakerBlock(last + i + 1),
            );
            const data = emptyOnChainData();
            const tip = blocks.at(-1)!;
            const txHash = `0x${tip.number.toString(16).padStart(64, "0")}`;
            data.global.makerTriggers.push({
                blockNumber: tip.number,
                blockHash: tip.hash,
                txHash,
                logIndex: 0,
                maker: H.maker,
                reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
            });
            for (let i = 0; i < transfers; i++) {
                const collectionId = i % 2 === 0 ? 9 : 11;
                const collection = loadCollection(1, collectionId);
                const block = blocks[i % blocks.length]!;
                const attribution = {
                    blockNumber: block.number,
                    blockHash: block.hash,
                    txHash: `0x${block.number.toString(16).padStart(64, "0")}`,
                    logIndex: i + 1,
                    collectionId,
                    contract: collection.address,
                    tokenId: String(100_000 + i),
                };
                const from = sample % 2 === 0 ? H.seller : H.smallMaker;
                const to = sample % 2 === 0 ? H.smallMaker : H.seller;
                data.collectionScoped.nftTransferEvents.push({
                    ...attribution,
                    from,
                    to,
                    amount: "1",
                    kind: COLLECTION_STANDARD.Erc721,
                });
                for (const maker of [from, to])
                    data.collectionScoped.makerTriggers.push({
                        ...attribution,
                        maker,
                        reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
                    });
            }
            const result = owner.applied({
                blocks,
                data,
                shared: true,
                collectionIds: [9, 11],
            });
            const serializedBytes = Buffer.byteLength(JSON.stringify(result));
            // commit() performs the actual BEGIN/assert/persist/effects/advance/outbox/COMMIT.
            // The measured synchronous call includes transaction setup and commit overhead.
            const started = performance.now();
            owner.commit(result);
            const milliseconds = performance.now() - started;
            samples.push({
                mode:
                    transfers === 0
                        ? "headers-and-maker"
                        : "transfers-and-scopes",
                milliseconds,
                serializedBytes,
                headers: blocks.length,
                transfers,
                criticalEffects: 1 + transfers * 2,
                followUps: (
                    db
                        .prepare("SELECT COUNT(*) AS n FROM queue_outbox")
                        .get() as { n: number }
                ).n,
            });
            last = tip.number;
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM maker_order_revalidation_runs",
                    )
                    .get(),
            ).toEqual({ n: 1 });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM order_validation_demand",
                    )
                    .get(),
            ).toEqual({ n: 0 });
        }
    }
    expect(
        db.prepare("SELECT COUNT(*) AS n FROM nft_transfer_events").get(),
    ).toEqual({ n: 1200 });
    expect(owner.progress.chainProgress(1)?.applied.number).toBe(last);
    const admitStarted = performance.now();
    db.writeTransaction(() => {
        let afterId = "";
        while (true) {
            const page = db
                .prepare(
                    "SELECT id FROM orders WHERE maker=? AND id>? ORDER BY id LIMIT ?",
                )
                .all(
                    H.maker,
                    afterId,
                    ORDER_VALIDATION_DEMAND_POLICY.batchOrders,
                ) as Array<{ id: string }>;
            if (!page.length) break;
            for (const { id } of page)
                demand.admit(
                    observedOrderValidationRequest(
                        1,
                        id,
                        "fixture:source-admission",
                    ),
                    now,
                );
            afterId = page.at(-1)!.id;
        }
    })();
    const admissionMs = performance.now() - admitStarted;
    owner.progress.recordHeadSample(
        owner.progress.captureHeadSample(1),
        heavyMakerBlock(last + rangeBlocks),
        now,
    );
    const waitingStarted = performance.now();
    const waiting = demand.claimBatch(1, "waiting-fixture", now);
    const waitingSelectionMs = performance.now() - waitingStarted;
    expect(waiting.claims).toHaveLength(0);
    expect(
        db
            .prepare(
                "SELECT COUNT(*) AS n FROM order_validation_demand WHERE pending=1 AND lease_owner IS NULL AND failures=0",
            )
            .get(),
    ).toEqual({ n: H.count });
    demand.admit(eventValidationRequest(1, small.id, last, H.blockHash), now);
    const readyStarted = performance.now();
    const ready = demand.claimBatch(1, "ready-fixture", now);
    const readySelectionMs = performance.now() - readyStarted;
    expect(ready.claims.map((claim) => claim.candidate.order.id)).toEqual([
        small.id,
    ]);
    const claim = ready.claims[0]!;
    demand.completeBatch(
        [
            {
                claim,
                result: {
                    status: ORDER_STATUS.Fillable,
                    reason: "fixture",
                    quantities: {
                        original: "1",
                        remaining: "1",
                        fillable: "1",
                    },
                },
            },
        ],
        {
            checkpoint: claim.checkpoint,
            block: claim.checkpoint.block,
            observedAt: now,
            admissionSequence: claim.demand.admissionSequence,
        },
        now,
    );
    expect(demand.get(1, small.id)?.pending).toBe(false);
    expect(
        db
            .prepare(
                "SELECT COUNT(*) AS n FROM order_validation_demand WHERE pending=1 AND lease_owner IS NULL AND failures=0",
            )
            .get(),
    ).toEqual({ n: H.count });
    const summary = (mode: string) => {
        const group = samples.filter((row) => row.mode === mode);
        const sorted = group
            .map((row) => row.milliseconds)
            .sort((a, b) => a - b);
        return {
            samples: sorted.length,
            medianMs: (sorted[5]! + sorted[6]!) / 2,
            maxMs: sorted.at(-1),
            maxSerializedBytes: Math.max(
                ...group.map((row) => row.serializedBytes),
            ),
            headers: rangeBlocks,
            transfers: group[0]!.transfers,
            criticalEffects: group[0]!.criticalEffects,
            followUps: group[0]!.followUps,
        };
    };
    const report = {
        orders: H.count + 2,
        largeMakerOrders: H.count,
        bufferedRanges: 1,
        headersAndMaker: summary("headers-and-maker"),
        transfersAndScopes: summary("transfers-and-scopes"),
        retainedMakerScopes: 1,
        perOrderDemandCreatedByWriter: 0,
        waiting: {
            count: H.count,
            admissionMs,
            selectionMs: waitingSelectionMs,
            claims: 0,
            failures: 0,
        },
        ready: { claims: 1, covered: 1, selectionMs: readySelectionMs },
        samples,
    };
    const output = join(
        fileURLToPath(new URL("../../", import.meta.url)),
        "tmp/sync-validation-revamp",
    );
    await mkdir(output, { recursive: true });
    await writeFile(
        join(output, `coordinated-writer-load-${Date.now()}.json`),
        JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
}, 30_000);
