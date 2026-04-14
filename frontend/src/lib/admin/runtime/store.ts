// Admin runtime surfaces reuse the existing desktop runtime store through an admin-scoped import.
export { desktopRuntimeStore as adminRuntimeStore } from '$lib/runtime/desktop-runtime-store';
export type { LifecycleEventLevel } from '$lib/runtime/desktop-runtime-store';
