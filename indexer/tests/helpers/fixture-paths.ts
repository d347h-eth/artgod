import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveFixturePath(
    importMetaUrl: string,
    ...segments: string[]
): string {
    const testFilePath = fileURLToPath(importMetaUrl);
    return path.resolve(path.dirname(testFilePath), "fixtures", ...segments);
}
