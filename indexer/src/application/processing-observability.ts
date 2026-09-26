import { NOOP_APM, type ApmPort } from "@artgod/shared/observability/apm";

/** Operation names belong to the calling workflow, never to individual jobs. */
export interface ProcessingObserver {
    started(operation: string): (succeeded: boolean) => void;
}

export type ProcessingObservability = {
    apm?: ApmPort;
    observer?: ProcessingObserver;
};

/** Diagnostics must not turn a committed effect into a processing retry. */
export function observeBestEffort<T>(observe: () => T): T | undefined {
    try {
        return observe();
    } catch {
        // The business operation, not its metrics, determines the outcome.
    }
}

/** Place this inside retry/handoff catches so APM sees the original failure. */
export async function observeProcessing<T>(
    hooks: ProcessingObservability | undefined,
    operation: string,
    attributes: Parameters<ApmPort["withSpan"]>[1],
    work: () => Promise<T>,
): Promise<T> {
    const finish = observeBestEffort(() => hooks?.observer?.started(operation));
    try {
        const result = await (hooks?.apm ?? NOOP_APM).withSpan(
            operation,
            attributes,
            work,
        );
        observeBestEffort(() => finish?.(true));
        return result;
    } catch (error) {
        observeBestEffort(() => finish?.(false));
        throw error;
    }
}

/** Synchronous persistence spans retain the transaction boundary and return type. */
export function observeSyncProcessing<T>(
    hooks: ProcessingObservability | undefined,
    operation: string,
    attributes: Parameters<ApmPort["withSyncSpan"]>[1],
    work: () => T,
): T {
    const finish = observeBestEffort(() => hooks?.observer?.started(operation));
    try {
        const result = (hooks?.apm ?? NOOP_APM).withSyncSpan(
            operation,
            attributes,
            work,
        );
        observeBestEffort(() => finish?.(true));
        return result;
    } catch (error) {
        observeBestEffort(() => finish?.(false));
        throw error;
    }
}
