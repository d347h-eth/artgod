<script lang="ts">
	import HolderTokensView from '$lib/components/HolderTokensView.svelte';

	let { data } = $props();
</script>

<HolderTokensView {...data} />
