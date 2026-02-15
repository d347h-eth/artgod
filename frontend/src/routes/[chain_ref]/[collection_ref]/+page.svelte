<script lang="ts">
	import CollectionDetailView from '$lib/components/CollectionDetailView.svelte';
	import type {
		ApiChain,
		ApiCollection,
		ApiTokenAttribute,
		ApiTokensPage,
		ApiTraitFacet
	} from '$lib/api-types';

	type PageData = {
		chain: ApiChain;
		collection: ApiCollection;
		tokens: ApiTokensPage;
		facets: ApiTraitFacet[];
		selectedTraits: ApiTokenAttribute[];
		basePath: string;
	};

	let { data }: { data?: PageData } = $props();

	const fallbackTokens: ApiTokensPage = {
		items: [],
		nextCursor: null,
		limit: 25
	};
</script>

<CollectionDetailView
	chain={data?.chain ?? null}
	collection={data?.collection ?? null}
	tokens={data?.tokens ?? fallbackTokens}
	facets={data?.facets ?? []}
	selectedTraits={data?.selectedTraits ?? []}
	basePath={data?.basePath ?? '/'}
/>
