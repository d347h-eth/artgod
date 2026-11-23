<script lang="ts">
	import { provideCollectionView } from '$lib/collection-view-context';
	import { selectedCollectionView } from '$lib/collection-view';
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

	let { children, data } = $props();

	// Register bundled collection extensions before route components resolve extension views.
	installBuiltInCollectionExtensions();

	provideCollectionView(() => data.collectionViewPage);
	const selected = $derived(selectedCollectionView(data.collectionViewPage));
	const scopeKey = $derived(
		JSON.stringify([data.collectionViewPage?.basePath, selected?.id, selected?.generation])
	);
	const preview = !IS_ADMIN_FRONTEND_TARGET
		? setTokenPreviewControllerContext(createTokenPreviewController(() => selected))
		: null;
	$effect(() => {
		scopeKey;
		preview?.closeTokenPreview();
	});

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
	{#key scopeKey}{@render children()}{/key}
	<TokenPreviewOverlay />
{/if}
