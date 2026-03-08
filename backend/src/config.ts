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
    wethAddress: string;
    natsUrl: string;
    natsStreamPrefix: string;
    userlandUiDistDir: string | null;
};

function parseAddress(value: string | undefined, name: string): string {
    if (!value) {
        throw new Error(`Missing ${name}`);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return value;
}

export function loadBackendConfig(
    env: Record<string, string | undefined> = process.env,
): BackendConfig {
    const port = parsePositiveInteger(env.BACKEND_PORT, "BACKEND_PORT", 3000);
    const defaultChainId = parsePositiveInteger(env.CHAIN_ID, "CHAIN_ID", 1);
    const dbPath = parseRequiredString(env.ARTGOD_DB_PATH, "ARTGOD_DB_PATH");
    const wethAddress = parseAddress(env.WETH_ADDRESS, "WETH_ADDRESS");
    const natsUrl = parseRequiredString(env.NATS_URL, "NATS_URL");
    const natsStreamPrefix = parseRequiredString(
        env.NATS_STREAM_PREFIX,
        "NATS_STREAM_PREFIX",
    );
    const userlandUiDistDir = env.USERLAND_UI_DIST_DIR?.trim() || null;

    return {
        port,
        defaultChainId,
        dbPath,
        wethAddress,
        natsUrl,
        natsStreamPrefix,
        userlandUiDistDir,
    };
}
