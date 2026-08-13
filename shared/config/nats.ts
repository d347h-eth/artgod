import { getSettingDefault } from "./generated-settings-defaults.js";

// Owns the environment vocabulary shared by NATS-backed runtime adapters.
export const NATS_ENV_KEY = {
    Url: "NATS_URL",
    StreamPrefix: "NATS_STREAM_PREFIX",
} as const;

// Resolves the manifest-backed NATS connection settings for a local runtime.
export function resolveNatsRuntimeConfig(
    env: Record<string, string | undefined>,
): { natsUrl: string; streamPrefix: string } {
    return {
        natsUrl: env[NATS_ENV_KEY.Url] ?? getSettingDefault(NATS_ENV_KEY.Url),
        streamPrefix:
            env[NATS_ENV_KEY.StreamPrefix] ??
            getSettingDefault(NATS_ENV_KEY.StreamPrefix),
    };
}
