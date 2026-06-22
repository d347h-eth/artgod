import {
    getSettingDefaultBoolean,
    type SettingsDefaultKey,
} from "./generated-settings-defaults.js";
import { parseBoolean } from "../utils/env.js";

// Env keys for retaining large raw/debug payloads in SQLite.
export const DEBUG_PAYLOAD_PERSISTENCE_ENV_KEY = {
    PersistRawDebugPayloads: "PERSIST_RAW_DEBUG_PAYLOADS",
} as const satisfies Record<string, SettingsDefaultKey>;

// Runtime policy for DB columns that exist only for source-payload debugging.
export type DebugPayloadPersistenceConfig = {
    persistRawDebugPayloads: boolean;
};

// Parses raw/debug payload retention from manifest-backed env values.
export function parseDebugPayloadPersistenceConfig(
    env: Record<string, string | undefined>,
): DebugPayloadPersistenceConfig {
    return {
        persistRawDebugPayloads: parseBoolean(
            env[DEBUG_PAYLOAD_PERSISTENCE_ENV_KEY.PersistRawDebugPayloads],
            DEBUG_PAYLOAD_PERSISTENCE_ENV_KEY.PersistRawDebugPayloads,
            getSettingDefaultBoolean(
                DEBUG_PAYLOAD_PERSISTENCE_ENV_KEY.PersistRawDebugPayloads,
            ),
        ),
    };
}

// Returns the manifest default policy for adapters constructed in tests.
export function getDefaultDebugPayloadPersistenceConfig(): DebugPayloadPersistenceConfig {
    return parseDebugPayloadPersistenceConfig({});
}
