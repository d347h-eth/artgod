import fs from "node:fs";
import dotenv from "dotenv";
import { resolveProjectPath } from "@artgod/shared/utils/paths";

export function loadTestEnv(
    filename = ".env.test",
): Record<string, string | undefined> {
    const envPath = resolveProjectPath(filename);
    const fileEnv = fs.existsSync(envPath)
        ? dotenv.parse(fs.readFileSync(envPath))
        : {};
    for (const [key, value] of Object.entries(fileEnv)) {
        process.env[key] = value;
    }
    return { ...process.env, ...fileEnv };
}
