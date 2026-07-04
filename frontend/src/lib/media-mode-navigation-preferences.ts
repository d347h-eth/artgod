import { browser } from '$app/environment';
import type { ApiCollectionMediaMode } from '$lib/api-types';
import { LOCAL_STORAGE_KEYS } from '$lib/local-storage-keys';
import { appendMediaModeParam, MEDIA_MODE_QUERY_PARAM, normalizeMediaMode } from '$lib/media-mode';
import { normalizeBasePath } from '$lib/route-paths';

type StoredMediaModePreferences = Record<string, string>;
type MediaModePreferenceReadStorage = Pick<Storage, 'getItem'>;
type MediaModePreferenceWriteStorage = Pick<Storage, 'getItem' | 'setItem'>;

// Builds the collection scope used for sticky media-mode preferences.
export function collectionMediaModePreferenceScope(params: {
	chainRef: string;
	collectionRef: string;
}): string {
	return normalizeBasePath(`/${params.chainRef}/${params.collectionRef}`);
}

export function readCollectionMediaModeNavigationPreference(params: {
	scopePath: string;
	availableModes?: ApiCollectionMediaMode[];
	storage?: MediaModePreferenceReadStorage;
}): string | null {
	const storage = params.storage ?? browserLocalStorage();
	if (!storage) return null;
	try {
		const mode = normalizeMediaMode(
			readStoredPreferences(storage)[normalizeScopePath(params.scopePath)] ?? null
		);
		if (!mode) return null;
		return params.availableModes && !modeIsAvailable(mode, params.availableModes) ? null : mode;
	} catch {
		return null;
	}
}

export function writeCollectionMediaModeNavigationPreference(params: {
	scopePath: string;
	mediaMode: string;
	availableModes: ApiCollectionMediaMode[];
	storage?: MediaModePreferenceWriteStorage;
}): void {
	const storage = params.storage ?? browserLocalStorage();
	const mode = normalizeMediaMode(params.mediaMode);
	if (!storage || !mode || !modeIsAvailable(mode, params.availableModes)) return;
	try {
		const stored = readStoredPreferences(storage);
		stored[normalizeScopePath(params.scopePath)] = mode;
		storage.setItem(LOCAL_STORAGE_KEYS.collectionMediaModeNavigationPreferences, JSON.stringify(stored));
	} catch {
		// Ignore storage failures and keep navigation state URL-driven.
	}
}

export function clearCollectionMediaModeNavigationPreference(params: {
	scopePath: string;
	storage?: MediaModePreferenceWriteStorage;
}): void {
	const storage = params.storage ?? browserLocalStorage();
	if (!storage) return;
	try {
		const stored = readStoredPreferences(storage);
		delete stored[normalizeScopePath(params.scopePath)];
		storage.setItem(LOCAL_STORAGE_KEYS.collectionMediaModeNavigationPreferences, JSON.stringify(stored));
	} catch {
		// Ignore storage failures and keep navigation state URL-driven.
	}
}

export function resolvePreferredCollectionMediaModeHref(params: {
	url: URL;
	scopePath: string;
	storage?: MediaModePreferenceReadStorage;
}): string | null {
	if (!browser && !params.storage) return null;
	if (params.url.searchParams.has(MEDIA_MODE_QUERY_PARAM)) return null;
	const mediaMode = readCollectionMediaModeNavigationPreference({
		scopePath: params.scopePath,
		storage: params.storage
	});
	if (!mediaMode) return null;

	const query = new URLSearchParams(params.url.searchParams);
	appendMediaModeParam(query, mediaMode);
	const nextQuery = query.toString();
	return `${params.url.pathname}${nextQuery ? `?${nextQuery}` : ''}`;
}

function readStoredPreferences(storage: MediaModePreferenceReadStorage): StoredMediaModePreferences {
	const raw = storage.getItem(LOCAL_STORAGE_KEYS.collectionMediaModeNavigationPreferences);
	if (!raw) return {};
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
	return parsed as StoredMediaModePreferences;
}

function modeIsAvailable(mode: string, availableModes: ApiCollectionMediaMode[]): boolean {
	return availableModes.some((availableMode) => availableMode.key === mode);
}

function normalizeScopePath(scopePath: string): string {
	return normalizeBasePath(scopePath);
}

function browserLocalStorage(): Storage | null {
	if (!browser) return null;
	return window.localStorage;
}
