import { browser } from '$app/environment';

type DesktopEndpoints = {
	backendHttpBaseUrl: string;
};

type RuntimeStatus = {
	state: string;
	lastError: string | null;
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
		return resolveServerBackendOrigin();
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
		throw new Error('runtime_get_endpoints returned empty backendHttpBaseUrl');
	} catch (cause) {
		const runtimeStatus = await tauriInternals
			.invoke<RuntimeStatus>('runtime_status')
			.catch(() => null);
		const runtimeError = runtimeStatus?.lastError?.trim();
		if (runtimeError) {
			throw new Error(`Desktop runtime unavailable: ${runtimeError}`);
		}
		throw new Error(`Desktop runtime unavailable: ${toErrorMessage(cause)}`);
	}
}

function resolveServerBackendOrigin(): string {
	if (!import.meta.env.SSR) {
		return DEFAULT_BACKEND_ORIGIN;
	}
	const internalOrigin = process.env.INTERNAL_BACKEND_ORIGIN?.trim();
	return internalOrigin || DEFAULT_BACKEND_ORIGIN;
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

function toErrorMessage(value: unknown): string {
	if (value instanceof Error && value.message.trim()) {
		return value.message;
	}
	if (typeof value === 'string' && value.trim()) {
		return value;
	}
	return 'unknown Tauri bridge error';
}
