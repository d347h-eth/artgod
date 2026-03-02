<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { desktopRuntimeStore } from '$lib/runtime/desktop-runtime-store';
	import { parseBracketPrefixedLine } from '$lib/runtime/log-line-format';

	type FilterOption = string;
	type ConsoleTab = 'logs' | 'status';

	const runtimeState = desktopRuntimeStore.state;

	let open = $state(false);
	let activeTab = $state<ConsoleTab>('logs');
	let processFilter = $state<FilterOption>('desktop-supervisor');
	let logStreamElement = $state<HTMLDivElement | null>(null);
	let logAutoFollow = $state(true);
	let syncedLogProcess = $state<FilterOption>('desktop-supervisor');
	const LOG_FOLLOW_THRESHOLD_PX = 24;

	onMount(() => {
		void desktopRuntimeStore.init();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				if (open) {
					closeConsole();
					event.preventDefault();
				}
				return;
			}
			const isBacktick = event.key === '`' || (event.code === 'Backquote' && !event.shiftKey);
			if (!isBacktick) {
				return;
			}
			if (isTypingContext(event.target)) {
				return;
			}
			void toggleConsole();
			event.preventDefault();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			desktopRuntimeStore.dispose();
		};
	});

	async function toggleConsole() {
		if (open) {
			closeConsole();
			return;
		}
		open = true;
		activeTab = 'logs';
		logAutoFollow = true;
		await desktopRuntimeStore.openConsole(processFilter);
	}

	function closeConsole() {
		open = false;
		desktopRuntimeStore.closeConsole();
	}

	function setActiveTab(tab: ConsoleTab) {
		activeTab = tab;
		if (tab === 'logs') {
			logAutoFollow = true;
		}
	}

	const processOptions = $derived.by(() => {
		const names = new Set<string>();
		for (const entry of $runtimeState.logs) {
			names.add(entry.process);
		}
		for (const process of $runtimeState.status?.runningProcesses ?? []) {
			names.add(process);
		}
		names.add('desktop-supervisor');
		return Array.from(names).sort((a, b) => a.localeCompare(b));
	});

	$effect(() => {
		if (processOptions.length === 0) return;
		if (!processOptions.includes(processFilter)) {
			processFilter = processOptions[0];
		}
	});

	$effect(() => {
		void processFilter;
		if (!open || processFilter === syncedLogProcess) {
			return;
		}
		syncedLogProcess = processFilter;
		logAutoFollow = true;
		void desktopRuntimeStore.setLogProcess(processFilter);
	});

	const visibleLogs = $derived.by(() =>
		$runtimeState.logs.filter((entry) => entry.process === processFilter)
	);

	const parsedVisibleLogs = $derived.by(() =>
		visibleLogs.map((entry) => {
			const parsed = parseBracketPrefixedLine(entry.line);
			return {
				process: entry.process,
				tokens: parsed.tokens,
				message: parsed.message
			};
		})
	);

	$effect(() => {
		void visibleLogs.length;
		if (!open || !logAutoFollow) {
			return;
		}
		void tick().then(() => {
			if (!logStreamElement) {
				return;
			}
			logStreamElement.scrollTop = logStreamElement.scrollHeight;
		});
	});

	function handleLogScroll() {
		if (!logStreamElement) {
			return;
		}
		logAutoFollow = isNearLogBottom(logStreamElement);
	}

	function isNearLogBottom(element: HTMLDivElement): boolean {
		const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
		return distanceToBottom <= LOG_FOLLOW_THRESHOLD_PX;
	}

	function isTypingContext(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) {
			return false;
		}
		const tag = target.tagName.toLowerCase();
		if (tag === 'input' || tag === 'textarea' || tag === 'select') {
			return true;
		}
		return target.isContentEditable;
	}

	function runtimeTokenClass(token: string): string {
		const value = token.trim().toLowerCase();
		if (value === 'error' || value === 'fatal') {
			return 'runtime-fail';
		}
		if (value === 'warn' || value === 'warning') {
			return 'runtime-warn';
		}
		if (value === 'info' || value === 'debug' || value === 'trace') {
			return 'runtime-pass';
		}
		return 'runtime-log-token';
	}
</script>

