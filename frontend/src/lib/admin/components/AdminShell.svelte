<script lang="ts">
	import { onMount } from 'svelte';
	import { resolveAdminActionFlow } from '$lib/admin/control-flow/admin-action-flow';
	import AdminConfigurationPanel from '$lib/admin/configuration/AdminConfigurationPanel.svelte';
	import { createTauriAdminConfigPort } from '$lib/admin/configuration/adapters/tauri-admin-config-port';
	import type {
		AdminRpcEndpointBenchmarkInput,
		AdminRpcEndpointBenchmarkResult,
		AdminConfigSaveInput,
		AdminConfigState
	} from '$lib/admin/configuration/ports';
	import AdminRuntimePanel from '$lib/admin/runtime/AdminRuntimePanel.svelte';
	import AdminBotsPanel from '$lib/admin/bots/AdminBotsPanel.svelte';
	import AdminWalletsPanel from '$lib/admin/wallets/AdminWalletsPanel.svelte';
	import InfoTooltip from '$lib/components/InfoTooltip.svelte';
	import { adminRuntimeStore } from '$lib/admin/runtime/store';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import type { AdminConsoleTab } from '$lib/runtime/lifecycle-ui-policy';
	import { RUNTIME_STATUS_STATES } from '$lib/runtime/lifecycle/ports';
	import {
		RPC_AUTO_SOURCING_TRACKING_POLICY_ENV_KEY,
		RPC_ENDPOINT_BENCHMARK_SOURCES,
		normalizeRpcAutoSourcingTrackingPolicy
	} from '@artgod/shared/config/rpc-auto-sourcing';
	import { OPENSEA_API_KEY_ENV } from '@artgod/shared/config/opensea-integration';
	import { RPC_ENDPOINT_LIST_ENV_KEY } from '@artgod/shared/config/rpc-endpoints';

	type AdminShellTab = 'config' | 'system' | 'wallets' | 'bots';

	const configPort = createTauriAdminConfigPort();
	const runtimeState = adminRuntimeStore.state;
	const ADMIN_CONFIG_BUSY_ACTIONS = {
		save: 'save',
		defaults: 'defaults',
		rpcAutoSource: 'rpc_auto_source',
		rpcSanityCheck: 'rpc_sanity_check',
		rpcBenchmark: 'rpc_benchmark'
	} as const;
	const MISSING_OPENSEA_API_KEY_WARNING =
		'Set the OpenSea API key to enable market data and bidding bot features.';

	let activeTab = $state<AdminShellTab | null>(null);
	let config = $state<AdminConfigState | null>(null);
	let configLoading = $state(true);
	let configBusyAction = $state<string | null>(null);
	let configError = $state<string | null>(null);
	let configNotice = $state<string | null>(null);
	let rpcAutoSourcingFailed = $state(false);
	let startupAutoStartRequested = false;

	const tabs: Array<{ id: AdminShellTab; label: string }> = [
		{ id: 'system', label: 'system' },
		{ id: 'wallets', label: 'wallets' },
		{ id: 'bots', label: 'bots' }
	];

	const actionFlow = $derived(
		resolveAdminActionFlow({
			config,
			configLoading,
			configBusyAction,
			runtimeInitialized: $runtimeState.initialized,
			runtimeStatus: $runtimeState.status,
			runtimeBusyAction: $runtimeState.busyAction,
			lifecyclePhase: $runtimeState.lifecycle.phase,
			rpcAutoSourcingFailed
		})
	);
	const openSeaApiKeyMissing = $derived(
		config !== null && (config.values[OPENSEA_API_KEY_ENV] ?? '').trim().length === 0
	);
	const stopInfraDisabled = $derived(actionFlow.userland.disabled);
	const configRestartNoticeVisible = $derived(
		$runtimeState.status?.state === RUNTIME_STATUS_STATES.running
	);
	const hasHeaderMessages = $derived(
		configError !== null || $runtimeState.error !== null || configNotice !== null
	);

	onMount(() => {
		void loadConfig();
		void adminRuntimeStore.init();
		return () => {
			adminRuntimeStore.dispose();
		};
	});

	function resolveRuntimeTab(tab: AdminShellTab | null): AdminConsoleTab | null {
		if (tab === 'system') {
			return 'lifecycle';
		}
		return null;
	}

	const activeRuntimeTab = $derived(resolveRuntimeTab(activeTab));

	async function loadConfig(): Promise<void> {
		configLoading = true;
		configError = null;
		try {
			const nextConfig = await configPort.getConfig();
			config = nextConfig;
			requestStartupAutoStart(nextConfig);
		} catch (error) {
			configError = toErrorMessage(error, 'Configuration could not be loaded.');
		} finally {
			configLoading = false;
		}
	}

	async function saveConfig(input: AdminConfigSaveInput): Promise<void> {
		await withConfigAction(ADMIN_CONFIG_BUSY_ACTIONS.save, async () => {
			config = await configPort.saveConfig(input);
			configNotice = 'configuration saved';
			rpcAutoSourcingFailed = false;
			activeTab = null;
		});
	}

	async function bootSystem(): Promise<void> {
		const flow = actionFlow;
		if (flow.boot.disabled) {
			return;
		}
		let rpcAlreadyBenchmarked = false;
		if (flow.boot.usesDefaults) {
			const configuredDefaults = await withConfigAction(ADMIN_CONFIG_BUSY_ACTIONS.rpcAutoSource, async () => {
				const nextValues = { ...(config?.values ?? {}) };
				if (isMissingRpcEndpointList(nextValues)) {
					// Source RPC endpoints before first-launch defaults render the runtime env.
					const result = await configPort.benchmarkRpcEndpoints({
						source: RPC_ENDPOINT_BENCHMARK_SOURCES.savedChainlist,
						trackingPolicy: resolveRpcAutoSourcingTrackingPolicy(nextValues)
					});
					nextValues[RPC_ENDPOINT_LIST_ENV_KEY] = result.encodedEndpoints;
					configNotice = formatRpcBenchmarkNotice(result);
					rpcAlreadyBenchmarked = true;
				}
				config = await configPort.saveConfig({
					values: nextValues,
					autoLaunchOnStartup: false
				});
				configNotice = configNotice ?? 'default settings applied';
				rpcAutoSourcingFailed = false;
			});
			if (!configuredDefaults || !config || configBusyAction !== null || configError) {
				rpcAutoSourcingFailed = true;
				return;
			}
		}
		if (!rpcAlreadyBenchmarked) {
			const benchmarkedConfiguredList = await sanityCheckConfiguredRpcEndpointList();
			if (!benchmarkedConfiguredList) {
				return;
			}
		}
		activeTab = 'system';
		await adminRuntimeStore.start();
	}

	async function sanityCheckConfiguredRpcEndpointList(): Promise<boolean> {
		const currentConfig = config;
		if (!currentConfig || isMissingRpcEndpointList(currentConfig.values)) {
			return false;
		}
		return withConfigAction(ADMIN_CONFIG_BUSY_ACTIONS.rpcSanityCheck, async () => {
			// Verify at least one configured endpoint works without replacing the saved endpoint list.
			const result = await configPort.benchmarkRpcEndpoints({
				source: RPC_ENDPOINT_BENCHMARK_SOURCES.configuredEndpoints,
				trackingPolicy: resolveRpcAutoSourcingTrackingPolicy(currentConfig.values),
				rpcUrlList: currentConfig.values[RPC_ENDPOINT_LIST_ENV_KEY]
			});
			configNotice = formatRpcBenchmarkNotice(result);
		});
	}

	async function benchmarkRpcEndpoints(
		input: AdminRpcEndpointBenchmarkInput
	): Promise<AdminRpcEndpointBenchmarkResult> {
		if (configBusyAction !== null) {
			throw new Error('Configuration action already running.');
		}
		configBusyAction = ADMIN_CONFIG_BUSY_ACTIONS.rpcBenchmark;
		configError = null;
		configNotice = null;
		try {
			const result = await configPort.benchmarkRpcEndpoints(input);
			configNotice = formatRpcBenchmarkNotice(result);
			rpcAutoSourcingFailed = false;
			return result;
		} catch (error) {
			configError = toErrorMessage(error, 'RPC endpoint benchmark failed.');
			throw error;
		} finally {
			configBusyAction = null;
		}
	}

	function requestStartupAutoStart(nextConfig: AdminConfigState): void {
		if (startupAutoStartRequested || !nextConfig.autoLaunchOnStartup) {
			return;
		}
		startupAutoStartRequested = true;
		void autoStartSystem();
	}

	async function autoStartSystem(): Promise<void> {
		activeTab = 'system';
		const benchmarkedConfiguredList = await sanityCheckConfiguredRpcEndpointList();
		if (!benchmarkedConfiguredList) {
			return;
		}
		await adminRuntimeStore.autoStart();
	}

	function openConfiguration(): void {
		if (actionFlow.configure.disabled) {
			return;
		}
		configNotice = null;
		activeTab = 'config';
	}

	function handleEnterUserland(): void {
		if (actionFlow.userland.disabled) {
			return;
		}
		void adminRuntimeStore.openUserlandUi();
	}

	function handleOpenLogs(): void {
		void adminRuntimeStore.openLogsPath();
	}

	function handleStopInfra(): void {
		if (stopInfraDisabled) {
			return;
		}
		activeTab = 'system';
		void adminRuntimeStore.stop();
	}

	function handleShutdown(): void {
		void adminRuntimeStore.shutdown();
	}

	async function withConfigAction(action: string, work: () => Promise<void>): Promise<boolean> {
		if (configBusyAction !== null) {
			return false;
		}
		configBusyAction = action;
		configError = null;
		configNotice = null;
		try {
			await work();
			return true;
		} catch (error) {
			configError = toErrorMessage(error, 'Configuration action failed.');
			return false;
		} finally {
			configBusyAction = null;
		}
	}

	function isMissingRpcEndpointList(values: Record<string, string>): boolean {
		return (values[RPC_ENDPOINT_LIST_ENV_KEY] ?? '').trim().length === 0;
	}

	function resolveRpcAutoSourcingTrackingPolicy(values: Record<string, string>): string {
		return normalizeRpcAutoSourcingTrackingPolicy(
			values[RPC_AUTO_SOURCING_TRACKING_POLICY_ENV_KEY]?.trim()
		);
	}

	function formatRpcBenchmarkNotice(result: AdminRpcEndpointBenchmarkResult): string {
		if (result.source === RPC_ENDPOINT_BENCHMARK_SOURCES.configuredEndpoints) {
			return `${result.sourceDescription}: ${result.successCount}/${result.eligibleCount} endpoints passed`;
		}
		const trackedCount = result.trackingCounts.yes + result.trackingCounts.unspecified;
		return `${result.sourceDescription}: ${result.successCount}/${result.eligibleCount} endpoints passed, tracking none ${result.trackingCounts.none}, limited ${result.trackingCounts.limited}, tracked ${trackedCount}`;
	}

	function toErrorMessage(error: unknown, fallback: string): string {
		if (error instanceof Error && error.message.trim().length > 0) {
			return error.message;
		}
		if (typeof error === 'string' && error.trim().length > 0) {
			return error;
		}
		return fallback;
	}
