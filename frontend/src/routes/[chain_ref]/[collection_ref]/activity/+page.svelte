<script lang="ts">
	import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
	import CollectionActivitiesView from '$lib/components/CollectionActivitiesView.svelte';
	import type {
		ApiActivitiesPage,
		ApiActivityFeedFilterKind,
		ApiChain,
		ApiCollection,
		ApiCollectionMediaState,
		ApiTokenAttribute,
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
		included: {
			tokensById: Record<string, ApiTokenPresentationSummary>;
		};
		basePath: string;
		filterKind: ApiActivityFeedFilterKind;
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
			selectedMode: 'snapshot',
			defaultMode: 'snapshot',
			availableModes: [{ key: 'snapshot', label: 'snapshot' }]
		}
	}
	activities={data?.activities ?? fallbackActivities}
	facets={data?.facets ?? []}
	selectedTraits={data?.selectedTraits ?? []}
	included={data?.included ?? { tokensById: {} }}
	basePath={data?.basePath ?? '/'}
	filterKind={data?.filterKind ?? 'sales'}
/>
