<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import DesktopRuntimeDrawer from '$lib/components/DesktopRuntimeDrawer.svelte';
	import TokenPreviewOverlay from '$lib/components/TokenPreviewOverlay.svelte';
	import {
		createTokenPreviewController,
		setTokenPreviewControllerContext
	} from '$lib/components/token-preview-controller';
	import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';

	let { children } = $props();
	setTokenPreviewControllerContext(createTokenPreviewController());

	onMount(() => {
		document.documentElement.dataset.artgodHydrated = '1';

		return () => {
			delete document.documentElement.dataset.artgodHydrated;
		};
	});
</script>

{#if IS_ADMIN_FRONTEND_TARGET}
	<DesktopRuntimeDrawer embedded={true} />
{:else}
	{@render children()}
	<TokenPreviewOverlay />
{/if}
