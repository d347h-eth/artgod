import { randomUUID } from "node:crypto";

// Identity of disposable verification traffic, separate from real app activity.
export const LOCAL_DESKTOP_PROBE = Object.freeze({
    worker: "backend-api",
    chainId: 1,
    serviceNamespace: "artgod.local-build-test",
    spanName: "local.desktop.packaging.smoke",
    profileType: "wall:cpu:nanoseconds:wall:nanoseconds",
});

// Scope all existing worker/service labels to one disposable process launch.
// The parent passes the identity to the child and uses it in each store query.
export function createLocalDesktopProbe(runId = randomUUID()) {
    if (
        typeof runId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            runId,
        )
    )
        throw new Error("Local desktop probe requires a UUID identity.");
    const worker = `${LOCAL_DESKTOP_PROBE.worker}-${runId}`;
    return Object.freeze({
        ...LOCAL_DESKTOP_PROBE,
        runId,
        worker,
        serviceName: `${LOCAL_DESKTOP_PROBE.serviceNamespace}.${worker}`,
    });
}
