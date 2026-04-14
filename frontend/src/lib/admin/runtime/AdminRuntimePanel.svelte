<script lang="ts">
	import AdminSectionFrame from '$lib/admin/components/AdminSectionFrame.svelte';
	import DesktopRuntimeDrawer from '$lib/components/DesktopRuntimeDrawer.svelte';
	import type { AdminConsoleTab } from '$lib/runtime/lifecycle-ui-policy';

	let { tab }: { tab: AdminConsoleTab } = $props();
</script>

<AdminSectionFrame>
	<DesktopRuntimeDrawer embedded={true} forcedTab={tab} showHeader={false} />
</AdminSectionFrame>
