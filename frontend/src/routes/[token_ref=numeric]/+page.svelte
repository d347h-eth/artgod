<script lang="ts">
	import TokenDetailPage from '../[chain_ref]/[collection_ref]/[token_ref]/+page.svelte';

	let { data } = $props();
</script>

<TokenDetailPage {data} />
