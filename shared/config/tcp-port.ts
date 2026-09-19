// TCP port bounds are shared by runtime parsing and user-facing configuration validation.
export const TCP_PORT_RANGE = {
    Minimum: 1,
    Maximum: 65_535,
} as const;

// Returns whether a value is a whole TCP port within the operating-system range.
export function isTcpPort(value: string | number): boolean {
    const parsed = typeof value === "number" ? value : Number(value.trim());
    return (
        Number.isInteger(parsed) &&
        parsed >= TCP_PORT_RANGE.Minimum &&
        parsed <= TCP_PORT_RANGE.Maximum
    );
}

// Parses an optional env value while rejecting ports the runtime cannot bind.
export function parseTcpPort(
    value: string | undefined,
    name: string,
    defaultValue?: number,
): number {
    const normalized = value?.trim();
    const candidate = normalized ? Number(normalized) : defaultValue;
    if (candidate === undefined) {
        throw new Error(`Missing ${name}`);
    }
    if (!isTcpPort(candidate)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return candidate;
}