</script>

<svelte:head>
	<title>ArtGod Admin</title>
</svelte:head>

<main class="admin-shell">
	<div class="admin-shell-body">
		<header class="admin-shell-header">
			<div class="admin-shell-title-block">
				<h1>ArtGod</h1>
				<p class="admin-shell-eyebrow">{APP_VERSION}</p>
			</div>
			<div class="admin-flow-action-grid" aria-label="Admin launch sequence">
				<span class="admin-flow-action-shell admin-flow-primary-config">
					<button
						type="button"
						class="admin-flow-action"
						class:admin-flow-action-selected={activeTab === 'config'}
						class:admin-flow-action-has-warning={openSeaApiKeyMissing}
						onclick={openConfiguration}
						disabled={actionFlow.configure.disabled}
					>
						{actionFlow.configure.label}
					</button>
					{#if openSeaApiKeyMissing}
						<InfoTooltip
							text={MISSING_OPENSEA_API_KEY_WARNING}
							tone="warning"
							className="admin-flow-warning-tooltip"
						/>
					{/if}
				</span>
				<span class="admin-flow-arrow admin-flow-arrow-config" aria-hidden="true">⇨</span>
				<span class="admin-flow-action-shell admin-flow-primary-boot">
					<button
						type="button"
						class="admin-flow-action"
						class:admin-flow-action-has-warning={actionFlow.boot.disabledReason !== null}
						onclick={() => void bootSystem()}
						disabled={actionFlow.boot.disabled}
					>
						{configBusyAction === 'defaults' ? 'applying defaults...' : actionFlow.boot.label}
					</button>
					{#if actionFlow.boot.disabledReason}
						<InfoTooltip
							text={actionFlow.boot.disabledReason}
							tone="warning"
							className="admin-flow-warning-tooltip"
						/>
					{/if}
				</span>
				<span class="admin-flow-arrow admin-flow-arrow-userland" aria-hidden="true">⇨</span>
				<button
					type="button"
					class="admin-flow-action admin-flow-primary-userland"
					onclick={handleEnterUserland}
					disabled={actionFlow.userland.disabled}
				>
					{actionFlow.userland.label}
				</button>
				<button
					type="button"
					class="admin-flow-action admin-flow-secondary-logs"
					onclick={handleOpenLogs}
				>
					logs
				</button>
				<button
					type="button"
					class="admin-flow-action admin-flow-secondary-stop"
					onclick={handleStopInfra}
					disabled={stopInfraDisabled}
				>
					stop infra
				</button>
				<button
					type="button"
					class="admin-flow-action admin-flow-secondary-shutdown"
					onclick={handleShutdown}
				>
					shutdown
				</button>
			</div>
			{#if hasHeaderMessages}
				<div class="admin-shell-message-stack">
					{#if configError}
						<p class="runtime-error" role="alert">{configError}</p>
					{/if}
					{#if $runtimeState.error}
						<p class="runtime-error" role="alert">{$runtimeState.error}</p>
					{/if}
					{#if configNotice}
						<p class="runtime-pass">{configNotice}</p>
					{/if}
				</div>
			{/if}
		</header>

		<nav class="runtime-tabs admin-shell-tabs" aria-label="Admin sections">
			{#each tabs as tab}
				<button
					type="button"
					class:runtime-tab-active={activeTab === tab.id}
					disabled={activeTab === tab.id}
					onclick={() => {
						activeTab = tab.id;
						configNotice = null;
					}}
				>
					{tab.label}
				</button>
			{/each}
		</nav>

		{#if activeTab !== null}
			<section class="admin-shell-surface">
				{#if activeRuntimeTab !== null}
					<AdminRuntimePanel
						tab={activeRuntimeTab}
						appConfig={config}
						appConfigLoading={configLoading}
					/>
				{:else if activeTab === 'config'}
					<AdminConfigurationPanel
						{config}
						loading={configLoading}
						busyAction={configBusyAction}
						errorMessage={configError}
						onSave={saveConfig}
						onBenchmarkRpcEndpoints={benchmarkRpcEndpoints}
						infraRunning={configRestartNoticeVisible}
						onClose={() => {
							activeTab = null;
							configNotice = null;
						}}
					/>
				{:else if activeTab === 'wallets'}
					<AdminWalletsPanel />
				{:else}
					<AdminBotsPanel />
				{/if}
			</section>
		{/if}
	</div>
</main>

<style>
	.admin-shell {
		--admin-shell-padding: 1.5rem;
		min-height: 100vh;
		height: 100dvh;
		padding: var(--admin-shell-padding);
		overflow-x: hidden;
		overflow-y: hidden;
		background:
			radial-gradient(circle at top left, rgba(147, 209, 222, 0.14), transparent 34%),
			linear-gradient(180deg, rgba(17, 16, 15, 0.98), rgba(41, 39, 38, 0.98));
	}

	.admin-shell-body {
		width: 100%;
		height: calc(100dvh - (var(--admin-shell-padding) * 2));
		min-height: 0;
		margin: 0 auto;
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr);
		gap: 1.2rem;
		min-width: 0;
	}

	.admin-shell-header {
		border: 1px solid rgba(113, 141, 188, 0.45);
		background: rgba(17, 16, 15, 0.76);
		padding: 1.25rem 1.4rem;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
		display: grid;
		gap: 0.85rem;
		align-content: start;
	}

	.admin-shell-title-block {
		display: grid;
		gap: 0.35rem;
	}

	.admin-shell-eyebrow {
		margin: 0;
		font-size: 0.72rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--c-cyan);
	}

	.admin-shell-header h1 {
		margin: 0;
		font-size: clamp(1.5rem, 2vw, 2.1rem);
		letter-spacing: 0.04em;
		color: var(--c-yellow);
	}

	.admin-flow-action-grid {
		display: grid;
		grid-template-columns:
			minmax(9rem, max-content) auto minmax(9rem, max-content) auto
			minmax(9rem, max-content);
		align-items: center;
		column-gap: 0.55rem;
		row-gap: 0.78rem;
		width: fit-content;
		max-width: 100%;
		overflow: visible;
		justify-self: center;
	}

	.admin-flow-action-grid button {
		white-space: nowrap;
	}

	.admin-flow-action-shell {
		position: relative;
		display: inline-flex;
		align-items: center;
		width: 100%;
		min-width: 0;
	}

	.admin-flow-action {
		border-color: var(--c-blue);
		color: var(--c-ice);
		background: color-mix(in srgb, var(--c-cyan) 18%, var(--c-bg));
		text-transform: uppercase;
		letter-spacing: 0.05em;
		min-width: 9rem;
		width: 100%;
	}

	.admin-flow-primary-config {
		grid-column: 1;
		grid-row: 1;
	}

	.admin-flow-arrow-config {
		grid-column: 2;
		grid-row: 1;
	}

	.admin-flow-primary-boot {
		grid-column: 3;
		grid-row: 1;
	}

	.admin-flow-arrow-userland {
		grid-column: 4;
		grid-row: 1;
	}

	.admin-flow-primary-userland {
		grid-column: 5;
		grid-row: 1;
	}

	.admin-flow-secondary-logs {
		grid-column: 1;
		grid-row: 2;
	}

	.admin-flow-secondary-stop {
		grid-column: 3;
		grid-row: 2;
	}

	.admin-flow-secondary-shutdown {
		grid-column: 5;
		grid-row: 2;
	}

	.admin-flow-action-has-warning {
		padding-right: 2rem;
	}

	:global(.admin-flow-warning-tooltip.info-tooltip) {
		position: absolute;
		right: 0.55rem;
		top: 50%;
		transform: translateY(-50%);
		z-index: 2;
	}

	.admin-flow-action:not(:disabled):hover,
	.admin-flow-action:not(:disabled):focus-visible {
		border-color: var(--c-blue);
		color: var(--c-ice);
		background: color-mix(in srgb, var(--c-blue) 45%, var(--c-bg));
	}

	.admin-flow-action-selected,
	.admin-flow-action-selected:disabled,
	.admin-flow-action-selected:disabled:hover,
	.admin-flow-action-selected:disabled:focus-visible {
		border-color: var(--c-orange);
		color: var(--c-orange);
		background: var(--c-bg);
		cursor: default;
		opacity: 1;
	}

	.admin-flow-arrow {
		color: var(--c-sand);
		font-size: 1rem;
		line-height: 1;
		opacity: 0.78;
	}

	.admin-shell-message-stack {
		display: grid;
		gap: 0.45rem;
		justify-items: center;
	}

	.admin-shell-message-stack p {
		margin: 0;
	}

	.admin-shell-tabs {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		align-items: stretch;
		width: 100%;
	}

	.admin-shell-tabs button {
		width: 100%;
		min-width: 0;
	}

	.admin-shell-surface {
		height: 100%;
		min-width: 0;
		min-height: 0;
		max-width: 100%;
		overflow-x: hidden;
		overflow-y: hidden;
	}

	@media (max-width: 70rem) {
		.admin-shell-tabs {
			overflow-x: auto;
			white-space: nowrap;
		}
	}

	@media (max-width: 40rem) {
		.admin-shell {
			--admin-shell-padding: 1rem;
		}

		.admin-shell-header {
			padding: 1rem;
		}
	}
</style>
