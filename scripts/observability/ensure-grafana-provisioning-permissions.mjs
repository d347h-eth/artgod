#!/usr/bin/env node
import { chmod, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

// Grafana reads these bind-mounted provisioning trees from inside the container.
const GRAFANA_PROVISIONING_ROOTS = [
    path.join(rootDir, "observability", "grafana", "provisioning"),
    path.join(rootDir, "observability", "grafana", "provisioning-deploy"),
];

// Directories need execute permission so the Grafana container can traverse them.
const PROVISIONING_DIRECTORY_MODE = 0o755;

// Provisioning YAML/JSON files are data inputs and should not be executable.
const PROVISIONING_FILE_MODE = 0o644;

if (isExecutedDirectly()) {
    await ensureGrafanaProvisioningPermissions();
}

export async function ensureGrafanaProvisioningPermissions() {
    const checkedPaths = [];

    for (const provisioningRoot of GRAFANA_PROVISIONING_ROOTS) {
        await normalizePermissions(provisioningRoot, checkedPaths);
    }

    console.log(
        `Grafana provisioning permissions checked for ${checkedPaths.length} paths.`,
    );
}

function isExecutedDirectly() {
    return (
        process.argv[1] !== undefined &&
        path.resolve(process.argv[1]) === __filename
    );
}

async function normalizePermissions(targetPath, checkedPaths) {
    const fileStatus = await lstat(targetPath);

    if (fileStatus.isSymbolicLink()) {
        return;
    }

    if (fileStatus.isDirectory()) {
        await chmod(targetPath, PROVISIONING_DIRECTORY_MODE);
        checkedPaths.push(path.relative(rootDir, targetPath));

        const entries = await readdir(targetPath, { withFileTypes: true });
        const sortedEntries = entries.sort((left, right) =>
            left.name.localeCompare(right.name),
        );

        for (const entry of sortedEntries) {
            await normalizePermissions(
                path.join(targetPath, entry.name),
                checkedPaths,
            );
        }

        return;
    }

    if (fileStatus.isFile()) {
        await chmod(targetPath, PROVISIONING_FILE_MODE);
        checkedPaths.push(path.relative(rootDir, targetPath));
    }
}
