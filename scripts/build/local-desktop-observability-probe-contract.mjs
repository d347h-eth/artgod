// Identity of disposable verification traffic, separate from real app activity.
export const LOCAL_DESKTOP_PROBE = Object.freeze({
    worker: "backend-api",
    chainId: 1,
    serviceNamespace: "artgod.local-build-test",
    spanName: "local.desktop.packaging.smoke",
    profileType: "wall:cpu:nanoseconds:wall:nanoseconds",
});
