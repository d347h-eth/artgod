import dotenv from "dotenv";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { parseRequiredString } from "@artgod/shared/utils/env";
import { parseArgs } from "node:util";
import runtime from "@artgod/shared/market-data/recovery-runtime" with { type: "json" };

dotenv.config({ path: resolveRuntimeEnvPath() });

/** Recovery does not need marketplace keys, RPC endpoints or wallet configuration. */
export function loadSqliteMarketDataMaintenanceConfig(
    env = process.env,
    args = process.argv.slice(2),
): {
    databasePath: string;
    compactOnly: boolean;
    compact: boolean;
} {
    const compactKey = runtime.cliArguments.compact.slice(2);
    const onlyKey = runtime.cliArguments.compactOnly.slice(2);
    const { values } = parseArgs({
        args,
        options: {
            [compactKey]: { type: "boolean" },
            [onlyKey]: { type: "boolean" },
        },
    });
    if (values[compactKey] && values[onlyKey])
        throw new Error(
            "Choose either compaction-only or recovery with compaction",
        );
    const databasePath = parseRequiredString(
        env.ARTGOD_DB_PATH,
        "ARTGOD_DB_PATH",
    );
    return {
        databasePath: resolveProjectPath(databasePath),
        compactOnly: values[onlyKey] === true,
        compact: values[compactKey] === true,
    };
}
