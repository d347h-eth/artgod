<script lang="ts">
	import { onMount } from 'svelte';
	import { resolveAdminActionFlow } from '$lib/admin/control-flow/admin-action-flow';
	import AdminConfigurationPanel from '$lib/admin/configuration/AdminConfigurationPanel.svelte';
	import { createTauriAdminConfigPort } from '$lib/admin/configuration/adapters/tauri-admin-config-port';
	import type {
		AdminConfigSaveInput,
		AdminConfigState
	} from '$lib/admin/configuration/ports';
	import AdminRuntimePanel from '$lib/admin/runtime/AdminRuntimePanel.svelte';
	import AdminBotsPanel from '$lib/admin/bots/AdminBotsPanel.svelte';
	import AdminWalletsPanel from '$lib/admin/wallets/AdminWalletsPanel.svelte';
	import { adminRuntimeStore } from '$lib/admin/runtime/store';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import type { AdminConsoleTab } from '$lib/runtime/lifecycle-ui-policy';

	type AdminShellTab = 'config' | 'system' | 'control' | 'wallets' | 'bots' | 'logs';

	const configPort = createTauriAdminConfigPort();
	const runtimeState = adminRuntimeStore.state;

	let activeTab = $state<AdminShellTab | null>(null);
	let config = $state<AdminConfigState | null>(null);
	let configLoading = $state(true);
	let configBusyAction = $state<string | null>(null);
	let configError = $state<string | null>(null);
	let configNotice = $state<string | null>(null);
	let startupAutoStartRequested = false;

	const tabs: Array<{ id: AdminShellTab; label: string }> = [
		{ id: 'system', label: 'system' },
		{ id: 'control', label: 'control' },
		{ id: 'wallets', label: 'wallets' },
		{ id: 'bots', label: 'bots' },
		{ id: 'logs', label: 'logs' }
	];

	const actionFlow = $derived(
		resolveAdminActionFlow({
			config,
			configLoading,
			configBusyAction,
			runtimeInitialized: $runtimeState.initialized,
			runtimeStatus: $runtimeState.status,
			runtimeBusyAction: $runtimeState.busyAction,
			lifecyclePhase: $runtimeState.lifecycle.phase
		})
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
		if (tab === 'control') {
			return 'status';
		}
		if (tab === 'logs') {
			return 'logs';
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
		await withConfigAction('save', async () => {
			config = await configPort.saveConfig(input);
			configNotice = 'configuration saved';
			activeTab = null;
		});
	}

	async function bootSystem(): Promise<void> {
		const flow = actionFlow;
		if (flow.boot.disabled) {
			return;
		}
		if (flow.boot.usesDefaults) {
			await withConfigAction('defaults', async () => {
				config = await configPort.useDefaults();
				configNotice = 'default settings applied';
			});
			if (!config || configBusyAction !== null || configError) {
				return;
			}
		}
		activeTab = 'system';
		await adminRuntimeStore.start();
	}

	function requestStartupAutoStart(nextConfig: AdminConfigState): void {
		if (startupAutoStartRequested || !nextConfig.autoLaunchOnStartup) {
			return;
		}
		startupAutoStartRequested = true;
		activeTab = 'system';
		void adminRuntimeStore.autoStart();
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

	async function withConfigAction(action: string, work: () => Promise<void>): Promise<void> {
		if (configBusyAction !== null) {
			return;
		}
		configBusyAction = action;
		configError = null;
		configNotice = null;
		try {
			await work();
		} catch (error) {
			configError = toErrorMessage(error, 'Configuration action failed.');
		} finally {
			configBusyAction = null;
		}
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
			<div class="admin-flow-actions" aria-label="Admin launch sequence">
				<button
					type="button"
					class="admin-flow-action"
					class:admin-flow-action-selected={activeTab === 'config'}
					onclick={openConfiguration}
					disabled={actionFlow.configure.disabled}
				>
					{actionFlow.configure.label}
				</button>
				<span class="admin-flow-arrow" aria-hidden="true">⇨</span>
				<button
					type="button"
					class="admin-flow-action"
					onclick={() => void bootSystem()}
					disabled={actionFlow.boot.disabled}
				>
					{configBusyAction === 'defaults' ? 'applying defaults...' : actionFlow.boot.label}
				</button>
				<span class="admin-flow-arrow" aria-hidden="true">⇨</span>
				<button
					type="button"
					class="admin-flow-action"
					onclick={handleEnterUserland}
					disabled={actionFlow.userland.disabled}
				>
					{actionFlow.userland.label}
				</button>
			</div>
			{#if configError}
				<p class="runtime-error" role="alert">{configError}</p>
			{/if}
			{#if $runtimeState.error}
				<p class="runtime-error" role="alert">{$runtimeState.error}</p>
			{/if}
			{#if configNotice}
				<p class="runtime-pass">{configNotice}</p>
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

	.admin-flow-actions {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: fit-content;
		max-width: 100%;
		overflow-x: auto;
		padding-bottom: 0.1rem;
		justify-self: center;
	}

	.admin-flow-actions button {
		white-space: nowrap;
	}

	.admin-flow-action {
		border-color: var(--c-blue);
		color: var(--c-ice);
		background: color-mix(in srgb, var(--c-cyan) 18%, var(--c-bg));
		text-transform: uppercase;
		letter-spacing: 0.05em;
		min-width: 9rem;
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

	.admin-shell-tabs {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
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
