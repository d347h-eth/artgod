import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { parseNumber, parseRequiredString } from "./index.js";

export type OffchainConfig = {
    chainId: number;
    queue: {
        natsUrl: string;
        streamPrefix: string;
    };
    opensea: {
        mode: "fixtures";
        fixturesDir: string;
        delayMs: number;
        source: string;
    };
};

export function loadOffchainConfig(
    env: Record<string, string | undefined> = process.env,
): OffchainConfig {
    const chainId = parseNumber(env.CHAIN_ID, "CHAIN_ID", 1);
    const mode = parseRequiredString(
        env.OPENSEA_STREAM_MODE,
        "OPENSEA_STREAM_MODE",
    );
    if (mode !== "fixtures") {
        throw new Error(`Unsupported OPENSEA_STREAM_MODE: ${mode}`);
    }
    const fixturesDir = parseRequiredString(
        env.OPENSEA_FIXTURES_DIR,
        "OPENSEA_FIXTURES_DIR",
    );
    const delayMs = parseNumber(
        env.OPENSEA_FIXTURE_DELAY_MS,
        "OPENSEA_FIXTURE_DELAY_MS",
        0,
    );

    return {
        chainId,
        queue: {
            natsUrl: env.NATS_URL ?? "nats://127.0.0.1:4222",
            streamPrefix: env.NATS_STREAM_PREFIX ?? "artgod",
        },
        opensea: {
            mode: "fixtures",
            fixturesDir: resolveProjectPath(fixturesDir),
            delayMs,
            source: "opensea",
        },
    };
}
