import {
    getSettingDefault,
    type SettingsDefaultKey,
} from "./generated-settings-defaults.js";

// Env key for the base block explorer URL used by frontend lookup links.
export const BLOCK_EXPLORER_BASE_URL_ENV_KEY =
    "BLOCK_EXPLORER_BASE_URL" as const satisfies SettingsDefaultKey;

// Env key for the transaction lookup path/query template.
export const BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY =
    "BLOCK_EXPLORER_TX_PATH_TEMPLATE" as const satisfies SettingsDefaultKey;

// Env key for the address lookup path/query template.
export const BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE_ENV_KEY =
    "BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE" as const satisfies SettingsDefaultKey;

// Env key for the block lookup path/query template.
export const BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE_ENV_KEY =
    "BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE" as const satisfies SettingsDefaultKey;

// Placeholder replaced with the encoded transaction hash when building tx URLs.
export const BLOCK_EXPLORER_TX_HASH_PLACEHOLDER = "{tx_hash}";

// Placeholder replaced with the encoded address when building address URLs.
export const BLOCK_EXPLORER_ADDRESS_PLACEHOLDER = "{address}";

// Placeholder replaced with the encoded block number when building block URLs.
export const BLOCK_EXPLORER_BLOCK_NUMBER_PLACEHOLDER = "{block_number}";

// Settings keys owned by the block explorer config contract.
export const BLOCK_EXPLORER_CONFIG_ENV_KEYS = [
    BLOCK_EXPLORER_BASE_URL_ENV_KEY,
    BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY,
    BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE_ENV_KEY,
    BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE_ENV_KEY,
] as const;

export type BlockExplorerConfigEnvKey =
    (typeof BLOCK_EXPLORER_CONFIG_ENV_KEYS)[number];

export type BlockExplorerConfig = {
    baseUrl: string;
    transactionPathTemplate: string;
    addressPathTemplate: string;
    blockPathTemplate: string;
};

// Returns the manifest-backed default block explorer config.
export function getDefaultBlockExplorerConfig(): BlockExplorerConfig {
    return parseBlockExplorerConfig({});
}

// Returns the manifest-backed default block explorer URL base.
export function getDefaultBlockExplorerBaseUrl(): string {
    return getSettingDefault(BLOCK_EXPLORER_BASE_URL_ENV_KEY);
}

// Returns the manifest-backed default transaction lookup path template.
export function getDefaultBlockExplorerTransactionPathTemplate(): string {
    return getSettingDefault(BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY);
}

// Returns the manifest-backed default address lookup path template.
export function getDefaultBlockExplorerAddressPathTemplate(): string {
    return getSettingDefault(BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE_ENV_KEY);
}

// Returns the manifest-backed default block lookup path template.
export function getDefaultBlockExplorerBlockPathTemplate(): string {
    return getSettingDefault(BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE_ENV_KEY);
}

// Parses the block explorer config from runtime env values.
export function parseBlockExplorerConfig(
    env: Record<string, string | undefined>,
): BlockExplorerConfig {
    return {
        baseUrl: parseBlockExplorerBaseUrl(
            env[BLOCK_EXPLORER_BASE_URL_ENV_KEY],
        ),
        transactionPathTemplate: parseBlockExplorerTransactionPathTemplate(
            env[BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY],
        ),
        addressPathTemplate: parseBlockExplorerAddressPathTemplate(
            env[BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE_ENV_KEY],
        ),
        blockPathTemplate: parseBlockExplorerBlockPathTemplate(
            env[BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE_ENV_KEY],
        ),
    };
}

// Checks whether an env key belongs to the block explorer config contract.
export function isBlockExplorerConfigEnvKey(
    key: string,
): key is BlockExplorerConfigEnvKey {
    return BLOCK_EXPLORER_CONFIG_ENV_KEYS.some(
        (configKey) => configKey === key,
    );
}

// Parses one block explorer setting value by its owning env key.
export function parseBlockExplorerConfigValue(
    key: BlockExplorerConfigEnvKey,
    value: string | undefined,
): string {
    switch (key) {
        case BLOCK_EXPLORER_BASE_URL_ENV_KEY:
            return parseBlockExplorerBaseUrl(value, key);
        case BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY:
            return parseBlockExplorerTransactionPathTemplate(value, key);
        case BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE_ENV_KEY:
            return parseBlockExplorerAddressPathTemplate(value, key);
        case BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE_ENV_KEY:
            return parseBlockExplorerBlockPathTemplate(value, key);
    }
}

// Validates and normalizes the base block explorer URL.
export function parseBlockExplorerBaseUrl(
    value: string | undefined,
    key = BLOCK_EXPLORER_BASE_URL_ENV_KEY,
): string {
    const normalized =
        value === undefined ? getDefaultBlockExplorerBaseUrl() : value.trim();
    try {
        const url = new URL(normalized);
        const isHttpUrl = url.protocol === "http:" || url.protocol === "https:";
        const isOriginOnly =
            url.pathname === "/" && url.search === "" && url.hash === "";
        if (!isHttpUrl || url.hostname.trim().length === 0 || !isOriginOnly) {
            throw new Error("invalid block explorer origin");
        }
        return url.origin;
    } catch {
        throw new Error(`${key} must be an HTTP(S) origin URL.`);
    }
}

