<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import { installBuiltInActivityExtensionViews } from '$lib/activity-extension-views/built-ins';
	import AdminShell from '$lib/admin/components/AdminShell.svelte';
	import TokenPreviewOverlay from '$lib/components/TokenPreviewOverlay.svelte';
	import {
		createTokenPreviewController,
		setTokenPreviewControllerContext
	} from '$lib/components/token-preview-controller';
	import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';

	let { children } = $props();

	// Register bundled extension views before route components resolve activity feed views.
	installBuiltInActivityExtensionViews();

	if (!IS_ADMIN_FRONTEND_TARGET) {
		setTokenPreviewControllerContext(createTokenPreviewController());
	}

	onMount(() => {
		document.documentElement.dataset.artgodHydrated = '1';

		return () => {
			delete document.documentElement.dataset.artgodHydrated;
		};
	});
</script>

{#if IS_ADMIN_FRONTEND_TARGET}
	<AdminShell />
{:else}
	{@render children()}
	<TokenPreviewOverlay />
{/if}
