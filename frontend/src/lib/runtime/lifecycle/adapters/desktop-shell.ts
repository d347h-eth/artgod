import { browser } from '$app/environment';

const FRONTEND_BUILD_TARGET =
	(import.meta.env.VITE_FRONTEND_BUILD_TARGET as string | undefined)?.trim() || '';

export const IS_DESKTOP_BUILD_TARGET = FRONTEND_BUILD_TARGET === 'desktop';

export function detectDesktopShellLikely(): boolean {
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

export function isDesktopShellExpected(): boolean {
	return IS_DESKTOP_BUILD_TARGET || detectDesktopShellLikely();
}
