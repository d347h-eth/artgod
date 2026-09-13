// Admin runtime surfaces reuse the existing desktop runtime store through an admin-scoped import.
export {
	desktopRuntimeStore as adminRuntimeStore,
	RUNTIME_BUSY_ACTIONS
} from '$lib/runtime/desktop-runtime-store';
export type { LifecycleEventLevel } from '$lib/runtime/desktop-runtime-store';

import { getContext, setContext } from 'svelte';
import { desktopRuntimeStore, type DesktopRuntimeStore } from '$lib/runtime/desktop-runtime-store';
const RUNTIME_STORE_CONTEXT = Symbol('admin-runtime-store');

/** A scoped store lets the maintained harness use the complete production shell. */
export function provideAdminRuntimeStore(store: DesktopRuntimeStore): DesktopRuntimeStore {
	return setContext(RUNTIME_STORE_CONTEXT, store);
}
export function getAdminRuntimeStore(): DesktopRuntimeStore {
	return getContext<DesktopRuntimeStore | undefined>(RUNTIME_STORE_CONTEXT) ?? desktopRuntimeStore;
}
