<script lang="ts">
	import CollectionBiddingView from '$lib/components/CollectionBiddingView.svelte';

	let { data } = $props();
</script>

<CollectionBiddingView {...data} />
