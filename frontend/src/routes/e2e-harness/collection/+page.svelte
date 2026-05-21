<script lang="ts">
	import CollectionDetailView from '$lib/components/CollectionDetailView.svelte';

	let { data } = $props();
</script>

<CollectionDetailView {...data} />
