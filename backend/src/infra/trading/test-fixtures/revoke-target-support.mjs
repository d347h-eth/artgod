import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const requireBackend = createRequire(import.meta.url);
const Database = requireBackend("better-sqlite3");
const connection = new Database(workerData.dbPath);
connection.pragma("journal_mode = WAL");
connection.exec("BEGIN IMMEDIATE");

// Hold the independent writer through application preflight. The parent releases
// it immediately before entering the real job repository's write transaction.
parentPort.once("message", () => {
    connection
        .prepare(
            "DELETE FROM token_attributes WHERE chain_id = @chainId AND collection_id = @collectionId " +
                "AND attribute_id IN (SELECT a.id FROM attributes a JOIN attribute_keys k ON k.id = a.attribute_key_id " +
                "WHERE k.key = @key AND a.value = @value)",
        )
        .run(workerData);
    connection.exec("COMMIT");
    connection.close();
    parentPort.close();
});
parentPort.postMessage(null);
