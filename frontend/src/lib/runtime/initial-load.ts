import { browser } from '$app/environment';

type QuickRuntimeStatus = {
	state: string;
};

const FRONTEND_BUILD_TARGET =
	(import.meta.env.VITE_FRONTEND_BUILD_TARGET as string | undefined)?.trim() || '';
const IS_DESKTOP_BUILD_TARGET = FRONTEND_BUILD_TARGET === 'desktop';
const RUNTIME_STATUS_TIMEOUT_MS = 250;

type TauriInternalsLike = {
	invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

export async function shouldDeferInitialBackendLoad(): Promise<boolean> {
	if (!browser || !isDesktopShellLikely()) {
		return false;
	}

	const status = await readRuntimeStatusQuick();
	if (!status) {
		return true;
	}

	return status.state !== 'running';
}

function isDesktopShellLikely(): boolean {
	if (IS_DESKTOP_BUILD_TARGET) {
		return true;
	}

	if (!browser) {
		return false;
	}

	const maybeWindow = window as Window & {
		__TAURI_INTERNALS__?: unknown;
	};

	if (maybeWindow.__TAURI_INTERNALS__) {
		return true;
	}

	const protocol = window.location.protocol.toLowerCase();
	if (protocol === 'tauri:' || protocol === 'asset:') {
		return true;
	}

	const host = window.location.hostname.toLowerCase();
	if (host === 'tauri.localhost' || host.endsWith('.tauri.localhost')) {
		return true;
	}

	return /\btauri\b/i.test(navigator.userAgent);
}

async function readRuntimeStatusQuick(): Promise<QuickRuntimeStatus | null> {
	const maybeWindow = window as Window & {
		__TAURI_INTERNALS__?: TauriInternalsLike;
	};

	const invoke = maybeWindow.__TAURI_INTERNALS__?.invoke;
	if (typeof invoke !== 'function') {
		return null;
	}

	try {
		const result = (await withTimeout(
			invoke('runtime_status'),
			RUNTIME_STATUS_TIMEOUT_MS
		)) as QuickRuntimeStatus | null;

		if (!result || typeof result !== 'object' || typeof result.state !== 'string') {
			return null;
		}
		return result;
	} catch {
		return null;
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race<T | null>([
			promise,
			new Promise<null>((resolve) => {
				timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
			})
		]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}
