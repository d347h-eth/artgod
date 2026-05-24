<script lang="ts">
	import AdminSectionFrame from '$lib/admin/components/AdminSectionFrame.svelte';
	import type { AdminConfigState } from '$lib/admin/configuration/ports';
	import DesktopRuntimeDrawer from '$lib/components/DesktopRuntimeDrawer.svelte';
	import type { AdminConsoleTab } from '$lib/runtime/lifecycle-ui-policy';

	let {
		tab,
		appConfig,
		appConfigLoading = false
	}: { tab: AdminConsoleTab; appConfig: AdminConfigState | null; appConfigLoading?: boolean } =
		$props();
</script>

<AdminSectionFrame>
	<DesktopRuntimeDrawer
		embedded={true}
		forcedTab={tab}
		showHeader={false}
		{appConfig}
		{appConfigLoading}
	/>
</AdminSectionFrame>
