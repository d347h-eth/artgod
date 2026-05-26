<script lang="ts">
	import CollectionExtensionPageView from '$lib/components/CollectionExtensionPageView.svelte';
	import type { CollectionExtensionPageLoadResult } from '$lib/collection-extension-pages/page-load';

	let { data }: { data: CollectionExtensionPageLoadResult } = $props();
</script>

<CollectionExtensionPageView
	chain={data.chain}
	collection={data.collection}
	media={data.media}
	basePath={data.basePath}
	page={data.page}
/>
