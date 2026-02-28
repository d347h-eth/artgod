import { browser } from '$app/environment';

type DesktopEndpoints = {
	backendHttpBaseUrl: string;
};

type TauriInternals = {
	invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
};

type TauriWindow = Window & {
	__TAURI_INTERNALS__?: TauriInternals;
};

const DEFAULT_BACKEND_ORIGIN =
	(import.meta.env.PUBLIC_BACKEND_ORIGIN as string | undefined)?.trim() || 'http://127.0.0.1:3000';

let cachedOrigin: string | null = null;
let inflightOrigin: Promise<string> | null = null;

export async function resolveBackendOrigin(): Promise<string> {
	if (!browser) {
		return DEFAULT_BACKEND_ORIGIN;
	}
	if (cachedOrigin) {
		return cachedOrigin;
	}
	if (!inflightOrigin) {
		inflightOrigin = resolveDesktopOrDefault();
	}
	cachedOrigin = await inflightOrigin;
	return cachedOrigin;
}

async function resolveDesktopOrDefault(): Promise<string> {
	const tauriInternals = getTauriInternals();
	if (!tauriInternals) {
		return DEFAULT_BACKEND_ORIGIN;
	}
	try {
		const endpoints = await tauriInternals.invoke<DesktopEndpoints>('runtime_get_endpoints');
		const normalized = endpoints.backendHttpBaseUrl?.trim();
		if (normalized) {
			return normalized;
		}
	} catch {
		// Ignore Tauri bridge failures and keep frontend usable in browser mode.
	}
	return DEFAULT_BACKEND_ORIGIN;
}

function getTauriInternals(): TauriInternals | null {
	if (!browser) {
		return null;
	}
	const maybeTauriWindow = window as TauriWindow;
	const invokeFn = maybeTauriWindow.__TAURI_INTERNALS__?.invoke;
	if (typeof invokeFn !== 'function') {
		return null;
	}
	return {
		invoke: invokeFn.bind(maybeTauriWindow.__TAURI_INTERNALS__)
	};
}
