import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import { appendCollectionMediaParams, type CollectionMediaPreferenceInput } from '$lib/media-mode';
import { joinPath, withQuery } from '$lib/route-paths';
import { appendTraitParams, appendTraitRangeParams } from '$lib/trait-filters';

export function buildCollectionCustomizationHref(params: {
	basePath: string;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	mediaMode?: string | null;
	mediaPreference?: CollectionMediaPreferenceInput;
}): string {
	const query = new URLSearchParams();
	appendCollectionMediaParams(query, {
		mediaMode: params.mediaMode ?? null,
		mediaPreference: params.mediaPreference ?? null
	});
	appendTraitParams(query, params.selectedTraits);
	appendTraitRangeParams(query, params.selectedTraitRanges);
	return withQuery(joinPath(params.basePath, 'customization'), query);
}
