<script lang="ts">
	import { onMount } from 'svelte';
	import { desktopRuntimeStore } from '$lib/runtime/desktop-runtime-store';

	type RuntimeStoreSnapshot = {
		available: boolean;
		initialized: boolean;
		busyAction: string | null;
		status: {
			state: string;
			restartCount: number;
			lastError: string | null;
		} | null;
		error: string | null;
	};

	type LifecyclePhase = 'ready' | 'booting' | 'stopping' | 'fatal';

	const runtimeState = desktopRuntimeStore.state;
	let reachedRunningState = $state(false);

	onMount(() => {
		void desktopRuntimeStore.init();
	});

	$effect(() => {
		if ($runtimeState.status?.state === 'running') {
			reachedRunningState = true;
		}
	});

	const lifecyclePhase = $derived.by(() =>
		resolveLifecyclePhase($runtimeState as RuntimeStoreSnapshot, reachedRunningState)
	);

	const startupMessage = $derived.by(() => {
		const status = $runtimeState.status;
		if (!status) {
			return 'Initializing desktop runtime...';
		}
		if (status.state === 'restarting') {
			const restartLabel = status.restartCount > 0 ? ` (attempt ${status.restartCount})` : '';
			const reason = status.lastError?.trim() ? ` Last error: ${status.lastError}` : '';
			return `Runtime is restarting${restartLabel}.${reason}`;
		}
		return 'Starting local backend and indexer runtimes...';
	});

	const fatalMessage = $derived.by(() =>
		$runtimeState.status?.lastError?.trim() ||
			$runtimeState.error?.trim() ||
			'Desktop runtime startup failed.'
	);

	function resolveLifecyclePhase(
		snapshot: RuntimeStoreSnapshot,
		reachedRuntimeReady: boolean
	): LifecyclePhase {
		if (!snapshot.initialized) {
			return 'booting';
		}
		if (!snapshot.available) {
			return 'ready';
		}

		const status = snapshot.status;
		if (!status && snapshot.error?.trim()) {
			return 'fatal';
		}
		if (!status) {
			return 'booting';
		}

		if (status.state === 'running') {
			return 'ready';
		}
		if (status.state === 'stopping') {
			return 'stopping';
		}
		if (status.state === 'stopped' && status.lastError?.trim()) {
			return 'fatal';
		}
		if (status.state === 'starting' || status.state === 'restarting') {
			return 'booting';
		}
		if (status.state === 'stopped' && !reachedRuntimeReady) {
			return 'booting';
		}
		return 'ready';
	}
</script>

{#if lifecyclePhase !== 'ready'}
	<div class="desktop-lifecycle-overlay" role="status" aria-live="polite">
		<div class="desktop-lifecycle-panel">
			{#if lifecyclePhase === 'booting'}
				<h2>Starting Runtime</h2>
				<p>{startupMessage}</p>
			{:else if lifecyclePhase === 'stopping'}
				<h2>Stopping Runtime</h2>
				<p>Shutting down local services before exit...</p>
			{:else}
				<h2>Runtime Failed</h2>
				<p>{fatalMessage}</p>
				<div class="desktop-lifecycle-actions">
					<button
						type="button"
						onclick={() => void desktopRuntimeStore.start()}
						disabled={$runtimeState.busyAction !== null}
					>
						retry start
					</button>
					<button
						type="button"
						onclick={() => void desktopRuntimeStore.openConfigPath()}
						disabled={$runtimeState.busyAction !== null}
					>
						open config
					</button>
					<button
						type="button"
						onclick={() => void desktopRuntimeStore.openLogsPath()}
						disabled={$runtimeState.busyAction !== null}
					>
						open logs
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
