<script lang="ts">
	import type { Component } from 'svelte';
	import type { ActivityExtensionFiltersProps } from '$lib/activity-extension-views/types';

	let {
		Filters,
		chainRef,
		feed,
		filters,
		onApply
	}: ActivityExtensionFiltersProps & {
		Filters: Component<ActivityExtensionFiltersProps>;
	} = $props();
</script>

<Filters {chainRef} {feed} {filters} {onApply} />
