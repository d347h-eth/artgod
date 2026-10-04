import { browser } from '$app/environment';

export type QueryControlPreferenceDefinition<T extends string | null = string> = {
	param: string;
	values: readonly [T, ...T[]];
	defaultValue?: T;
};

export type QueryControlPreferenceDefinitions<TPreference extends object> = {
	[K in keyof TPreference]: QueryControlPreferenceDefinition<
		Extract<TPreference[K], string | null>
	>;
};

type StoredPreference = Record<string, string | null>;
type StoredPreferences = Record<string, StoredPreference>;
type QueryControlPreferenceReadStorage = Pick<Storage, 'getItem'>;
type QueryControlPreferenceWriteStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readQueryControlPreference<TPreference extends object>(params: {
	storageKey: string;
	definitions: QueryControlPreferenceDefinitions<TPreference>;
	storage?: QueryControlPreferenceReadStorage;
}): Partial<TPreference> | null {
	const storage = params.storage ?? browserLocalStorage();
	if (!storage) return null;
	try {
		return normalizeQueryControlPreference(
			readStoredPreference(storage, params.storageKey),
			params.definitions
		);
	} catch {
		return null;
	}
}

// Report persistence so a caller can retain its navigation choice in memory
// when browser storage is unavailable.
export function writeQueryControlPreference<TPreference extends object>(params: {
	storageKey: string;
	definitions: QueryControlPreferenceDefinitions<TPreference>;
	preference: TPreference;
	storage?: QueryControlPreferenceWriteStorage;
}): boolean {
	const storage = params.storage ?? browserLocalStorage();
	if (!storage) return false;
	const normalizedPreference = normalizeQueryControlPreference(
		params.preference as StoredPreference,
		params.definitions
	);
	if (!normalizedPreference) return false;
	try {
		storage.setItem(params.storageKey, JSON.stringify(normalizedPreference));
		return true;
	} catch {
		// Ignore storage failures and keep navigation state URL-driven.
		return false;
	}
}

export function readScopedQueryControlPreference<TPreference extends object>(params: {
	storageKey: string;
	scopePath: string;
	definitions: QueryControlPreferenceDefinitions<TPreference>;
	storage?: QueryControlPreferenceReadStorage;
}): Partial<TPreference> | null {
	const storage = params.storage ?? browserLocalStorage();
	if (!storage) return null;
	const normalizedScope = normalizeQueryControlScopePath(params.scopePath);
	if (!normalizedScope) return null;
	try {
		return normalizeQueryControlPreference(
			readStoredPreferences(storage, params.storageKey)[normalizedScope] ?? null,
			params.definitions
		);
	} catch {
		return null;
	}
}

export function writeScopedQueryControlPreference<TPreference extends object>(params: {
	storageKey: string;
	scopePath: string;
	definitions: QueryControlPreferenceDefinitions<TPreference>;
	preference: TPreference;
	storage?: QueryControlPreferenceWriteStorage;
}): void {
	const storage = params.storage ?? browserLocalStorage();
	if (!storage) return;
	const normalizedScope = normalizeQueryControlScopePath(params.scopePath);
	if (!normalizedScope) return;
	const normalizedPreference = normalizeQueryControlPreference(
		params.preference as StoredPreference,
		params.definitions
	);
	if (!normalizedPreference) return;
	try {
		const stored = readStoredPreferences(storage, params.storageKey);
		stored[normalizedScope] = normalizedPreference as StoredPreference;
		storage.setItem(params.storageKey, JSON.stringify(stored));
	} catch {
		// Ignore storage failures and keep navigation state URL-driven.
	}
}

export function applyQueryControlPreferenceToQuery<TPreference extends object>(params: {
	query: URLSearchParams;
	definitions: QueryControlPreferenceDefinitions<TPreference>;
	preference: Partial<TPreference> | null;
}): URLSearchParams {
	const query = new URLSearchParams(params.query);
	const normalizedPreference = normalizeQueryControlPreference(
		params.preference as StoredPreference | null,
		params.definitions
	);
	if (!normalizedPreference) return query;

	const definitions = params.definitions as Record<
		string,
		QueryControlPreferenceDefinition<string | null>
	>;
	const normalizedValues = normalizedPreference as StoredPreference;
	for (const [key, definition] of Object.entries(definitions)) {
		if (query.has(definition.param)) continue;
		const value = normalizedValues[key];
		if (value === undefined) continue;
		setDefaultOmittingParam(
			query,
			definition.param,
			value,
			definition.defaultValue === undefined ? definition.values[0] : definition.defaultValue
		);
	}

	return query;
}

function setDefaultOmittingParam(
	params: URLSearchParams,
	key: string,
	value: string | null,
	defaultValue: string | null
): void {
	if (value === null || value === defaultValue) {
		params.delete(key);
		return;
	}
	params.set(key, value);
}

function readStoredPreference(
	storage: QueryControlPreferenceReadStorage,
	storageKey: string
): unknown {
	const raw = storage.getItem(storageKey);
	if (!raw) return null;
	return JSON.parse(raw) as unknown;
}

function readStoredPreferences(
	storage: QueryControlPreferenceReadStorage,
	storageKey: string
): StoredPreferences {
	const raw = storage.getItem(storageKey);
	if (!raw) return {};
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
	return parsed as StoredPreferences;
}

function normalizeQueryControlPreference<TPreference extends object>(
	preference: unknown,
	definitions: QueryControlPreferenceDefinitions<TPreference>
): Partial<TPreference> | null {
	if (!preference || typeof preference !== 'object') return null;
	const typedDefinitions = definitions as Record<
		string,
		QueryControlPreferenceDefinition<string | null>
	>;
	const normalized: StoredPreference = {};
	for (const [key, definition] of Object.entries(typedDefinitions)) {
		const value = (preference as Record<string, unknown>)[key];
		// A declared null value remembers an intentionally cleared filter rather
		// than treating it as a missing preference that should receive a default.
		if ((typeof value === 'string' || value === null) && definition.values.includes(value)) {
			normalized[key] = value;
		}
	}
	return Object.keys(normalized).length > 0 ? (normalized as Partial<TPreference>) : null;
}

function browserLocalStorage(): Storage | null {
	if (!browser) return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function normalizeQueryControlScopePath(scopePath: string): string | null {
	const trimmed = scopePath.trim().replace(/\/+$/, '');
	if (!trimmed || trimmed === '/') return null;
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
