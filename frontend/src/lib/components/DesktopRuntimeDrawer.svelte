<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { desktopRuntimeStore } from '$lib/runtime/desktop-runtime-store';
	import type { LifecycleEventLevel } from '$lib/runtime/desktop-runtime-store';
	import { parseBracketPrefixedLine, createTokenizedLogLine } from '$lib/runtime/log-line-format';
	import {
		resolveStartupSurfacePolicy,
		type AdminConsoleTab
	} from '$lib/runtime/lifecycle-ui-policy';

	type FilterOption = string;
	type ConsoleTab = AdminConsoleTab;
	let { embedded = false }: { embedded?: boolean } = $props();

	const runtimeState = desktopRuntimeStore.state;

	let open = $state(embedded);
	let activeTab = $state<ConsoleTab>(embedded ? 'lifecycle' : 'logs');
	let lastUserTab = $state<ConsoleTab>(embedded ? 'lifecycle' : 'logs');
	let processFilter = $state<FilterOption>('desktop-supervisor');
	let logStreamElement = $state<HTMLDivElement | null>(null);
	let lifecycleLogStreamElement = $state<HTMLDivElement | null>(null);
	let logAutoFollow = $state(true);
	let lifecycleLogAutoFollow = $state(true);
	let startupAutoOpened = $state(false);
	let syncedLogProcess = $state<FilterOption>('desktop-supervisor');
	let nowMs = $state(Date.now());

	const LOG_FOLLOW_THRESHOLD_PX = 24;
	let timer: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		void desktopRuntimeStore.init();
		timer = setInterval(() => {
			nowMs = Date.now();
		}, 1_000);

		if (embedded) {
			void desktopRuntimeStore.openConsole(processFilter);
			return () => {
				if (timer) {
					clearInterval(timer);
				}
				desktopRuntimeStore.dispose();
			};
		}

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
			if (timer) {
				clearInterval(timer);
			}
			desktopRuntimeStore.dispose();
		};
	});

	const lifecycle = $derived($runtimeState.lifecycle);
	const startupSurfacePolicy = $derived(resolveStartupSurfacePolicy(lifecycle.phase));
	const lifecycleEvents = $derived(lifecycle.events);
	const tokenizedLifecycleEvents = $derived.by(() =>
		lifecycleEvents.map((event) =>
			createTokenizedLogLine([formatTime(event.atIso), event.level, event.code], event.message)
		)
	);
	const lifecycleHeaderTitle = $derived.by(() => {
		switch (lifecycle.phase) {
			case 'booting':
				return 'Starting Runtime';
			case 'stopping':
				return 'Stopping Runtime';
			case 'fatal':
				return 'Runtime Failed';
			default:
				return 'Runtime Lifecycle';
		}
	});
	const lifecycleElapsedText = $derived.by(() => formatElapsed(nowMs - lifecycle.startedAtMs));

	$effect(() => {
		if (embedded) {
			return;
		}
		const policy = startupSurfacePolicy;
		if (!policy.forceOpen || !policy.preferredTab || open) {
			return;
		}
		startupAutoOpened = true;
		void openConsoleForTab(policy.preferredTab, false);
	});

	$effect(() => {
		if (embedded) {
			return;
		}
		if (startupSurfacePolicy.forceOpen || !open || !startupAutoOpened) {
			return;
		}
		closeConsole();
		startupAutoOpened = false;
	});

	async function toggleConsole() {
		if (embedded) {
			return;
		}
		if (open) {
			closeConsole();
			startupAutoOpened = false;
			return;
		}

		const policy = startupSurfacePolicy;
		if (policy.forceOpen && policy.preferredTab) {
			await openConsoleForTab(policy.preferredTab, false);
			return;
		}
		await openConsoleForTab(lastUserTab, false);
	}

	async function openConsoleForTab(tab: ConsoleTab, rememberSelection: boolean) {
		open = true;
		setActiveTab(tab, rememberSelection);
		await desktopRuntimeStore.openConsole(processFilter);
	}

	function closeConsole() {
		if (embedded) {
			return;
		}
		open = false;
		desktopRuntimeStore.closeConsole();
	}

	function setActiveTab(tab: ConsoleTab, rememberSelection = true) {
		activeTab = tab;
		if (rememberSelection) {
			lastUserTab = tab;
		}
		if (tab === 'logs') {
			logAutoFollow = true;
		}
		if (tab === 'lifecycle') {
			lifecycleLogAutoFollow = true;
		}
	}

	const processOptions = $derived.by(() => {
		const names = new Set<string>();
		for (const process of $runtimeState.logProcesses) {
			names.add(process);
		}
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
		if (!open || activeTab !== 'logs' || !logAutoFollow) {
			return;
		}
		void tick().then(() => {
			if (!logStreamElement) {
				return;
			}
			logStreamElement.scrollTop = logStreamElement.scrollHeight;
		});
	});

	$effect(() => {
		void lifecycleEvents.length;
		if (!open || activeTab !== 'lifecycle' || !lifecycleLogAutoFollow) {
			return;
		}
		void tick().then(() => {
			if (!lifecycleLogStreamElement) {
				return;
			}
			lifecycleLogStreamElement.scrollTop = lifecycleLogStreamElement.scrollHeight;
		});
	});

	function handleLogScroll() {
		if (!logStreamElement) {
			return;
		}
		logAutoFollow = isNearLogBottom(logStreamElement);
	}

	function handleLifecycleLogScroll() {
		if (!lifecycleLogStreamElement) {
			return;
		}
		lifecycleLogAutoFollow = isNearLogBottom(lifecycleLogStreamElement);
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

	function formatElapsed(diffMs: number): string {
		const safeMs = Math.max(0, Number.isFinite(diffMs) ? diffMs : 0);
		const totalSeconds = Math.floor(safeMs / 1000);
		const minutes = Math.floor(totalSeconds / 60)
			.toString()
			.padStart(2, '0');
		const seconds = (totalSeconds % 60).toString().padStart(2, '0');
		return `${minutes}:${seconds}`;
	}

	function formatTime(iso: string): string {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) {
			return '--:--:--';
		}
		const hours = date.getHours().toString().padStart(2, '0');
		const minutes = date.getMinutes().toString().padStart(2, '0');
		const seconds = date.getSeconds().toString().padStart(2, '0');
		return `${hours}:${minutes}:${seconds}`;
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

	function lifecycleLevelClass(level: LifecycleEventLevel): string {
		if (level === 'error') {
			return 'runtime-fail';
		}
		if (level === 'warn') {
			return 'runtime-warn';
		}
		return 'runtime-pass';
	}
</script>

{#if open}
	<aside class={`runtime-drawer ${embedded ? 'runtime-drawer-embedded' : ''}`} aria-label="Desktop Runtime Operations">
		<header class="runtime-drawer-header">
			<h2>Desktop Runtime</h2>
			{#if !embedded}
				<p class="muted">press <span class="mono">`</span> or <span class="mono">esc</span> to close</p>
			{/if}
		</header>
		{#if embedded}
			<div class="runtime-primary-actions">
				<button
					type="button"
					class="runtime-primary-cta"
					onclick={() => void desktopRuntimeStore.openUserlandUi()}
					disabled={$runtimeState.busyAction !== null}
				>
					open ArtGod in browser
				</button>
			</div>
		{/if}
		<nav class="runtime-tabs" aria-label="Runtime Console Tabs">
			<button
				type="button"
				class:runtime-tab-active={activeTab === 'lifecycle'}
				onclick={() => setActiveTab('lifecycle')}
			>
				lifecycle
			</button>
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

		{#if activeTab === 'lifecycle'}
			<div class="runtime-tab-panel runtime-tab-panel-lifecycle" role="tabpanel" aria-label="Lifecycle">
				<section class="desktop-lifecycle-terminal runtime-tab-section">
					<header class="desktop-lifecycle-topbar">
						<div class="desktop-lifecycle-title-row">
							<h2>{lifecycleHeaderTitle}</h2>
							<p class="desktop-lifecycle-elapsed mono">elapsed {lifecycleElapsedText}</p>
						</div>
						<p class="desktop-lifecycle-current-action">{lifecycle.currentAction}</p>
						{#if lifecycle.phase === 'fatal'}
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
					</header>

					<div
						class="desktop-lifecycle-log-stream"
						bind:this={lifecycleLogStreamElement}
						onscroll={handleLifecycleLogScroll}
					>
						{#if tokenizedLifecycleEvents.length === 0}
							<div class="desktop-lifecycle-event-row">
								<span class="desktop-lifecycle-event-time mono">{formatTime(new Date().toISOString())} </span>
								<span class="runtime-pass">[info] </span>
								<span class="desktop-lifecycle-event-code mono">[boot.waiting] </span>
								<span class="desktop-lifecycle-event-message">Waiting for first lifecycle event...</span>
							</div>
						{:else}
							{#each tokenizedLifecycleEvents as event, index (lifecycleEvents[index].id)}
								<div class="desktop-lifecycle-event-row">
									<span class="desktop-lifecycle-event-time mono">{event.tokens[0]} </span>
									<span class={lifecycleLevelClass(event.tokens[1] as LifecycleEventLevel)}>[{event.tokens[1]}] </span>
									<span class="desktop-lifecycle-event-code mono">[{event.tokens[2]}] </span>
									<span class="desktop-lifecycle-event-message">{event.message}</span>
								</div>
							{/each}
						{/if}
					</div>
				</section>
			</div>
		{:else if activeTab === 'logs'}
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
