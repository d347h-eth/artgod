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

/** Parse an explicit policy choice; absent input uses the owner's validated default. */
export function parseEnum<T extends string>(
    value: string | undefined,
    name: string,
    choices: readonly T[],
    defaultValue: string,
): T {
    const candidate = value?.trim() || defaultValue;
    const choice = choices.find((allowed) => allowed === candidate);
    if (choice === undefined)
        throw new Error(`Invalid ${name}: expected ${choices.join(" or ")}`);
    return choice;
}

/** Positive finite decimal values shared by numeric config and Admin validation. */
export function isPositiveNumber(value: string | number): boolean {
    if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim()))
        return false;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
}

export function parsePositiveNumber(
    value: string | undefined,
    name: string,
    defaultValue?: number,
): number {
    const candidate = value?.trim() || defaultValue;
    if (candidate === undefined) throw new Error(`Missing ${name}`);
    if (!isPositiveNumber(candidate))
        throw new Error(`Invalid ${name}: ${candidate}`);
    return Number(candidate);
}

export function parseAddress(value: string | undefined, name: string): string {
    if (!value) {
        throw new Error(`Missing ${name}`);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return value.toLowerCase();
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

// Shares the Admin decimal safe-integer contract with runtime configuration.
export function isPositiveInteger(value: string | number): boolean {
    if (typeof value === "string" && !/^[1-9]\d*$/.test(value.trim())) {
        return false;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0;
}

export function parsePositiveInteger(
    value: string | undefined,
    name: string,
    defaultValue?: number,
): number {
    const normalized = value?.trim();
    const candidate = normalized || defaultValue;
    if (candidate === undefined) {
        throw new Error(`Missing ${name}`);
    }
    if (!isPositiveInteger(candidate)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return Number(candidate);
}
