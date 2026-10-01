import { browser } from '$app/environment';
import { diagnosticError } from './diagnostics';
import type { LifecycleEventMeta } from './lifecycle/core/types';

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
	(import.meta.env.PUBLIC_BACKEND_ORIGIN as string | undefined)?.trim() || 'http://127.0.0.1:42710';

let cachedOrigin: string | null = null;
let inflightOrigin: Promise<string> | null = null;
let resolutionAttempts = 0;
const ORIGIN_RESOLUTION_STATES = {
	idle: 'idle',
	pending: 'pending',
	resolved: 'resolved',
	rejected: 'rejected',
	cached: 'cached'
} as const;
let resolutionState: string = ORIGIN_RESOLUTION_STATES.idle;
let resolutionStartedAtIso = '';
let resolutionError: LifecycleEventMeta = {};

/** Observes the existing cache, including a retained rejected promise, without retrying it. */
export function backendOriginDiagnostics(): LifecycleEventMeta {
	return {
		originResolutionState: cachedOrigin ? ORIGIN_RESOLUTION_STATES.cached : resolutionState,
		originResolutionAttempts: resolutionAttempts,
		originResolutionStartedAtIso: resolutionStartedAtIso,
		originResolutionError: resolutionError.errorMessage ?? '',
		originResolutionCause: resolutionError.causeMessage ?? '',
		originBridgeAvailable: getTauriInternals() !== null
	};
}

export async function resolveBackendOrigin(): Promise<string> {
	if (!browser) {
		return resolveServerBackendOrigin();
	}
	if (cachedOrigin) {
		return cachedOrigin;
	}
	if (!inflightOrigin) {
		resolutionAttempts += 1;
		resolutionState = ORIGIN_RESOLUTION_STATES.pending;
		resolutionStartedAtIso = new Date().toISOString();
		inflightOrigin = resolveDesktopOrDefault().then(
			(origin) => {
				resolutionState = ORIGIN_RESOLUTION_STATES.resolved;
				return origin;
			},
			(error: unknown) => {
				resolutionState = ORIGIN_RESOLUTION_STATES.rejected;
				resolutionError = diagnosticError(error);
				throw error;
			}
		);
	}
	cachedOrigin = await inflightOrigin;
	return cachedOrigin;
}

async function resolveDesktopOrDefault(): Promise<string> {
	const tauriInternals = getTauriInternals();
	if (!tauriInternals) {
		// Browser web deployments should use same-origin relative requests.
		return '';
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
			throw new Error(`Desktop runtime unavailable: ${runtimeError}`, { cause });
		}
		throw new Error(`Desktop runtime unavailable: ${toErrorMessage(cause)}`, { cause });
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
