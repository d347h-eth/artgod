	<script lang="ts">
		import type { BlockExplorerConfig } from '@artgod/shared/config/block-explorer';
		import CollectionCustomizationView from '$lib/components/CollectionCustomizationView.svelte';
	import type {
		ApiChain,
		ApiCollection,
		ApiTokenAttribute,
		ApiTraitRangeFilter,
		CollectionCustomizationApiResponse
	} from '$lib/api-types';
	import type { CollectionMediaPreferenceInput } from '$lib/media-mode';

	type PageData = {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		customization: CollectionCustomizationApiResponse['customization'] | null;
		basePath: string;
			selectedTraits: ApiTokenAttribute[];
			selectedTraitRanges: ApiTraitRangeFilter[];
			mediaMode: string | null;
			mediaPreference: CollectionMediaPreferenceInput;
			blockExplorer?: BlockExplorerConfig;
		};

	let { data }: { data?: PageData } = $props();
</script>

<CollectionCustomizationView
	chain={data?.chain ?? null}
	collection={data?.collection ?? null}
	customization={data?.customization ?? null}
	basePath={data?.basePath ?? '/'}
		selectedTraits={data?.selectedTraits ?? []}
		selectedTraitRanges={data?.selectedTraitRanges ?? []}
		mediaMode={data?.mediaMode ?? null}
		mediaPreference={data?.mediaPreference ?? null}
		blockExplorer={data?.blockExplorer}
	/>
