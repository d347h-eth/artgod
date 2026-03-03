<script lang="ts">
	import '../app.css';
	import DesktopRuntimeDrawer from '$lib/components/DesktopRuntimeDrawer.svelte';
	import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';

	let { children } = $props();
</script>

{#if IS_ADMIN_FRONTEND_TARGET}
	<DesktopRuntimeDrawer embedded={true} />
{:else}
	{@render children()}
{/if}
