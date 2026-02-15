export function parseNumber(
    value: string | undefined,
    name: string,
    defaultValue?: number,
): number {
    const normalized = value?.trim();
    if (normalized === undefined || normalized === "") {
        if (defaultValue !== undefined) return defaultValue;
        throw new Error(`Missing ${name}`);
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return parsed;
}

export function parseRequiredString(
    value: string | undefined,
    name: string,
): string {
    const normalized = value?.trim();
    if (!normalized) {
        throw new Error(`Missing ${name}`);
    }
    return normalized;
}

export function parseBoolean(
    value: string | undefined,
    name: string,
    defaultValue: boolean,
): boolean {
    if (value === undefined) {
        return defaultValue;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "") {
        return defaultValue;
    }
    if (
        normalized === "1" ||
        normalized === "true" ||
        normalized === "yes" ||
        normalized === "on"
    ) {
        return true;
    }
    if (
        normalized === "0" ||
        normalized === "false" ||
        normalized === "no" ||
        normalized === "off"
    ) {
        return false;
    }
    throw new Error(`Invalid ${name}: ${value}`);
}

export function parsePositiveInteger(
    value: string | undefined,
    name: string,
    defaultValue?: number,
): number {
    const parsed = parseNumber(value, name, defaultValue);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return parsed;
}
