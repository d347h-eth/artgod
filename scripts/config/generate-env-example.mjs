#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const manifestPath = path.join(rootDir, "config", "settings.manifest.toml");
const validationRulesPath = path.join(
    rootDir,
    "config",
    "settings-validation-rules.json",
);
const envExamplePath = path.join(rootDir, ".env.example");
const envDeployExamplePath = path.join(rootDir, ".env.deploy.example");
const generatedDefaultsPath = path.join(
    rootDir,
    "shared",
    "config",
    "generated-settings-defaults.ts",
);
const generatedValidationRulesPath = path.join(
    rootDir,
    "shared",
    "config",
    "generated-settings-validation-rules.ts",
);
const generatedDesktopAdminConfigPath = path.join(
    rootDir,
    "frontend",
    "src",
    "lib",
    "e2e",
    "generated-desktop-admin-config.ts",
);
const SUPPORTED_TARGETS = ["local", "deploy", "desktop"];
const DEFAULT_TARGETS = SUPPORTED_TARGETS;

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
    if (value.startsWith("{")) {
        return parseInlineTable(value);
    }
    if (value.startsWith('"') || value.startsWith("[")) {
        return JSON.parse(value);
    }
    throw new Error(`Unsupported TOML value syntax: ${raw}`);
}

function parseInlineTable(raw) {
    if (!raw.endsWith("}")) {
        throw new Error(`Unsupported TOML inline table syntax: ${raw}`);
    }
    const content = raw.slice(1, -1).trim();
    if (!content) {
        return {};
    }
    const table = {};
    for (const entry of splitInlineTableEntries(content)) {
        const match = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
        if (!match) {
            throw new Error(`Unsupported TOML inline table entry: ${entry}`);
        }
        table[match[1]] = parseTomlValue(match[2]);
    }
    return table;
}

