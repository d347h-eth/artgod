#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const manifestPath = path.join(rootDir, "config", "settings.manifest.toml");
const envExamplePath = path.join(rootDir, ".env.example");

function parseTomlValue(raw) {
    const value = raw.trim();
    if (value === "true") {
        return true;
    }
    if (value === "false") {
        return false;
    }
    if (/^\d+$/.test(value)) {
        return Number(value);
    }
    if (value.startsWith("\"") || value.startsWith("[")) {
        return JSON.parse(value);
    }
    throw new Error(`Unsupported TOML value syntax: ${raw}`);
}

function parseManifest(source) {
    const document = {
        version: null,
        groups: [],
        settings: [],
    };
    let current = document;

    for (const [index, line] of source.split(/\r?\n/).entries()) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) {
            continue;
        }
        if (trimmed === "[[groups]]") {
            current = {};
            document.groups.push(current);
            continue;
        }
        if (trimmed === "[[settings]]") {
            current = {};
            document.settings.push(current);
            continue;
        }

        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
        if (!match) {
            throw new Error(
                `${manifestPath}:${index + 1}: unsupported manifest line: ${line}`,
            );
        }
        current[match[1]] = parseTomlValue(match[2]);
    }

    return document;
}

function requireString(value, location, errors) {
    if (typeof value !== "string") {
        errors.push(`${location}: expected string`);
        return "";
    }
    return value;
}

function validateManifest(manifest) {
    const errors = [];
    if (manifest.version !== 1) {
        errors.push(`version: expected 1, got ${manifest.version}`);
    }

    const groupIds = new Set();
    for (const [index, group] of manifest.groups.entries()) {
        const location = `groups[${index}]`;
        const id = requireString(group.id, `${location}.id`, errors);
        requireString(group.label, `${location}.label`, errors);
        if (id && groupIds.has(id)) {
            errors.push(`${location}.id: duplicate group id "${id}"`);
        }
        groupIds.add(id);
    }

    const keys = new Set();
    for (const [index, setting] of manifest.settings.entries()) {
        const location = `settings[${index}]`;
        const key = requireString(setting.key, `${location}.key`, errors);
        const group = requireString(setting.group, `${location}.group`, errors);
        requireString(setting.label, `${location}.label`, errors);
        requireString(setting.default, `${location}.default`, errors);
        if (setting.desktop_default !== undefined) {
            requireString(
                setting.desktop_default,
                `${location}.desktop_default`,
                errors,
            );
        }
        if (setting.help !== undefined) {
            requireString(setting.help, `${location}.help`, errors);
        }
        if (setting.view !== undefined) {
            requireString(setting.view, `${location}.view`, errors);
        }
        if (
            setting.required_for_launch !== undefined &&
            typeof setting.required_for_launch !== "boolean"
        ) {
            errors.push(`${location}.required_for_launch: expected boolean`);
        }
        if (setting.validation !== undefined) {
            const validation = requireString(
                setting.validation,
                `${location}.validation`,
                errors,
            );
            if (validation && !["url"].includes(validation)) {
                errors.push(
                    `${location}.validation: unsupported validation "${validation}"`,
                );
            }
        }
        if (setting.input !== undefined) {
            const input = requireString(setting.input, `${location}.input`, errors);
            if (
                input &&
                !["text", "password", "checkbox", "textarea", "select"].includes(
                    input,
                )
            ) {
                errors.push(`${location}.input: unsupported input "${input}"`);
            }
        }
        if (setting.options !== undefined) {
            if (!Array.isArray(setting.options)) {
                errors.push(`${location}.options: expected array`);
            } else {
                for (const option of setting.options) {
                    if (typeof option !== "string") {
                        errors.push(`${location}.options: expected string options`);
                    }
                }
            }
        }
        if (setting.secret !== undefined && typeof setting.secret !== "boolean") {
            errors.push(`${location}.secret: expected boolean`);
        }
        if (key && keys.has(key)) {
            errors.push(`${location}.key: duplicate setting key "${key}"`);
        }
        keys.add(key);
        if (group && !groupIds.has(group)) {
            errors.push(`${location}.group: unknown group "${group}"`);
        }
    }

    if (errors.length > 0) {
        throw new Error(`Invalid settings manifest:\n- ${errors.join("\n- ")}`);
    }
}

function quoteEnvValue(value) {
    if (!/[\s#]/.test(value)) {
        return value;
    }
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function formatHelp(help) {
    if (typeof help !== "string" || help.trim().length === 0) {
        return [];
    }
    return help
        .trim()
        .split(/\r?\n/)
        .map((line) => `# ${line.trim()}`);
}

function generateEnvExample(manifest) {
    const groupLabels = new Map(
        manifest.groups.map((group) => [group.id, group.label]),
    );
    const lines = [
        "# Generated from config/settings.manifest.toml.",
        "# Do not edit directly; run `yarn config:generate`.",
    ];

    for (const group of manifest.groups) {
        const settings = manifest.settings.filter(
            (setting) => setting.group === group.id,
        );
        if (settings.length === 0) {
            continue;
        }

        lines.push("", `# ${groupLabels.get(group.id)}`);
        for (const setting of settings) {
            lines.push(...formatHelp(setting.help));
            lines.push(`${setting.key}=${quoteEnvValue(setting.default)}`);
        }
    }

    lines.push("");
    return lines.join("\n");
}

async function main() {
    const check = process.argv.includes("--check");
    const source = await readFile(manifestPath, "utf8");
    const manifest = parseManifest(source);
    validateManifest(manifest);
    const generated = generateEnvExample(manifest);

    if (check) {
        const existing = await readFile(envExamplePath, "utf8");
        if (existing !== generated) {
            console.error(
                ".env.example is stale. Run `yarn config:generate` and commit the result.",
            );
            process.exit(1);
        }
        console.log(".env.example is up to date.");
        return;
    }

    await writeFile(envExamplePath, generated, "utf8");
    console.log("Generated .env.example from config/settings.manifest.toml.");
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
