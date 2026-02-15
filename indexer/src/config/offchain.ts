import { resolveProjectPath } from "@artgod/shared/utils/paths";
import {
    parseBoolean,
    parseNumber,
    parseRequiredString,
} from "@artgod/shared/utils/env";

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
    apm: {
        enabled: boolean;
        serviceNamespace: string;
        spanProfiles: {
            enabled: boolean;
        };
        traces: {
            enabled: boolean;
            otlpHttpUrl: string;
        };
        profiles: {
            enabled: boolean;
            pyroscopeUrl: string;
        };
    };
    metrics: {
        enabled: boolean;
        host: string;
        port: number;
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
        apm: {
            enabled: parseBoolean(env.APM_ENABLED, "APM_ENABLED", false),
            serviceNamespace: env.APM_SERVICE_NAMESPACE ?? "artgod.indexer",
            spanProfiles: {
                enabled: parseBoolean(
                    env.APM_SPAN_PROFILES_ENABLED,
                    "APM_SPAN_PROFILES_ENABLED",
                    true,
                ),
            },
            traces: {
                enabled: parseBoolean(
                    env.APM_TRACES_ENABLED,
                    "APM_TRACES_ENABLED",
                    true,
                ),
                otlpHttpUrl:
                    env.APM_OTLP_HTTP_URL ?? "http://127.0.0.1:4318/v1/traces",
            },
            profiles: {
                enabled: parseBoolean(
                    env.APM_PROFILES_ENABLED,
                    "APM_PROFILES_ENABLED",
                    true,
                ),
                pyroscopeUrl: env.APM_PYROSCOPE_URL ?? "http://127.0.0.1:4040",
            },
        },
        metrics: {
            enabled: parseBoolean(
                env.METRICS_ENABLED,
                "METRICS_ENABLED",
                false,
            ),
            host: env.METRICS_HOST ?? "0.0.0.0",
            port: parseNumber(
                env.METRICS_PORT_OPENSEA_STREAM_WORKER,
                "METRICS_PORT_OPENSEA_STREAM_WORKER",
                9469,
            ),
        },
    };
}
