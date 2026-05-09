<script lang="ts">
	import type { Component } from 'svelte';
	import type { TokenDetailExtensionSectionProps } from '$lib/token-detail-extension-sections/types';

	let {
		Section,
		chain,
		collection,
		token,
		media,
		hrefs
	}: TokenDetailExtensionSectionProps & {
		Section: Component<TokenDetailExtensionSectionProps>;
	} = $props();
</script>

<Section {chain} {collection} {token} {media} {hrefs} />
