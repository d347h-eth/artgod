<script lang="ts">
	import BootstrapRunsPageView from '$lib/components/BootstrapRunsPageView.svelte';
	import { BOOTSTRAP_PROBE_E2E_CHAIN_QUERY_PARAM } from '$lib/e2e/bootstrap-probe-fixtures';

	let { data } = $props();
</script>

{#if data.chainSwitchChoices.length}
	<nav class="secondary-tabs" aria-label="Test chain">
		{#each data.chainSwitchChoices as chain}
			<a href={`?${BOOTSTRAP_PROBE_E2E_CHAIN_QUERY_PARAM}=${chain.slug}`}>{chain.name}</a>
		{/each}
	</nav>
{/if}
<BootstrapRunsPageView {...data} />
