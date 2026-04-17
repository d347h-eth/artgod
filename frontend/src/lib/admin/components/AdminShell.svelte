<script lang="ts">
	import AdminRuntimePanel from '$lib/admin/runtime/AdminRuntimePanel.svelte';
	import AdminBotsPanel from '$lib/admin/bots/AdminBotsPanel.svelte';
	import AdminWalletsPanel from '$lib/admin/wallets/AdminWalletsPanel.svelte';
	import { adminRuntimeStore } from '$lib/admin/runtime/store';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import type { AdminConsoleTab } from '$lib/runtime/lifecycle-ui-policy';

	type AdminShellTab = 'lifecycle' | 'wallets' | 'bots' | 'logs' | 'status';

	const runtimeState = adminRuntimeStore.state;
	let activeTab = $state<AdminShellTab>('lifecycle');

	const tabs: Array<{ id: AdminShellTab; label: string }> = [
		{ id: 'lifecycle', label: 'lifecycle' },
		{ id: 'wallets', label: 'wallets' },
		{ id: 'bots', label: 'bots' },
		{ id: 'logs', label: 'logs' },
		{ id: 'status', label: 'status' }
	];

	function resolveRuntimeTab(tab: AdminShellTab): AdminConsoleTab | null {
		if (tab === 'lifecycle' || tab === 'logs' || tab === 'status') {
			return tab;
		}
		return null;
	}

	const activeRuntimeTab = $derived(resolveRuntimeTab(activeTab));
	const userlandEntranceEnabled = $derived(
		$runtimeState.lifecycle.phase === 'ready' && $runtimeState.busyAction === null
	);

	function handleEnterUserland(): void {
		if (!userlandEntranceEnabled) {
			return;
		}
		void adminRuntimeStore.openUserlandUi();
	}
</script>

<svelte:head>
	<title>ArtGod Admin</title>
</svelte:head>

<main class="admin-shell">
	<div class="admin-shell-body">
		<header class="admin-shell-header">
			<h1>ArtGod</h1>
            <p class="admin-shell-eyebrow">{APP_VERSION}</p>
			<div class="runtime-primary-actions">
				<button
					type="button"
					class="runtime-primary-cta"
					onclick={handleEnterUserland}
					disabled={!userlandEntranceEnabled}
				>
					Enter the Userland
				</button>
			</div>
		</header>

		<nav class="runtime-tabs admin-shell-tabs" aria-label="Admin sections">
			{#each tabs as tab}
				<button
					type="button"
					class:runtime-tab-active={activeTab === tab.id}
					disabled={activeTab === tab.id}
					onclick={() => {
						activeTab = tab.id;
					}}
				>
					{tab.label}
				</button>
			{/each}
		</nav>

		<section class="admin-shell-surface">
			{#if activeRuntimeTab !== null}
				<AdminRuntimePanel tab={activeRuntimeTab} />
			{:else if activeTab === 'wallets'}
				<AdminWalletsPanel />
			{:else}
				<AdminBotsPanel />
			{/if}
		</section>
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

	.admin-shell-eyebrow {
		margin: 0 0 0.55rem;
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

	.admin-shell-tabs {
		flex-wrap: wrap;
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
