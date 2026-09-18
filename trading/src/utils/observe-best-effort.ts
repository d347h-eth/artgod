// Runs optional observability without allowing diagnostics to change business behavior.
export function observeBestEffort<T>(observe: () => T): T | undefined {
    try {
        return observe();
    } catch {
        // Metrics are diagnostic; runtime behavior remains authoritative.
    }
}
