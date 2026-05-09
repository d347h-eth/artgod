<script lang="ts">
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
	import { ACTIVITY_FEED_FILTER_KIND } from '@artgod/shared/types';
	import CollectionActivitiesView from '$lib/components/CollectionActivitiesView.svelte';
	import type {
		ApiActivitiesPage,
		ApiActivityExtensionEventRef,
		ApiActivityFeedFilterKind,
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiActivityEventMedia,
		ApiTokenAttribute,
		ApiTraitRangeFilter,
		ApiTokenPresentationSummary
	} from '$lib/api-types';
	import type { ApiTraitFacet } from '$lib/api-types';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		media: ApiCollectionMediaState;
		activities: ApiActivitiesPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		included: {
			tokensById: Record<string, ApiTokenPresentationSummary>;
			eventMediaByActivityId: Record<string, ApiActivityEventMedia>;
			hasTraitSummaryTemplate: boolean;
		};
		basePath: string;
		filterKind: ApiActivityFeedFilterKind | null;
		extensionEvent: ApiActivityExtensionEventRef | null;
		activityFilters: {
			tokenId: string | null;
			maker: string | null;
			contentHash: string | null;
			eventGroup: string | null;
		};
	};

	const fallbackActivities: ApiActivitiesPage = {
		items: [],
		prevCursor: null,
		nextCursor: null,
		limit: DEFAULT_PAGE_LIMIT,
		totalItems: 0,
		rangeStart: 0,
		rangeEnd: 0,
		currentPage: 0,
		totalPages: 0
	};

	let { data }: { data?: PageData } = $props();
</script>

<CollectionActivitiesView
	chain={data?.chain ?? null}
	collection={data?.collection ?? null}
	media={
		data?.media ?? {
			selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
			defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableModes: [
				{ key: COLLECTION_MEDIA_MODES.Snapshot, label: COLLECTION_MEDIA_MODES.Snapshot }
			]
		}
	}
	activities={data?.activities ?? fallbackActivities}
	facets={data?.facets ?? []}
	selectedTraits={data?.selectedTraits ?? []}
	selectedTraitRanges={data?.selectedTraitRanges ?? []}
	included={data?.included ?? { tokensById: {}, eventMediaByActivityId: {}, hasTraitSummaryTemplate: false }}
	basePath={data?.basePath ?? '/'}
	filterKind={data?.filterKind ?? (data?.extensionEvent ? null : ACTIVITY_FEED_FILTER_KIND.Sales)}
	extensionEvent={data?.extensionEvent ?? null}
	activityFilters={data?.activityFilters ?? { tokenId: null, maker: null, contentHash: null, eventGroup: null }}
/>