function splitInlineTableEntries(content) {
    const entries = [];
    let current = "";
    let inString = false;
    let escaped = false;
    for (const char of content) {
        if (inString) {
            current += char;
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            current += char;
            continue;
        }
        if (char === ",") {
            entries.push(current.trim());
            current = "";
            continue;
        }
        current += char;
    }
    if (inString) {
        throw new Error(`Unclosed string in TOML inline table: ${content}`);
    }
    if (current.trim()) {
        entries.push(current.trim());
    }
    return entries;
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

function validateStringArray(value, location, errors) {
    if (!Array.isArray(value)) {
        errors.push(`${location}: expected array`);
        return [];
    }
    const result = [];
    for (const entry of value) {
        if (typeof entry !== "string") {
            errors.push(`${location}: expected string entries`);
            continue;
        }
        result.push(entry);
    }
    return result;
}

function validateManifest(manifest, supportedValidationRules) {
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
        validateSettingDefaults(setting, location, errors);
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
        if (setting.targets !== undefined) {
            const targets = validateStringArray(
                setting.targets,
                `${location}.targets`,
                errors,
            );
            for (const target of targets) {
                if (!SUPPORTED_TARGETS.includes(target)) {
                    errors.push(
                        `${location}.targets: unsupported target "${target}"`,
                    );
                }
            }
        }
        if (
            setting.required_for_launch !== undefined &&
            typeof setting.required_for_launch !== "boolean"
        ) {
            errors.push(`${location}.required_for_launch: expected boolean`);
        }
        if (
            setting.desktop_managed !== undefined &&
            typeof setting.desktop_managed !== "boolean"
        ) {
            errors.push(`${location}.desktop_managed: expected boolean`);
        }
        if (setting.validation !== undefined) {
            const validation = requireString(
                setting.validation,
                `${location}.validation`,
                errors,
            );
            if (validation && !supportedValidationRules.has(validation)) {
                errors.push(
                    `${location}.validation: unsupported validation "${validation}"`,
                );
            }
        }
        if (setting.input !== undefined) {
            const input = requireString(
                setting.input,
                `${location}.input`,
                errors,
            );
            if (
                input &&
                ![
                    "text",
                    "password",
                    "checkbox",
                    "textarea",
                    "select",
                    "weighted_endpoint_list",
                ].includes(input)
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
                        errors.push(
                            `${location}.options: expected string options`,
                        );
                    }
                }
            }
        }
        if (
            setting.secret !== undefined &&
            typeof setting.secret !== "boolean"
        ) {
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

function validateSettingDefaults(setting, location, errors) {
    if (setting.default !== undefined) {
        requireString(setting.default, `${location}.default`, errors);
    }
    if (setting.defaults !== undefined) {
        if (
            !setting.defaults ||
            typeof setting.defaults !== "object" ||
            Array.isArray(setting.defaults)
        ) {
            errors.push(`${location}.defaults: expected inline table`);
        } else {
            for (const [target, value] of Object.entries(setting.defaults)) {
                if (!SUPPORTED_TARGETS.includes(target)) {
                    errors.push(
                        `${location}.defaults: unsupported target "${target}"`,
                    );
                }
                requireString(value, `${location}.defaults.${target}`, errors);
            }
        }
    }

    const targets = resolveTargets(setting);
    for (const target of targets) {
        const value = resolveDefaultForTarget(setting, target);
        if (value === undefined) {
            errors.push(`${location}: missing default for target "${target}"`);
        }
    }
}

function resolveTargets(setting) {
    return Array.isArray(setting.targets) ? setting.targets : DEFAULT_TARGETS;
}

function hasTarget(setting, target) {
    return resolveTargets(setting).includes(target);
}

function resolveDefaultForTarget(setting, target) {
    if (setting.defaults?.[target] !== undefined) {
        return setting.defaults[target];
    }
    if (target === "desktop" && setting.desktop_default !== undefined) {
        return setting.desktop_default;
    }
    if (setting.default !== undefined) {
        return setting.default;
    }
    return setting.defaults?.local;
}

function quoteEnvValue(value) {
    if (!/[\s#]/.test(value)) {
        return value;
    }
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

function generateEnvFile(manifest, target) {
    const groupLabels = new Map(
        manifest.groups.map((group) => [group.id, group.label]),
    );
    const lines = [
        "# Generated from config/settings.manifest.toml.",
        "# Do not edit directly; run `yarn config:generate`.",
    ];

    for (const group of manifest.groups) {
        const settings = manifest.settings.filter(
            (setting) =>
                setting.group === group.id && hasTarget(setting, target),
        );
        if (settings.length === 0) {
            continue;
        }

        lines.push("", `# ${groupLabels.get(group.id)}`);
        for (const setting of settings) {
            lines.push(...formatHelp(setting.help));
            lines.push(
                `${setting.key}=${quoteEnvValue(resolveDefaultForTarget(setting, target))}`,
            );
        }
    }

    lines.push("");
    return lines.join("\n");
}

function parseValidationRules(source) {
    const rules = JSON.parse(source);
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
        throw new Error(`${validationRulesPath}: expected an object`);
    }

    const values = new Set();
    for (const [name, value] of Object.entries(rules)) {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
            throw new Error(
                `${validationRulesPath}: invalid validation rule name ${name}`,
            );
        }
        if (typeof value !== "string" || value.trim().length === 0) {
            throw new Error(
                `${validationRulesPath}: validation rule ${name} must be a non-empty string`,
            );
        }
        if (values.has(value)) {
            throw new Error(
                `${validationRulesPath}: duplicate validation rule value ${value}`,
            );
        }
        values.add(value);
    }
    return rules;
}

async function generateSettingsValidationRulesModule(validationRules) {
    const source = [
        "// Generated from config/settings-validation-rules.json.",
        "// Do not edit directly; run `yarn config:generate`.",
        "",
        "// Validation rule names shared by the manifest generator and Admin clients.",
        `export const SETTINGS_VALIDATION_RULE = ${JSON.stringify(validationRules, null, 4)} as const;`,
        "",
        "// Exact validation vocabulary accepted by generated settings clients.",
        "export type SettingsValidationRule =",
        "    (typeof SETTINGS_VALIDATION_RULE)[keyof typeof SETTINGS_VALIDATION_RULE];",
        "",
    ].join("\n");
    const prettierOptions =
        (await resolveConfig(generatedValidationRulesPath)) ?? {};
    return format(source, {
        ...prettierOptions,
        parser: "typescript",
    });
}

async function generateDesktopAdminConfigModule(manifest) {
    const desktopSettings = manifest.settings.filter(
        (setting) =>
            hasTarget(setting, "desktop") && setting.desktop_managed !== false,
    );
    const desktopGroupIds = new Set(
        desktopSettings.map((setting) => setting.group),
    );
    const schema = {
        groups: manifest.groups
            .filter((group) => desktopGroupIds.has(group.id))
            .map((group) => ({
                id: group.id,
                label: group.label,
                fields: desktopSettings
                    .filter((setting) => setting.group === group.id)
                    .map((setting) => ({
                        key: setting.key,
                        label: setting.label,
                        inputKind: setting.input ?? "text",
                        secret: setting.secret ?? false,
                        options: setting.options ?? [],
                        help: setting.help ?? "",
                        requiredForLaunch: setting.required_for_launch ?? false,
                        validation: setting.validation ?? null,
                        ...(setting.view === undefined
                            ? {}
                            : { view: setting.view }),
                    })),
            })),
        defaults: Object.fromEntries(
            desktopSettings.map((setting) => [
                setting.key,
                resolveDefaultForTarget(setting, "desktop"),
            ]),
        ),
    };
    const source = [
        "// Generated from the desktop-managed settings in config/settings.manifest.toml.",
        "// Do not edit directly; run `yarn config:generate`.",
        "",
        "// Exact native Admin schema used by the maintained browser harness.",
        `export const DESKTOP_ADMIN_CONFIG_SCHEMA = ${JSON.stringify(schema, null, 4)} as const;`,
        "",
    ].join("\n");
    const prettierOptions =
        (await resolveConfig(generatedDesktopAdminConfigPath)) ?? {};
    return format(source, {
        ...prettierOptions,
        parser: "typescript",
    });
}

async function generateSettingsDefaultsModule(manifest) {
    const defaults = Object.fromEntries(
        manifest.settings
            .filter((setting) => hasTarget(setting, "local"))
            .map((setting) => [
                setting.key,
                resolveDefaultForTarget(setting, "local"),
            ]),
    );
    const source = [
        "// Generated from config/settings.manifest.toml.",
        "// Do not edit directly; run `yarn config:generate`.",
        "",
        "// Manifest defaults consumed by runtime config modules and generation checks.",
        `export const SETTINGS_DEFAULTS = ${JSON.stringify(defaults, null, 4)} as const;`,
        "",
        "// Settings keys known to the generated defaults module.",
        "export type SettingsDefaultKey = keyof typeof SETTINGS_DEFAULTS;",
        "// Identity map for importing manifest-owned setting keys without repeating wire literals.",
        "export const SETTINGS_KEY = Object.freeze(",
        "    Object.fromEntries(",
        "        Object.keys(SETTINGS_DEFAULTS).map((key) => [key, key]),",
        "    ),",
        ") as { readonly [Key in SettingsDefaultKey]: Key };",
        "// Exact generated defaults shape.",
        "export type SettingsDefaults = typeof SETTINGS_DEFAULTS;",
        "",
        "// Returns the raw string default from the settings manifest.",
        "export function getSettingDefault(key: SettingsDefaultKey): string {",
        "    return SETTINGS_DEFAULTS[key];",
        "}",
        "",
        "// Parses a numeric settings manifest default.",
        "export function getSettingDefaultNumber(key: SettingsDefaultKey): number {",
        "    const value = getSettingDefault(key);",
        "    const parsed = Number(value);",
        "    if (!Number.isFinite(parsed)) {",
        "        throw new Error(`Invalid numeric settings manifest default ${key}: ${value}`);",
        "    }",
        "    return parsed;",
        "}",
        "",
        "// Parses a boolean settings manifest default.",
        "export function getSettingDefaultBoolean(key: SettingsDefaultKey): boolean {",
        "    const value = getSettingDefault(key).trim().toLowerCase();",
        '    if (value === "true") {',
        "        return true;",
        "    }",
        '    if (value === "false") {',
        "        return false;",
        "    }",
        "    throw new Error(`Invalid boolean settings manifest default ${key}: ${value}`);",
        "}",
        "",
        "// Parses a comma-separated settings manifest default.",
        "export function getSettingDefaultCsv(key: SettingsDefaultKey): string[] {",
        "    return getSettingDefault(key)",
        '        .split(",")',
        "        .map((entry) => entry.trim())",
        "        .filter((entry) => entry.length > 0);",
        "}",
        "",
    ].join("\n");
    const prettierOptions = (await resolveConfig(generatedDefaultsPath)) ?? {};
    return format(source, {
        ...prettierOptions,
        parser: "typescript",
    });
}

async function main() {
    const check = process.argv.includes("--check");
    const [source, validationRulesSource] = await Promise.all([
        readFile(manifestPath, "utf8"),
        readFile(validationRulesPath, "utf8"),
    ]);
    const manifest = parseManifest(source);
    const validationRules = parseValidationRules(validationRulesSource);
    validateManifest(manifest, new Set(Object.values(validationRules)));
    const generated = generateEnvFile(manifest, "local");
    const generatedDeploy = generateEnvFile(manifest, "deploy");
    const generatedDefaults = await generateSettingsDefaultsModule(manifest);
    const generatedValidationRules =
        await generateSettingsValidationRulesModule(validationRules);
    const generatedDesktopAdminConfig =
        await generateDesktopAdminConfigModule(manifest);

    if (check) {
        const existing = await readFile(envExamplePath, "utf8");
        if (existing !== generated) {
            console.error(
                ".env.example is stale. Run `yarn config:generate` and commit the result.",
            );
            process.exit(1);
        }
        const existingDeploy = await readFile(envDeployExamplePath, "utf8");
        if (existingDeploy !== generatedDeploy) {
            console.error(
                ".env.deploy.example is stale. Run `yarn config:generate` and commit the result.",
            );
            process.exit(1);
        }
        const existingDefaults = await readFile(generatedDefaultsPath, "utf8");
        if (existingDefaults !== generatedDefaults) {
            console.error(
                "shared/config/generated-settings-defaults.ts is stale. Run `yarn config:generate` and commit the result.",
            );
            process.exit(1);
        }
        const existingValidationRules = await readFile(
            generatedValidationRulesPath,
            "utf8",
        );
        if (existingValidationRules !== generatedValidationRules) {
            console.error(
                "shared/config/generated-settings-validation-rules.ts is stale. Run `yarn config:generate` and commit the result.",
            );
            process.exit(1);
        }
        const existingDesktopAdminConfig = await readFile(
            generatedDesktopAdminConfigPath,
            "utf8",
        );
        if (existingDesktopAdminConfig !== generatedDesktopAdminConfig) {
            console.error(
                "frontend/src/lib/e2e/generated-desktop-admin-config.ts is stale. Run `yarn config:generate` and commit the result.",
            );
            process.exit(1);
        }
        console.log(".env.example is up to date.");
        console.log(".env.deploy.example is up to date.");
        console.log(
            "shared/config/generated-settings-defaults.ts is up to date.",
        );
        console.log(
            "shared/config/generated-settings-validation-rules.ts is up to date.",
        );
        console.log(
            "frontend/src/lib/e2e/generated-desktop-admin-config.ts is up to date.",
        );
        return;
    }

    await writeFile(envExamplePath, generated, "utf8");
    await writeFile(envDeployExamplePath, generatedDeploy, "utf8");
    await writeFile(generatedDefaultsPath, generatedDefaults, "utf8");
    await writeFile(
        generatedValidationRulesPath,
        generatedValidationRules,
        "utf8",
    );
    await writeFile(
        generatedDesktopAdminConfigPath,
        generatedDesktopAdminConfig,
        "utf8",
    );
    console.log(
        "Generated env examples and shared settings contracts from the config manifests.",
    );
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
