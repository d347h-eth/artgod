<script lang="ts">
	import { page } from '$app/state';
	import CollectionViewPicker from './CollectionViewPicker.svelte';

	let context = $derived(page.data.collectionViewPage);
	let destination = $derived.by(() => {
		const path = page.url.searchParams.get('section');
		if (!context || !path || !path.startsWith('/') || path.includes('\\')) {
			return context?.basePath ?? '/';
		}
		const target = new URL(path, page.url.origin);
		const prefix = context.basePath === '/' ? '/' : context.basePath + '/';
		return target.origin === page.url.origin &&
			(target.pathname === context.basePath || target.pathname.startsWith(prefix))
			? target.pathname
			: context.basePath;
	});
</script>

{#if context}
	<section class="panel">
		<header class="panel-header">
			<h1>{context.collectionRef}</h1>
		</header>
		<div class="panel-content">
			<CollectionViewPicker
				{context}
				path={destination}
				initialGroup={page.url.searchParams.get('group')}
				query={new URLSearchParams()}
			/>
		</div>
	</section>
{/if}
