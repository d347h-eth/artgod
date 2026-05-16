export const OPENSEA_INTEGRATION_MODE_ENV = "OPENSEA_INTEGRATION_MODE";
export const OPENSEA_API_KEY_ENV = "OPENSEA_API_KEY";

export const OPENSEA_INTEGRATION_MODE = {
    Auto: "auto",
    Enabled: "enabled",
    Disabled: "disabled",
} as const;

export type OpenSeaIntegrationMode =
    (typeof OPENSEA_INTEGRATION_MODE)[keyof typeof OPENSEA_INTEGRATION_MODE];

export type OpenSeaIntegrationStatus = {
    enabled: boolean;
    mode: OpenSeaIntegrationMode;
    reason: string | null;
    missingKeys: string[];
    requiredKeys: string[];
};

export function resolveOpenSeaIntegrationStatus(
    env: Record<string, string | undefined>,
): OpenSeaIntegrationStatus {
    const mode = parseOpenSeaIntegrationMode(env[OPENSEA_INTEGRATION_MODE_ENV]);
    const apiKey = env[OPENSEA_API_KEY_ENV]?.trim() ?? "";
    const requiredKeys = [OPENSEA_API_KEY_ENV];

    if (mode === OPENSEA_INTEGRATION_MODE.Disabled) {
        return {
            enabled: false,
            mode,
            reason: `${OPENSEA_INTEGRATION_MODE_ENV}=disabled`,
            missingKeys: [],
            requiredKeys,
        };
    }

    if (apiKey.length > 0) {
        return {
            enabled: true,
            mode,
            reason: null,
            missingKeys: [],
            requiredKeys,
        };
    }

    return {
        enabled: false,
        mode,
        reason:
            mode === OPENSEA_INTEGRATION_MODE.Enabled
                ? `OpenSea integration is enabled but ${OPENSEA_API_KEY_ENV} is not configured`
                : `OpenSea integration disabled because ${OPENSEA_API_KEY_ENV} is not configured`,
        missingKeys: [OPENSEA_API_KEY_ENV],
        requiredKeys,
    };
}

export function requireOpenSeaIntegrationEnabled(
    env: Record<string, string | undefined>,
): OpenSeaIntegrationStatus {
    const status = resolveOpenSeaIntegrationStatus(env);
    assertOpenSeaIntegrationModeSatisfied(status);
    if (!status.enabled) {
        throw new Error(status.reason ?? "OpenSea integration is disabled");
    }
    return status;
}

export function assertOpenSeaIntegrationModeSatisfied(
    status: OpenSeaIntegrationStatus,
): void {
    if (status.mode === OPENSEA_INTEGRATION_MODE.Enabled && !status.enabled) {
        throw new Error(
            status.reason ?? "OpenSea integration is not configured",
        );
    }
}

function parseOpenSeaIntegrationMode(
    value: string | undefined,
): OpenSeaIntegrationMode {
    const normalized =
        value?.trim().toLowerCase() ?? OPENSEA_INTEGRATION_MODE.Auto;
    if (normalized.length === 0) {
        return OPENSEA_INTEGRATION_MODE.Auto;
    }
    if (
        normalized === OPENSEA_INTEGRATION_MODE.Auto ||
        normalized === OPENSEA_INTEGRATION_MODE.Enabled ||
        normalized === OPENSEA_INTEGRATION_MODE.Disabled
    ) {
        return normalized;
    }
    throw new Error(
        `Invalid ${OPENSEA_INTEGRATION_MODE_ENV}: ${value}. Use auto, enabled, or disabled.`,
    );
}
