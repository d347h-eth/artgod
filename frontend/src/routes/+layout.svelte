<script lang="ts">
	import '../app.css';
	import DesktopRuntimeDrawer from '$lib/components/DesktopRuntimeDrawer.svelte';
	
	let { children } = $props();
</script>

{@render children()}
<DesktopRuntimeDrawer />
