const HTTP_RPC_PROTOCOLS = new Set(["http:", "https:"]);
const EXPLICIT_HTTP_RPC_SCHEME_PATTERN = /^https?:\/\//;

// Resolves a direct CLI override or the first endpoint from the structured env pool.
export function resolveRpcEndpointUrl({
    cliValue,
    envValue,
    envKey = "RPC_URL",
}) {
    const cliRpcUrl = normalizeNonEmpty(cliValue);
    if (cliRpcUrl) {
        return validateHttpRpcUrl(cliRpcUrl, "--rpc");
    }

    const envRpcPool = normalizeNonEmpty(envValue);
    if (!envRpcPool) {
        return null;
    }
    return parseRpcEndpointPool(envRpcPool, envKey)[0].url;
}

function parseRpcEndpointPool(raw, key) {
    if (!raw.startsWith("[")) {
        throw new Error(`Invalid ${key}: endpoint list must be a JSON array`);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `Invalid ${key}: ${error instanceof Error ? error.message : "invalid JSON"}`,
        );
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`Invalid ${key}: endpoint list must be a JSON array`);
    }
    if (parsed.length === 0) {
        throw new Error(`Invalid ${key}: endpoint list cannot be empty`);
    }

    return parsed.map((entry, index) => parseRpcEndpoint(entry, key, index));
}

function parseRpcEndpoint(entry, key, index) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
            `Invalid ${key}: endpoint ${index + 1} must be an object`,
        );
    }
    const url = validateHttpRpcUrl(
        String(entry.url ?? ""),
        `${key} endpoint ${index + 1}`,
    );
    const weight =
        entry.weight === undefined || entry.weight === ""
            ? 1
            : Number(entry.weight);
    if (!Number.isSafeInteger(weight) || weight <= 0) {
        throw new Error(
            `Invalid ${key}: endpoint ${index + 1} weight must be a positive integer`,
        );
    }
    return { url, weight };
}

function validateHttpRpcUrl(value, label) {
    const trimmed = value.trim();
    if (!EXPLICIT_HTTP_RPC_SCHEME_PATTERN.test(trimmed)) {
        throw new Error(`Invalid ${label}: URL is invalid`);
    }
    try {
        const url = new URL(trimmed);
        if (
            !HTTP_RPC_PROTOCOLS.has(url.protocol) ||
            url.hostname.trim().length === 0
        ) {
            throw new Error("invalid URL");
        }
    } catch {
        throw new Error(`Invalid ${label}: URL is invalid`);
    }
    return trimmed;
}

function normalizeNonEmpty(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
}
