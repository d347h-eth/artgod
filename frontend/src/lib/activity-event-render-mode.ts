import type { ApiCollectionMediaMode } from '$lib/api-types';

export function resolveActivityEventRenderMode(
	preferredMediaMode: string,
	renderModes: readonly ApiCollectionMediaMode[] | undefined
): string {
	if (!renderModes || renderModes.length === 0) {
		return preferredMediaMode;
	}

	const availableModeKeys = new Set(renderModes.map((mode) => mode.key));
	if (availableModeKeys.has(preferredMediaMode)) {
		return preferredMediaMode;
	}
	return renderModes.at(-1)?.key ?? preferredMediaMode;
}
