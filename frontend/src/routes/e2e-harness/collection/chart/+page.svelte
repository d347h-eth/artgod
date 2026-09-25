<script lang="ts">
	import CollectionPriceChartView from '$lib/components/CollectionPriceChartView.svelte';
	let { data } = $props();
</script>
<CollectionPriceChartView {...data} />
