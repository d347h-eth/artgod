<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import { installBuiltInCollectionExtensions } from '$lib/collection-extension-built-ins';
	import AdminShell from '$lib/admin/components/AdminShell.svelte';
	import { installPointerFocusRelease } from '$lib/components/pointer-focus-release';
	import TokenPreviewOverlay from '$lib/components/TokenPreviewOverlay.svelte';
	import {
		createTokenPreviewController,
		setTokenPreviewControllerContext
	} from '$lib/components/token-preview-controller';
	import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';

	let { children } = $props();

	// Register bundled collection extensions before route components resolve extension views.
	installBuiltInCollectionExtensions();

	if (!IS_ADMIN_FRONTEND_TARGET) {
		setTokenPreviewControllerContext(createTokenPreviewController());
	}

	onMount(() => {
		document.documentElement.dataset.artgodHydrated = '1';
		const uninstallPointerFocusRelease = installPointerFocusRelease();

		return () => {
			delete document.documentElement.dataset.artgodHydrated;
			uninstallPointerFocusRelease();
		};
	});
</script>

{#if IS_ADMIN_FRONTEND_TARGET}
	<AdminShell />
{:else}
	{@render children()}
	<TokenPreviewOverlay />
{/if}
