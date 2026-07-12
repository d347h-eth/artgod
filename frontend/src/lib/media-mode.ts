import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_PREFERENCE_VALUES,
	COLLECTION_MEDIA_QUERY_PARAMS,
	type CollectionMediaPreferenceValue
} from '@artgod/shared/extensions';
import type {
	ApiCollectionMediaMode,
	ApiCollectionMediaPreference,
	ApiCollectionMediaState
} from '$lib/api-types';

// Collection media source query key shared by route loaders and navigation builders.
export const MEDIA_MODE_QUERY_PARAM = COLLECTION_MEDIA_QUERY_PARAMS.MediaMode;
// Collection media preference query key shared by route loaders and navigation builders.
export const MEDIA_PREFERENCE_QUERY_PARAM = COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference;
// Token-local media version query key shared by detail and preview requests.
export const MEDIA_VARIANT_QUERY_PARAM = COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant;

// Media preference input accepts settled API state or normalized raw route state.
export type CollectionMediaPreferenceInput =
	| ApiCollectionMediaPreference
	| CollectionMediaPreferenceValue
	| null;

// Collection navigation media state excludes token-local version selection.
export type CollectionMediaQueryState = {
	mediaMode: string | null;
	mediaPreference: CollectionMediaPreferenceInput;
};

// Token media requests add one exact version to the collection navigation state.
export type TokenMediaQueryState = CollectionMediaQueryState & {
	mediaVariant: string | null;
};

export function normalizeMediaMode(raw: string | null): string | null {
	if (!raw) return null;
	const normalized = raw.trim().toLowerCase();
	if (!normalized || !/^[a-z0-9_-]+$/.test(normalized)) {
		return null;
	}
	return normalized;
}

export function appendMediaModeParam(params: URLSearchParams, mediaMode: string | null): void {
	const normalized = normalizeMediaMode(mediaMode);
	if (!normalized) {
		return;
	}
	params.set(MEDIA_MODE_QUERY_PARAM, normalized);
}

// Parses a route preference value into the boolean choice consumed by settled UI state.
export function normalizeMediaPreference(raw: string | null): boolean | null {
	const normalized = normalizeMediaPreferenceValue(raw);
	if (normalized === COLLECTION_MEDIA_PREFERENCE_VALUES.Enabled) return true;
	if (normalized === COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled) return false;
	return null;
}

// Normalizes route input to the shared preference wire vocabulary.
export function normalizeMediaPreferenceValue(
	raw: string | null
): CollectionMediaPreferenceValue | null {
	const normalized = raw?.trim().toLowerCase();
	if (
		normalized === COLLECTION_MEDIA_PREFERENCE_VALUES.Enabled ||
		normalized === COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
	) {
		return normalized;
	}
	return null;
}

// Appends a settled preference only when it differs from its extension-owned default.
export function appendMediaPreferenceParam(
	params: URLSearchParams,
	preference: ApiCollectionMediaPreference | null
): void {
	if (!preference || preference.enabled === preference.defaultEnabled) {
		params.delete(MEDIA_PREFERENCE_QUERY_PARAM);
		return;
	}
	params.set(
		MEDIA_PREFERENCE_QUERY_PARAM,
		preference.enabled
			? COLLECTION_MEDIA_PREFERENCE_VALUES.Enabled
			: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
	);
}

// Appends valid raw preference route state without inventing settled extension metadata.
export function appendNormalizedMediaPreferenceParam(
	params: URLSearchParams,
	raw: string | null
): void {
	const enabled = normalizeMediaPreference(raw);
	if (enabled === null) return;
	params.set(
		MEDIA_PREFERENCE_QUERY_PARAM,
		enabled
			? COLLECTION_MEDIA_PREFERENCE_VALUES.Enabled
			: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
	);
}

// Appends an exact token-local media version when one is selected.
export function appendMediaVariantParam(
	params: URLSearchParams,
	mediaVariant: string | null
): void {
	const normalized = normalizeMediaMode(mediaVariant);
	if (!normalized) return;
	params.set(MEDIA_VARIANT_QUERY_PARAM, normalized);
}

// Appends source and preference state shared by every collection-scoped destination.
export function appendCollectionMediaParams(
	params: URLSearchParams,
	media: CollectionMediaQueryState
): void {
	appendMediaModeParam(params, media.mediaMode);
	if (typeof media.mediaPreference === 'string') {
		appendNormalizedMediaPreferenceParam(params, media.mediaPreference);
		return;
	}
	appendMediaPreferenceParam(params, media.mediaPreference);
}

// Builds the complete source, preference, and version query for one token media request.
export function buildTokenMediaQuery(media: TokenMediaQueryState): URLSearchParams {
	const params = new URLSearchParams();
	appendCollectionMediaParams(params, media);
	appendMediaVariantParam(params, media.mediaVariant);
	return params;
}

// Projects settled API presentation state into collection navigation query state.
export function collectionMediaQueryState(
	media: ApiCollectionMediaState
): CollectionMediaQueryState {
	return {
		mediaMode: media.selectedMode,
		mediaPreference: media.preference
	};
}

export function resolveInitialMediaMode(params: {
	requestedMode: string | null;
	availableModes: ApiCollectionMediaMode[];
	defaultMode: string;
}): string {
	const requestedMode = normalizeMediaMode(params.requestedMode);
	if (requestedMode && params.availableModes.some((mode) => mode.key === requestedMode)) {
		return requestedMode;
	}
	return params.defaultMode;
}

export function nextMediaMode(
	availableModes: ApiCollectionMediaMode[],
	currentMode: string
): string {
	if (availableModes.length === 0) {
		return COLLECTION_MEDIA_MODES.Snapshot;
	}
	return nextMediaOption(availableModes, currentMode);
}

// Cycles an explicit option list while preserving an unknown current key as fallback.
export function nextMediaOption(
	availableOptions: readonly { key: string; label: string }[],
	currentKey: string
): string {
	if (availableOptions.length === 0) return currentKey;
	const currentIndex = availableOptions.findIndex((option) => option.key === currentKey);
	if (currentIndex === -1) {
		return availableOptions[0]?.key ?? currentKey;
	}
	return availableOptions[(currentIndex + 1) % availableOptions.length]?.key ?? currentKey;
}

export function mediaModeLabel(
	availableModes: ApiCollectionMediaMode[],
	mediaMode: string
): string {
	return availableModes.find((mode) => mode.key === mediaMode)?.label ?? mediaMode;
}
