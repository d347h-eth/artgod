<script lang="ts">
	import { page } from '$app/state';
	import { COLLECTION_VIEW_PICKER_QUERY } from '$lib/collection-view';
	import CollectionViewPicker from './CollectionViewPicker.svelte';

	let context = $derived(page.data.collectionViewPage);
</script>

{#if context}
	<section class="panel">
		<header class="panel-header">
			<h1>{context.collectionRef}</h1>
		</header>
		<div class="panel-content">
			<CollectionViewPicker
				{context}
				path={context.pickerDestination?.path ?? context.basePath}
				initialGroup={page.url.searchParams.get(COLLECTION_VIEW_PICKER_QUERY.Group)}
				query={new URLSearchParams(context.pickerDestination?.query)}
			/>
		</div>
	</section>
{/if}
