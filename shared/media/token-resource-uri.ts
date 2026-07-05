export const DEFAULT_IPFS_GATEWAY_ORIGIN = "https://ipfs.io";

export type TokenResourceUriOptions = {
    ipfsGatewayOrigin?: string;
};

// Resolves token metadata/media refs into fetchable URLs without changing stored raw values.
export function resolveTokenResourceUri(
    value: string | null | undefined,
    options: TokenResourceUriOptions = {},
): string | null {
    const normalized = value?.trim();
    if (!normalized) {
        return null;
    }

    if (normalized.startsWith("ipfs://")) {
        const gateway = normalizeIpfsGatewayOrigin(
            options.ipfsGatewayOrigin ?? DEFAULT_IPFS_GATEWAY_ORIGIN,
        );
        return `${gateway}/ipfs/${normalizeIpfsPath(normalized)}`;
    }

    if (
        /^https?:\/\//i.test(normalized) ||
        normalized.toLowerCase().startsWith("data:")
    ) {
        return normalized;
    }

    return null;
}

// Normalizes the configured gateway as a host/origin, even if the user includes /ipfs.
export function normalizeIpfsGatewayOrigin(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return DEFAULT_IPFS_GATEWAY_ORIGIN;
    }

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error(`Invalid IPFS gateway origin: ${value}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Invalid IPFS gateway origin: ${value}`);
    }
    return parsed.origin;
}

// Reads JSON data-tokenURIs with optional media-type parameters.
export function parseJsonDataUriText(uri: string): string {
    const match = uri.match(/^data:([^,]*),(.*)$/is);
    if (!match) {
        throw new Error("Unsupported data URI");
    }
    const metadata = match[1] ?? "";
    const payload = match[2] ?? "";
    const parts = metadata
        .split(";")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
    const mediaType = parts[0] ?? "text/plain";
    if (mediaType !== "application/json") {
        throw new Error("Unsupported data tokenURI media type");
    }
    const isBase64 = parts.includes("base64");
    return isBase64
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
}

// Decodes data:image refs for local cache writes and size probing.
export function parseImageDataUriBuffer(uri: string): {
    contentType: string;
    buffer: Buffer;
} {
    const match = uri.match(/^data:([^,]*),(.*)$/is);
    if (!match) {
        throw new Error("Unsupported data URI");
    }
    const metadata = match[1] ?? "";
    const payload = match[2] ?? "";
    const parts = metadata
        .split(";")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
    const contentType = parts[0] ?? "text/plain";
    if (!contentType.startsWith("image/")) {
        throw new Error("Unsupported data image media type");
    }
    const isBase64 = parts.includes("base64");
    return {
        contentType,
        buffer: isBase64
            ? Buffer.from(payload, "base64")
            : Buffer.from(decodeURIComponent(payload), "utf8"),
    };
}

// Encodes image bytes for one-off preview payloads that should not touch storage.
export function buildImageDataUri(input: {
    contentType: string;
    buffer: Buffer;
}): string {
    const contentType = input.contentType.trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
        throw new Error("Unsupported data image media type");
    }
    return `data:${contentType};base64,${input.buffer.toString("base64")}`;
}

function normalizeIpfsPath(uri: string): string {
    let path = uri.slice("ipfs://".length).trim();
    while (path.startsWith("/")) {
        path = path.slice(1);
    }
    if (path.toLowerCase().startsWith("ipfs/")) {
        path = path.slice("ipfs/".length);
    }
    if (!path) {
        throw new Error("Invalid IPFS URI");
    }
    return path
        .split("/")
        .map((segment) => encodeURIComponent(decodeSegment(segment)))
        .join("/");
}

function decodeSegment(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
