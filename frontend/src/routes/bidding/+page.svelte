<script lang="ts">
	import CollectionBiddingPage from '../[chain_ref]/[collection_ref]/bidding/+page.svelte';

	let { data } = $props();
</script>

<CollectionBiddingPage {data} />
