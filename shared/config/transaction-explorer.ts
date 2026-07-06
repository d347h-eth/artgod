import {
    getSettingDefault,
    type SettingsDefaultKey,
} from "./generated-settings-defaults.js";

// Env key for the transaction explorer URL template used by userland links.
export const TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY =
    "TRANSACTION_EXPLORER_URL_TEMPLATE" as const satisfies SettingsDefaultKey;

// Placeholder replaced with the encoded transaction hash when building explorer URLs.
export const TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER = "{tx_hash}";

export type TransactionExplorerConfig = {
    urlTemplate: string;
};

// Returns the manifest-backed default transaction explorer URL template.
export function getDefaultTransactionExplorerUrlTemplate(): string {
    return getSettingDefault(TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY);
}

// Parses the transaction explorer config from runtime env values.
export function parseTransactionExplorerConfig(
    env: Record<string, string | undefined>,
): TransactionExplorerConfig {
    return {
        urlTemplate: parseTransactionExplorerUrlTemplate(
            env[TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY],
        ),
    };
}

// Validates and normalizes a transaction explorer URL template.
export function parseTransactionExplorerUrlTemplate(
    value: string | undefined,
    key = TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY,
): string {
    const normalized =
        value === undefined
            ? getDefaultTransactionExplorerUrlTemplate()
            : value.trim();
    if (normalized.length === 0) {
        throw new Error(
            `${key} must include ${TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER}.`,
        );
    }
    if (!normalized.includes(TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER)) {
        throw new Error(
            `${key} must include ${TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER}.`,
        );
    }
    assertTransactionExplorerUrlTemplate(normalized, key);
    return normalized;
}

// Builds a concrete transaction explorer URL from a validated template.
export function buildTransactionExplorerUrl(input: {
    urlTemplate: string;
    txHash: string | null;
}): string | null {
    if (!input.txHash) {
        return null;
    }
    const urlTemplate = parseTransactionExplorerUrlTemplate(input.urlTemplate);
    return urlTemplate
        .split(TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER)
        .join(encodeURIComponent(input.txHash));
}

function assertTransactionExplorerUrlTemplate(
    value: string,
    key: string,
): void {
    const sampleUrl = value
        .split(TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER)
        .join(sampleTransactionHash());
    try {
        const url = new URL(sampleUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("unsupported protocol");
        }
        if (url.hostname.trim().length === 0) {
            throw new Error("missing hostname");
        }
    } catch {
        throw new Error(`${key} must be a valid HTTP(S) URL.`);
    }
}

function sampleTransactionHash(): string {
    return `0x${"0".repeat(64)}`;
}
