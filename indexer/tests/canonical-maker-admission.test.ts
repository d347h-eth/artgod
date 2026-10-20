import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { RetainCanonicalOrderEffects } from "../src/application/orders/retain-canonical-order-effects.js";
import { GLOBAL_MAKER_TRIGGER_REASON } from "../src/domain/maker-triggers.js";
import { ORDER_JOB_KIND } from "../src/domain/order-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import {
    emptyOnChainData,
    loadCollection,
    transferFixture,
} from "./helpers/ownership-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { REORG_FIXTURE } from "./helpers/reorg-recovery-fixture.js";

const MAKER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW = 1_800_000_000_000;

loadTestEnv();
describe("canonical maker admission owns its continuation", () => {
    let dbPath: string;
    beforeEach(async () => {
        dbPath = await createTempDbPath();
        setDbPath(dbPath);
        await createMigrationRunner().runMigrations();
    });

    function fixture(withBid: boolean) {
        const f = transferFixture();
        if (withBid)
            db.prepare(
                "INSERT INTO orders(id,chain_id,collection_id,kind,side,maker,contract_address,currency,quantity,source_status,fillability_status) VALUES ('fixture-bid',1,?,'seaport','buy',?,?,?,'1','active','fillable')",
            ).run(f.collectionId, MAKER, f.contract, REORG_FIXTURE.Weth);
        const orders = new SqliteOrdersDomain(REORG_FIXTURE.Weth);
        const demand = new SqliteOrderValidationDemand(orders);
        const makers = new SqliteMakerRevalidations(
            orders,
            demand,
            REORG_FIXTURE.Weth,
        );
        const owner = createAppliedSyncFixture({
            chainId: 1,
            anchor: block(100),
            collections: [loadCollection(1, f.collectionId)],
            orderEffects: new RetainCanonicalOrderEffects({ orders, makers }),
            now: () => NOW,
        });
        function range(height: number, addresses = [MAKER]) {
            const data = emptyOnChainData();
            for (const [logIndex, maker] of addresses.entries())
                data.global.makerTriggers.push({
                    maker,
                    reason: GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
                    blockNumber: height,
                    blockHash: block(height).hash,
                    txHash: block(height).hash,
                    logIndex,
                });
            return owner.applied({
                blocks: [block(height)],
                data,
                shared: true,
                collectionIds: [f.collectionId],
            });
        }
        return { ...owner, makers, range };
    }

    it("advances sync without retaining a run or queue message for irrelevant owners", () => {
        const f = fixture(false);
        f.commit(f.range(101, [MAKER, OTHER]));
        expect(count("maker_order_revalidation_runs")).toBe(0);
        expect(count("queue_outbox")).toBe(0);
        expect(count("order_validation_demand")).toBe(0);
        expect(f.progress.chainProgress(1)?.applied.number).toBe(101);
    });

    it("retains one continuation for an eligible scope and coalesces later events without duplicate publications", () => {
        const f = fixture(true);
        f.commit(f.range(101, [MAKER, OTHER]));
        f.commit(f.range(102, [MAKER, OTHER]));
        expect(count("maker_order_revalidation_runs")).toBe(1);
        expect(count("queue_outbox")).toBe(1);
        expect(count("maker_validation_delivery_origins")).toBe(0);
        expect(count("order_validation_demand")).toBe(0);
        const row = db
            .prepare(
                "SELECT run_id AS runId FROM maker_order_revalidation_runs",
            )
            .get() as { runId: string };
        const run = f.makers.get(row.runId)!;
        expect(run.requestedPayload.blockNumber).toBe(102);
        f.makers.scheduleWakeup(run, NOW);
        expect(count("queue_outbox")).toBe(1);
        expect(f.progress.chainProgress(1)?.applied.number).toBe(102);
    });

    it("keeps the admitted scope and its publication after reopening the database", () => {
        const f = fixture(true);
        f.commit(f.range(101));
        setDbPath(dbPath);
        const [publication] = new SqliteQueueOutbox().listDue(NOW, 10);
        expect(publication.queueName).toBe(QUEUE_NAMES.OrdersUpdateByMaker);
        const job = JSON.parse(publication.jobJson);
        expect(job.kind).toBe(ORDER_JOB_KIND.ContinueMaker);
        expect(job.payload).toEqual({
            chainId: 1,
            runId: expect.any(String),
            step: 0,
        });
        expect(
            db
                .prepare(
                    "SELECT wakeup_outbox_id AS outboxId FROM maker_order_revalidation_runs WHERE run_id=?",
                )
                .get(job.payload.runId),
        ).toEqual({ outboxId: publication.outboxId });
    });

    it("rolls back admission, facts and progress if continuation retention fails", () => {
        const f = fixture(true);
        db.exec(
            `CREATE TEMP TRIGGER fail_maker_wakeup BEFORE INSERT ON queue_outbox WHEN NEW.queue_name='${QUEUE_NAMES.OrdersUpdateByMaker}' BEGIN SELECT RAISE(ABORT,'maker wakeup unavailable'); END;`,
        );
        const result = f.range(101);
        expect(() => f.commit(result)).toThrow("maker wakeup unavailable");
        expect(count("maker_order_revalidation_runs")).toBe(0);
        expect(count("queue_outbox")).toBe(0);
        expect(count("blocks")).toBe(1);
        expect(f.progress.chainProgress(1)?.applied.number).toBe(100);
        db.exec("DROP TRIGGER fail_maker_wakeup");
        f.commit(result);
        expect(count("maker_order_revalidation_runs")).toBe(1);
        expect(count("queue_outbox")).toBe(1);
    });
});

function count(table: string): number {
    return (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
}