{#if open}
	<aside class="runtime-drawer" aria-label="Desktop Runtime Operations">
		<header class="runtime-drawer-header">
			<h2>Desktop Runtime</h2>
			<p class="muted">press <span class="mono">`</span> or <span class="mono">esc</span> to close</p>
		</header>
		<nav class="runtime-tabs" aria-label="Runtime Console Tabs">
			<button
				type="button"
				class:runtime-tab-active={activeTab === 'logs'}
				onclick={() => setActiveTab('logs')}
			>
				logs
			</button>
			<button
				type="button"
				class:runtime-tab-active={activeTab === 'status'}
				onclick={() => setActiveTab('status')}
			>
				status
			</button>
		</nav>

		{#if activeTab === 'logs'}
			<div class="runtime-tab-panel runtime-tab-panel-logs" role="tabpanel" aria-label="Logs">
				<section class="runtime-section runtime-logs-section runtime-tab-section">
					<header class="runtime-logs-header">
						<h3>Logs</h3>
						<div class="runtime-controls">
							<label for="runtime-process-filter">process</label>
							<select
								id="runtime-process-filter"
								bind:value={processFilter}
							>
								{#each processOptions as option}
									<option value={option}>{option}</option>
								{/each}
							</select>
							<button type="button" onclick={() => desktopRuntimeStore.clearLogs()}>
								clear
							</button>
						</div>
					</header>
					<div class="runtime-log-stream" bind:this={logStreamElement} onscroll={handleLogScroll}>
						{#if parsedVisibleLogs.length === 0}
							<p class="muted">no logs</p>
						{:else}
							{#each parsedVisibleLogs as entry}
								<div class="runtime-log-line">
									<span class="mono runtime-log-process">[{entry.process}] </span>
									{#each entry.tokens as token}
										<span class={`mono ${runtimeTokenClass(token)}`}>[{token}] </span>
									{/each}
									<span class="runtime-log-message">{entry.message}</span>
								</div>
							{/each}
						{/if}
					</div>
				</section>
			</div>
		{:else}
			<div class="runtime-tab-panel runtime-tab-panel-status" role="tabpanel" aria-label="Status">
				<section class="runtime-section">
					<h3>Controls</h3>
					<div class="runtime-controls">
						<button
							type="button"
							onclick={() => void desktopRuntimeStore.start()}
							disabled={$runtimeState.busyAction !== null}
						>
							start
						</button>
						<button
							type="button"
							onclick={() => void desktopRuntimeStore.stop()}
							disabled={$runtimeState.busyAction !== null}
						>
							stop
						</button>
						<button
							type="button"
							onclick={() => void desktopRuntimeStore.restart()}
							disabled={$runtimeState.busyAction !== null}
						>
							restart
						</button>
						<button
							type="button"
							onclick={() => void desktopRuntimeStore.refreshPreflight()}
							disabled={$runtimeState.busyAction !== null}
						>
							preflight
						</button>
					</div>
					{#if $runtimeState.busyAction}
						<p class="muted">running action: {$runtimeState.busyAction}</p>
					{/if}
					{#if $runtimeState.error}
						<p class="runtime-error">{$runtimeState.error}</p>
					{/if}
				</section>

				<section class="runtime-section">
					<h3>Status</h3>
					{#if $runtimeState.status}
						<div class="runtime-kv-grid">
							<div>
								<span class="runtime-k">state</span>
								<span class="runtime-v">{$runtimeState.status.state}</span>
							</div>
							<div>
								<span class="runtime-k">restartCount</span>
								<span class="runtime-v">{$runtimeState.status.restartCount}</span>
							</div>
							<div>
								<span class="runtime-k">backend</span>
								<span class="runtime-v mono">{$runtimeState.status.backendHttpBaseUrl || 'n/a'}</span>
							</div>
							<div>
								<span class="runtime-k">nats</span>
								<span class="runtime-v mono">{$runtimeState.status.natsUrl || 'n/a'}</span>
							</div>
						</div>
						{#if $runtimeState.status.lastError}
							<p class="runtime-error mono">{$runtimeState.status.lastError}</p>
						{/if}
						{#if $runtimeState.status.runningProcesses.length > 0}
							<p class="runtime-k">running processes</p>
							<ul class="runtime-process-list">
								{#each $runtimeState.status.runningProcesses as process}
									<li class="mono">{process}</li>
								{/each}
							</ul>
						{/if}
					{:else}
						<p class="muted">status unavailable</p>
					{/if}
				</section>

				<section class="runtime-section">
					<h3>Paths</h3>
					<div class="runtime-kv-grid">
						<div>
							<span class="runtime-k">config</span>
							<span class="runtime-v mono">{$runtimeState.configPath ?? 'n/a'}</span>
						</div>
						<div>
							<span class="runtime-k">logs</span>
							<span class="runtime-v mono">{$runtimeState.logsPath ?? 'n/a'}</span>
						</div>
					</div>
					<div class="runtime-controls">
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
				</section>

				<section class="runtime-section runtime-preflight-section">
					<h3>Preflight</h3>
					{#if $runtimeState.preflight}
						<p class={$runtimeState.preflight.ok ? 'runtime-pass' : 'runtime-fail'}>
							{$runtimeState.preflight.ok ? 'all required checks passed' : 'preflight has failures'}
						</p>
						<div class="runtime-preflight-stream">
							<ul class="runtime-preflight-list">
								{#each $runtimeState.preflight.checks as check}
									<li>
										<span
											class={
												check.status === 'pass'
													? 'runtime-pass'
													: check.status === 'warn'
														? 'runtime-warn'
														: 'runtime-fail'
											}
										>
											[{check.status}]
										</span>
										<span class="mono">{check.key}</span>
										<span>{check.message}</span>
									</li>
								{/each}
							</ul>
						</div>
					{:else}
						<p class="muted">preflight unavailable</p>
					{/if}
				</section>
			</div>
		{/if}
	</aside>
{/if}
