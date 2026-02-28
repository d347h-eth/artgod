import dotenv from "dotenv";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils";
import {
    parsePositiveInteger,
    parseRequiredString,
} from "@artgod/shared/utils/env";

dotenv.config({ path: resolveRuntimeEnvPath(process.env, ".env") });

export type BackendConfig = {
    port: number;
    defaultChainId: number;
    dbPath: string;
};

export function loadBackendConfig(
    env: Record<string, string | undefined> = process.env,
): BackendConfig {
    const port = parsePositiveInteger(env.BACKEND_PORT, "BACKEND_PORT", 3000);
    const defaultChainId = parsePositiveInteger(env.CHAIN_ID, "CHAIN_ID", 1);
    const dbPath = parseRequiredString(env.ARTGOD_DB_PATH, "ARTGOD_DB_PATH");

    return {
        port,
        defaultChainId,
        dbPath,
    };
}
