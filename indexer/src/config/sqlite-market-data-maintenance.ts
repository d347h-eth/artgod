import dotenv from "dotenv";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils";
import { resolveProjectPath } from "@artgod/shared/utils/paths";

dotenv.config({ path: resolveRuntimeEnvPath() });

/** Recovery does not need marketplace keys, RPC endpoints or wallet configuration. */
export function loadSqliteMarketDataMaintenanceConfig(env = process.env): {
    databasePath: string;
} {
    const databasePath = env.ARTGOD_DB_PATH?.trim();
    if (!databasePath)
        throw new Error(
            "ARTGOD_DB_PATH is required for SQLite market-data maintenance",
        );
    return { databasePath: resolveProjectPath(databasePath) };
}
