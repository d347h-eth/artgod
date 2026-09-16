import dotenv from "dotenv";
import { resolveNatsRuntimeConfig } from "@artgod/shared/config/nats";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils";

dotenv.config({ path: resolveRuntimeEnvPath() });

export type NatsJobStreamMaintenanceConfig = {
    natsUrl: string;
    streamPrefix: string;
};

// Loads only the queue settings needed before backend and worker startup.
export function loadNatsJobStreamMaintenanceConfig(
    env: Record<string, string | undefined> = process.env,
): NatsJobStreamMaintenanceConfig {
    return resolveNatsRuntimeConfig(env);
}
