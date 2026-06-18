<script lang="ts">
	import BootstrapRunsPageView from '$lib/components/BootstrapRunsPageView.svelte';

	let { data } = $props();
</script>

<BootstrapRunsPageView {...data} />
