import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_QUERY_PARAMS
} from '@artgod/shared/extensions';
import type { ApiCollectionMediaMode } from '$lib/api-types';

export const MEDIA_MODE_QUERY_PARAM = COLLECTION_MEDIA_QUERY_PARAMS.MediaMode;

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

export function nextMediaMode(availableModes: ApiCollectionMediaMode[], currentMode: string): string {
	if (availableModes.length === 0) {
		return COLLECTION_MEDIA_MODES.Snapshot;
	}
	const currentIndex = availableModes.findIndex((mode) => mode.key === currentMode);
	if (currentIndex === -1) {
		return availableModes[0]?.key ?? COLLECTION_MEDIA_MODES.Snapshot;
	}
	return availableModes[(currentIndex + 1) % availableModes.length]?.key ?? currentMode;
}

export function mediaModeLabel(availableModes: ApiCollectionMediaMode[], mediaMode: string): string {
	return availableModes.find((mode) => mode.key === mediaMode)?.label ?? mediaMode;
}
