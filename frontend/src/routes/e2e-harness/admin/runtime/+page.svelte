<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import AdminShell from '$lib/admin/components/AdminShell.svelte';
	import DesktopRuntimeDrawer from '$lib/components/DesktopRuntimeDrawer.svelte';
	import { provideAdminRuntimeStore } from '$lib/admin/runtime/store';
	import { createRuntimeRecoveryFixture, RECOVERY_HARNESS_SCENARIOS } from '$lib/e2e/runtime-recovery-fixture';
	let { data } = $props();
	const fixture = createRuntimeRecoveryFixture(untrack(() => data.scenario));
	provideAdminRuntimeStore(fixture.store);
	onMount(() => { window.runtimeRecoveryFixture = fixture; });
</script>

{#if data.scenario === RECOVERY_HARNESS_SCENARIOS.drawer}
	<DesktopRuntimeDrawer />
{:else}
	<AdminShell runtimeStore={fixture.store} configPort={fixture.configPort} />
{/if}
