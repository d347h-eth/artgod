import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import { appendMediaModeParam } from '$lib/media-mode';
import { appendTraitParams, appendTraitRangeParams } from '$lib/trait-filters';

export function buildCollectionCustomizationHref(params: {
	basePath: string;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	mediaMode?: string | null;
}): string {
	const query = new URLSearchParams();
	appendMediaModeParam(query, params.mediaMode ?? null);
	appendTraitParams(query, params.selectedTraits);
	appendTraitRangeParams(query, params.selectedTraitRanges);
	const suffix = query.toString();
	return `${params.basePath}/customization${suffix ? `?${suffix}` : ''}`;
}
