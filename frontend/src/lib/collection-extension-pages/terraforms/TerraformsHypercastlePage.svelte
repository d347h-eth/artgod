<script lang="ts">
	import type { CollectionExtensionPageProps } from '$lib/collection-extension-pages/types';
	import TerraformsHypercastleOverview from '$lib/collection-extension-pages/terraforms/TerraformsHypercastleOverview.svelte';

	let {}: CollectionExtensionPageProps = $props();
</script>

<TerraformsHypercastleOverview />
