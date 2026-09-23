<script lang="ts">
	import CollectionActivitiesView from '$lib/components/CollectionActivitiesView.svelte';
	let {data}=$props();
</script>

<CollectionActivitiesView {...data} />
