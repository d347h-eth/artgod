<script lang="ts">
	import type { Component } from 'svelte';
	import type { CollectionExtensionPageProps } from '$lib/collection-extension-pages/types';

	let {
		Page,
		chain,
		collection,
		media,
		basePath,
		page,
		actions
	}: CollectionExtensionPageProps & {
		Page: Component<CollectionExtensionPageProps>;
	} = $props();
</script>

<Page {chain} {collection} {media} {basePath} {page} {actions} />
