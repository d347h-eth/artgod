<script lang="ts">
	import AdminBotsPanel from '$lib/admin/bots/AdminBotsPanel.svelte';
	import { createAdminBotsAuthorizationFixture } from '$lib/e2e/admin-bots-authorization-fixtures';

	let { data } = $props();
	let fixture = $derived(createAdminBotsAuthorizationFixture(data.scenario));
</script>

<main class="admin-bots-e2e-harness">
	<AdminBotsPanel
		config={fixture.config}
		botPort={fixture.botPort}
		walletPort={fixture.walletPort}
	/>
</main>

<style>
	.admin-bots-e2e-harness {
		min-height: 100vh;
		padding: 1rem;
	}
</style>
