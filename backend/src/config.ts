import dotenv from "dotenv";
import { resolveProjectPath } from "@artgod/shared/utils";
import { parsePositiveInteger } from "@artgod/shared/utils/env";

dotenv.config({ path: resolveProjectPath(".env") });

export type BackendConfig = {
    port: number;
    defaultChainId: number;
};

export function loadBackendConfig(
    env: Record<string, string | undefined> = process.env,
): BackendConfig {
    const port = parsePositiveInteger(env.BACKEND_PORT, "BACKEND_PORT", 3000);
    const defaultChainId = parsePositiveInteger(env.CHAIN_ID, "CHAIN_ID", 1);

    return {
        port,
        defaultChainId,
    };
}
