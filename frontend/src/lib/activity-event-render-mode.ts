import type { ApiCollectionMediaMode } from '$lib/api-types';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';

export function resolveActivityEventRenderMode(
	preferredMediaMode: string,
	renderModes: readonly ApiCollectionMediaMode[] | undefined
): string {
	if (!renderModes || renderModes.length === 0) {
		return preferredMediaMode;
	}

	const availableModeKeys = new Set(renderModes.map((mode) => mode.key));
	if (
		preferredMediaMode === COLLECTION_MEDIA_MODES.Artifact &&
		availableModeKeys.has(COLLECTION_MEDIA_MODES.Artifact)
	) {
		return COLLECTION_MEDIA_MODES.Artifact;
	}
	return renderModes.at(-1)?.key ?? preferredMediaMode;
}
