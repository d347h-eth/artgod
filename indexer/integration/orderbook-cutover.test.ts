import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import {
    createMigrationRunner,
    MigrationRunner,
} from "@artgod/shared/migrations";
import { ORDERBOOK_VENUE } from "@artgod/shared/market-data/orders";
import { getSettingDefault } from "@artgod/shared/config/generated-settings-defaults";
import { OPENSEA_COLLECTION_STATUS } from "@artgod/shared/types";
import { cutoverOrderbooks } from "../src/application/offchain/cutover-orderbooks.js";
import { consumeOrderUpsert } from "../src/application/orders/consume-order-upsert.js";
import { SqliteOrderbookCutover } from "../src/infra/offchain/sqlite-orderbook-cutover.js";
import { SqliteOrderSourceStateStore } from "../src/infra/offchain/sqlite-order-source-state.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import { NatsJobStreamMaintenanceAdapter } from "../src/infra/queue/nats-job-stream-maintenance.js";
import { SqliteQueueOutbox } from "../src/infra/queue/sqlite-queue-outbox.js";
import { QUEUE_NAMES, type QueueName } from "../src/domain/queues.js";
import {
    ORDER_JOB_KIND,
    type OrderUpsertPayload,
} from "../src/domain/order-jobs.js";
import { DOMAIN_JOB_KIND } from "../src/domain/domain-jobs.js";
import {
    IsolatedNats,
    waitForFixture,
} from "../tests/helpers/isolated-nats.js";

it("retires legacy passive work on upgrade and preserves unrelated deliveries and local history", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const binary = process.env.OPENSEA_RECONCILE_TEST_NATS_BINARY;
    if (!binary) throw new Error("Missing OPENSEA_RECONCILE_TEST_NATS_BINARY");
    const dir = await mkdtemp(path.join(root, "tmp/cutover-"));
    const migrations = path.join(root, "database/migrations");
    const prior = path.join(dir, "prior");
    await mkdir(prior);
    for (const name of await readdir(migrations))
        if (name.endsWith(".sql") && name < "078_")
            await copyFile(path.join(migrations, name), path.join(prior, name));
    setDbPath(path.join(dir, "upgrade.sqlite"));
    await new MigrationRunner(prior).runMigrations();
    db.exec(`INSERT INTO orders(id,chain_id,collection_id,kind,maker,contract_address,fillability_status) VALUES('legacy',1,1,'seaport','maker','contract','fillable');
        UPDATE collections SET opensea_status='ready' WHERE collection_id=1;
        INSERT INTO blocks(chain_id,block_number,block_hash,parent_hash,timestamp) VALUES(1,4,'block','parent',100);
        INSERT INTO trading_jobs(job_id,bot_kind,chain_id,collection_id,status,target_kind) VALUES('bot','bidding',1,1,'paused','collection');
        INSERT INTO activities(chain_id,collection_id,scope_kind,kind,contract_address,occurred_at,source_kind,source_name,dedupe_key,listing_day,price)
          VALUES(1,1,'token','listing','contract',100,'stream','opensea','history',0,'100');`);
    const broker = await IsolatedNats.start(binary, dir, dir + "/broker");
    const config = { natsUrl: broker.url, streamPrefix: "cutover" };
    const queue = await NatsJetStreamQueue.connect(config);
    const maintenance = await NatsJobStreamMaintenanceAdapter.connect(config);
    const job = (queue: QueueName, kind: string) => ({
        queue,
        kind,
        jobId: kind,
        chainId: 1,
        collectionId: 1,
        scheduledAt: Date.now(),
        attempt: 0,
        payload: {},
    });
    const metadata = job(
        QUEUE_NAMES.MetadataDomain,
        DOMAIN_JOB_KIND.MetadataRefresh,
    );
    const order = job(QUEUE_NAMES.OrdersUpsert, ORDER_JOB_KIND.Upsert);
    const mixed = job(QUEUE_NAMES.OffchainOrdersRaw, "mixed-fixture");
    try {
        const outbox = new SqliteQueueOutbox();
        for (const message of [order, metadata]) {
            outbox.enqueueRequiredJob(message);
            await queue.publish(message.queue, message);
        }
        await queue.publish(mixed.queue, mixed);
        await createMigrationRunner().runMigrations();
        const store = new SqliteOrderbookCutover();
        expect(
            () =>
                new SqliteOrderSourceStateStore(
                    getSettingDefault("WETH_ADDRESS"),
                ),
        ).toThrow("cutover");
        await expect(cutoverOrderbooks(store, maintenance)).rejects.toThrow(
            "Drain mixed",
        );
        expect(store.pending()).toBe(true);
        const delivered: string[] = [];
        const drain = async (message: typeof metadata) => {
            const stop = await queue.subscribe(
                message.queue,
                async (delivery) => {
                    await delivery.ack();
                    delivered.push(delivery.data.jobId);
                },
                { consumerName: message.queue },
            );
            try {
                await waitForFixture(
                    () => delivered.includes(message.jobId),
                    "surviving " + message.queue,
                );
            } finally {
                await stop();
            }
        };
        await drain(mixed);
        expect(await cutoverOrderbooks(store, maintenance)).toEqual({
            applied: true,
            retired: 1,
        });
        await drain(metadata);
        expect(await cutoverOrderbooks(store, maintenance)).toEqual({
            applied: false,
            retired: 0,
        });
        const handleOrderUpsert = vi.fn();
        await consumeOrderUpsert(
            {
                ...order,
                payload: {
                    source: ORDERBOOK_VENUE.OpenSea,
                } as OrderUpsertPayload,
            },
            { handleOrderUpsert },
        );
        expect(handleOrderUpsert).not.toHaveBeenCalled();
        expect(db.prepare("SELECT job_kind FROM queue_outbox").all()).toEqual([
            { job_kind: metadata.kind },
        ]);
        expect(db.prepare("SELECT id FROM orders").all()).toEqual([]);
        expect(
            db
                .prepare(
                    "SELECT price FROM activities WHERE dedupe_key='history'",
                )
                .get(),
        ).toEqual({ price: "100" });
        expect(
            db
                .prepare("SELECT block_hash FROM blocks WHERE block_number=4")
                .get(),
        ).toEqual({ block_hash: "block" });
        expect(db.prepare("SELECT job_id FROM trading_jobs").get()).toEqual({
            job_id: "bot",
        });
        expect(
            db
                .prepare(
                    "SELECT opensea_status FROM collections WHERE collection_id=1",
                )
                .get(),
        ).toEqual({ opensea_status: OPENSEA_COLLECTION_STATUS.Pending });
    } finally {
        await maintenance.close();
        await queue.close();
        await broker.stop();
        db.raw.close();
    }
});
