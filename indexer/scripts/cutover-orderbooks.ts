import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { loadOrderbookConfig } from "../src/config/opensea.js";
import { cutoverOrderbooks } from "../src/application/offchain/cutover-orderbooks.js";
import { SqliteOrderbookCutover } from "../src/infra/offchain/sqlite-orderbook-cutover.js";
import { NatsJobStreamMaintenanceAdapter } from "../src/infra/queue/nats-job-stream-maintenance.js";

const config = loadOrderbookConfig();
setDbPath(config.dbPath);
await createMigrationRunner().runMigrations();
const broker = await NatsJobStreamMaintenanceAdapter.connect(config.queue);
try {
    console.log(await cutoverOrderbooks(new SqliteOrderbookCutover(), broker));
} finally {
    await broker.close();
    db.raw.close();
}
