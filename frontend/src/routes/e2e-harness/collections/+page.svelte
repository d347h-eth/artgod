<script lang="ts">
	import CollectionsPageView from '$lib/components/CollectionsPageView.svelte';

	let { data } = $props();
</script>

<CollectionsPageView {...data} />
