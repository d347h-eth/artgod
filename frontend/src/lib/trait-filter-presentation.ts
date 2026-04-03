import type { ApiTraitFilterPresentationFeatureState } from '$lib/api-types';

export function defaultTraitFilterPresentationState(): ApiTraitFilterPresentationFeatureState {
	return {
		selectedSource: 'user',
		userConfig: { rangeKeys: [] },
		extensionConfig: null,
		effectiveConfig: { rangeKeys: [] },
		availableTraitKeys: []
	};
}

export function resolveTraitFilterPresentationState(
	input: ApiTraitFilterPresentationFeatureState | null | undefined
): ApiTraitFilterPresentationFeatureState {
	return input ?? defaultTraitFilterPresentationState();
}
