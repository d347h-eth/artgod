<script lang="ts">
	import CollectionBiddingView from '$lib/components/CollectionBiddingView.svelte';
	import type {
		ApiBiddingJob,
		ApiChain,
		ApiCollection,
		ApiTokenAttribute,
		ApiTraitRangeFilter
	} from '$lib/api-types';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		jobs: ApiBiddingJob[];
		basePath: string;
		selectedTraits: ApiTokenAttribute[];
		selectedTraitRanges: ApiTraitRangeFilter[];
		mediaMode: string | null;
	};

	let { data }: { data?: PageData } = $props();
</script>

<CollectionBiddingView
	chain={data?.chain ?? null}
	collection={data?.collection ?? null}
	jobs={data?.jobs ?? []}
	basePath={data?.basePath ?? '/'}
	selectedTraits={data?.selectedTraits ?? []}
	selectedTraitRanges={data?.selectedTraitRanges ?? []}
	mediaMode={data?.mediaMode ?? null}
/>
