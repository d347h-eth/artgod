import { resolveProjectPath } from "./paths.js";

/**
 * Resolves which env file should be loaded for runtime startup.
 *
 * `ARTGOD_ENV_FILE` lets external launchers (eg. Tauri desktop supervisor)
 * point backend/indexer processes to an explicit env file outside the repo.
 * If unset, runtimes keep using the project-local default file.
 */
export function resolveRuntimeEnvPath(
    env: Record<string, string | undefined> = process.env,
    defaultRelativePath = ".env",
): string {
    const explicitPath = env.ARTGOD_ENV_FILE?.trim();
    if (explicitPath) {
        return explicitPath;
    }
    return resolveProjectPath(defaultRelativePath);
}