// Validates and normalizes the transaction lookup path/query template.
export function parseBlockExplorerTransactionPathTemplate(
    value: string | undefined,
    key = BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY,
): string {
    return parseBlockExplorerLookupPathTemplate(
        value,
        key,
        BLOCK_EXPLORER_TX_HASH_PLACEHOLDER,
        getDefaultBlockExplorerTransactionPathTemplate,
    );
}

// Validates and normalizes the address lookup path/query template.
export function parseBlockExplorerAddressPathTemplate(
    value: string | undefined,
    key = BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE_ENV_KEY,
): string {
    return parseBlockExplorerLookupPathTemplate(
        value,
        key,
        BLOCK_EXPLORER_ADDRESS_PLACEHOLDER,
        getDefaultBlockExplorerAddressPathTemplate,
    );
}

// Validates and normalizes the block lookup path/query template.
export function parseBlockExplorerBlockPathTemplate(
    value: string | undefined,
    key = BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE_ENV_KEY,
): string {
    return parseBlockExplorerLookupPathTemplate(
        value,
        key,
        BLOCK_EXPLORER_BLOCK_NUMBER_PLACEHOLDER,
        getDefaultBlockExplorerBlockPathTemplate,
    );
}

// Builds a concrete transaction explorer URL from a parsed config.
export function buildBlockExplorerTransactionUrl(input: {
    config: BlockExplorerConfig;
    txHash: string | null;
}): string | null {
    return buildBlockExplorerLookupUrl({
        baseUrl: input.config.baseUrl,
        pathTemplate: input.config.transactionPathTemplate,
        placeholder: BLOCK_EXPLORER_TX_HASH_PLACEHOLDER,
        value: input.txHash,
        key: BLOCK_EXPLORER_TX_PATH_TEMPLATE_ENV_KEY,
    });
}

// Builds a concrete address explorer URL from a parsed config.
export function buildBlockExplorerAddressUrl(input: {
    config: BlockExplorerConfig;
    address: string | null;
}): string | null {
    return buildBlockExplorerLookupUrl({
        baseUrl: input.config.baseUrl,
        pathTemplate: input.config.addressPathTemplate,
        placeholder: BLOCK_EXPLORER_ADDRESS_PLACEHOLDER,
        value: input.address,
        key: BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE_ENV_KEY,
    });
}

// Builds a concrete block explorer URL from a parsed config.
export function buildBlockExplorerBlockUrl(input: {
    config: BlockExplorerConfig;
    blockNumber: number | string | null;
}): string | null {
    return buildBlockExplorerLookupUrl({
        baseUrl: input.config.baseUrl,
        pathTemplate: input.config.blockPathTemplate,
        placeholder: BLOCK_EXPLORER_BLOCK_NUMBER_PLACEHOLDER,
        value:
            input.blockNumber === null || input.blockNumber === undefined
                ? null
                : String(input.blockNumber),
        key: BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE_ENV_KEY,
    });
}

function parseBlockExplorerLookupPathTemplate(
    value: string | undefined,
    key: string,
    placeholder: string,
    defaultValue: () => string,
): string {
    const normalized = value === undefined ? defaultValue() : value.trim();
    if (normalized.length === 0 || !normalized.includes(placeholder)) {
        throw new Error(`${key} must include ${placeholder}.`);
    }
    assertBlockExplorerLookupPathTemplate(normalized, key);
    return normalized;
}

function assertBlockExplorerLookupPathTemplate(
    value: string,
    key: string,
): void {
    if (!value.startsWith("/") && !value.startsWith("?")) {
        throw new Error(`${key} must start with / or ?.`);
    }
    if (value.startsWith("//")) {
        throw new Error(
            `${key} must be a path/query template, not a host URL.`,
        );
    }
    try {
        const validationBaseUrl = parseBlockExplorerBaseUrl(undefined);
        const url = new URL(
            value
                .split(BLOCK_EXPLORER_TX_HASH_PLACEHOLDER)
                .join(sampleTransactionHash())
                .split(BLOCK_EXPLORER_ADDRESS_PLACEHOLDER)
                .join(sampleAddress())
                .split(BLOCK_EXPLORER_BLOCK_NUMBER_PLACEHOLDER)
                .join(sampleBlockNumber()),
            validationBaseUrl,
        );
        if (url.origin !== validationBaseUrl) {
            throw new Error("path changed explorer origin");
        }
    } catch {
        throw new Error(`${key} must be a valid path/query template.`);
    }
}

function buildBlockExplorerLookupUrl(input: {
    baseUrl: string;
    pathTemplate: string;
    placeholder: string;
    value: string | null;
    key: string;
}): string | null {
    if (!input.value) {
        return null;
    }
    const baseUrl = parseBlockExplorerBaseUrl(input.baseUrl);
    const pathTemplate = parseBlockExplorerLookupPathTemplate(
        input.pathTemplate,
        input.key,
        input.placeholder,
        () => input.pathTemplate,
    );
    return new URL(
        pathTemplate
            .split(input.placeholder)
            .join(encodeURIComponent(input.value)),
        baseUrl,
    ).toString();
}

function sampleTransactionHash(): string {
    return `0x${"0".repeat(64)}`;
}

function sampleAddress(): string {
    return `0x${"0".repeat(40)}`;
}

function sampleBlockNumber(): string {
    return "22000000";
}
