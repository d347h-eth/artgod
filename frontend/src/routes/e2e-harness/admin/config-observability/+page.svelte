<script lang="ts">
	import AdminConfigurationPanel from '$lib/admin/configuration/AdminConfigurationPanel.svelte';
	import type { AdminConfigSaveInput } from '$lib/admin/configuration/ports';
	import {
		ADMIN_CONFIG_OBSERVABILITY_TEST_ID,
		createAdminConfigObservabilityFixture
	} from '$lib/e2e/admin-config-observability-fixtures';

	const config = createAdminConfigObservabilityFixture();
	let savedConfig = $state<AdminConfigSaveInput | null>(null);
</script>

<main class="admin-config-observability-e2e-harness">
	<AdminConfigurationPanel
		{config}
		loading={false}
		infraRunning={true}
		onSave={async (input) => {
			savedConfig = input;
		}}
		onBenchmarkRpcEndpoints={async () => {
			throw new Error('RPC benchmarking is outside this fixture');
		}}
		onClose={() => undefined}
	/>
	<span data-testid={ADMIN_CONFIG_OBSERVABILITY_TEST_ID.SavedConfig} hidden>
		{savedConfig ? JSON.stringify(savedConfig) : ''}
	</span>
</main>

<style>
	.admin-config-observability-e2e-harness {
		min-height: 100vh;
		padding: 1rem;
	}
</style>
