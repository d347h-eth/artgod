// Runs optional observability without allowing diagnostics to change business behavior.
export function observeBestEffort(observe: () => void): void {
    try {
        observe();
    } catch {
        // Metrics are diagnostic; runtime behavior remains authoritative.
    }
}
