export type ApiOriginPolicy = {
    allowedHosts: Set<string>;
    allowedOrigins: Set<string>;
};

export function createApiOriginPolicy(config: {
    allowedHosts: string[];
    allowedOrigins: string[];
}): ApiOriginPolicy {
    return {
        allowedHosts: new Set(
            config.allowedHosts.map((host) => host.trim().toLowerCase()),
        ),
        allowedOrigins: new Set(
            config.allowedOrigins.map((origin) =>
                normalizeOrigin(origin) ?? origin.trim().toLowerCase(),
            ),
        ),
    };
}

export function isAllowedRequestHost(
    hostHeader: string | undefined,
    policy: ApiOriginPolicy,
): boolean {
    const normalized = normalizeHostHeader(hostHeader);
    return normalized !== null && policy.allowedHosts.has(normalized);
}

export function isAllowedRequestOrigin(
    originHeader: string | undefined,
    policy: ApiOriginPolicy,
): boolean {
    const normalized = normalizeOrigin(originHeader);
    return normalized !== null && policy.allowedOrigins.has(normalized);
}

export function normalizeHostHeader(hostHeader: string | undefined): string | null {
    if (!hostHeader) {
        return null;
    }

    const value = hostHeader.trim().toLowerCase();
    if (!value) {
        return null;
    }

    if (value.startsWith("[")) {
        const end = value.indexOf("]");
        if (end > 0) {
            return value.slice(1, end);
        }
    }

    if (value.indexOf(":") !== value.lastIndexOf(":")) {
        return value;
    }

    const colonIndex = value.indexOf(":");
    if (colonIndex >= 0) {
        return value.slice(0, colonIndex);
    }

    return value;
}

export function normalizeOrigin(originHeader: string | undefined): string | null {
    if (!originHeader) {
        return null;
    }

    let parsed: URL;
    try {
        parsed = new URL(originHeader.trim());
    } catch {
        return null;
    }

    if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
        return null;
    }

    return parsed.origin.toLowerCase();
}
