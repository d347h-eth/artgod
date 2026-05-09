<script lang="ts">
	import type { Component } from 'svelte';
	import type { ActivityExtensionCellProps } from '$lib/activity-extension-views/types';

	let {
		Cell,
		activity,
		token,
		eventMedia,
		hrefs
	}: ActivityExtensionCellProps & {
		Cell: Component<ActivityExtensionCellProps>;
	} = $props();
</script>

<Cell {activity} {token} {eventMedia} {hrefs} />
