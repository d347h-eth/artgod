<script lang="ts">
	import '../app.css';
	import DesktopLifecycleOverlay from '$lib/components/DesktopLifecycleOverlay.svelte';
	import DesktopRuntimeDrawer from '$lib/components/DesktopRuntimeDrawer.svelte';
	
	let { children } = $props();
</script>

<DesktopLifecycleOverlay />
{@render children()}
<DesktopRuntimeDrawer />
