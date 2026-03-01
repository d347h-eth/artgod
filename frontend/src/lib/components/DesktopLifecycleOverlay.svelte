<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount, tick } from 'svelte';
	import { desktopRuntimeStore } from '$lib/runtime/desktop-runtime-store';
	import type { LifecycleEventLevel } from '$lib/runtime/desktop-runtime-store';

	const runtimeState = desktopRuntimeStore.state;
	const IS_DESKTOP_BUILD_TARGET =
		((import.meta.env.VITE_FRONTEND_BUILD_TARGET as string | undefined)?.trim() || '') === 'desktop';
	// Interval for polling whether the Tauri bridge (`window.__TAURI_INTERNALS__`) became available.
	const DESKTOP_BRIDGE_DETECT_POLL_MS = 100;
	// Max time to keep polling for Tauri bridge detection before stopping background detection checks.
	const DESKTOP_BRIDGE_DETECT_TIMEOUT_MS = 2_500;
	const LOG_FOLLOW_THRESHOLD_PX = 24;

	let nowMs = $state(Date.now());
	let timer: ReturnType<typeof setInterval> | null = null;
	let detectTimer: ReturnType<typeof setInterval> | null = null;
	let detectTimeout: ReturnType<typeof setTimeout> | null = null;
	let desktopShellDetected = $state(IS_DESKTOP_BUILD_TARGET || detectDesktopShellRuntime());
	let logStreamElement = $state<HTMLDivElement | null>(null);
	let logAutoFollow = $state(true);

	onMount(() => {
		void desktopRuntimeStore.init();
		timer = setInterval(() => {
			nowMs = Date.now();
		}, 1_000);

		if (!desktopShellDetected && browser) {
			detectTimer = setInterval(() => {
				if (detectDesktopShellRuntime()) {
					desktopShellDetected = true;
					if (detectTimer) {
						clearInterval(detectTimer);
						detectTimer = null;
					}
					if (detectTimeout) {
						clearTimeout(detectTimeout);
						detectTimeout = null;
					}
				}
			}, DESKTOP_BRIDGE_DETECT_POLL_MS);
			detectTimeout = setTimeout(() => {
				if (detectTimer) {
					clearInterval(detectTimer);
					detectTimer = null;
				}
			}, DESKTOP_BRIDGE_DETECT_TIMEOUT_MS);
		}

		return () => {
			if (timer) {
				clearInterval(timer);
			}
			if (detectTimer) {
				clearInterval(detectTimer);
			}
			if (detectTimeout) {
				clearTimeout(detectTimeout);
			}
		};
	});

	const lifecycle = $derived($runtimeState.lifecycle);
	const events = $derived(lifecycle.events);
	const isVisible = $derived((IS_DESKTOP_BUILD_TARGET || desktopShellDetected) && lifecycle.phase !== 'ready');

	const headerTitle = $derived.by(() => {
		switch (lifecycle.phase) {
			case 'booting':
				return 'Starting Runtime';
			case 'stopping':
				return 'Stopping Runtime';
			case 'fatal':
				return 'Runtime Failed';
			default:
				return 'Runtime Ready';
		}
	});

	const elapsedText = $derived.by(() => formatElapsed(nowMs - lifecycle.startedAtMs));

	$effect(() => {
		void events.length;
		if (!isVisible || !logAutoFollow) {
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

	function detectDesktopShellRuntime(): boolean {
		if (!browser) {
			return false;
		}
		const maybeWindow = window as Window & {
			__TAURI_INTERNALS__?: unknown;
		};
		if (maybeWindow.__TAURI_INTERNALS__) {
			return true;
		}
		const protocol = window.location.protocol.toLowerCase();
		if (protocol === 'tauri:' || protocol === 'asset:') {
			return true;
		}
		const host = window.location.hostname.toLowerCase();
		if (host === 'tauri.localhost' || host.endsWith('.tauri.localhost')) {
			return true;
		}
		return /\btauri\b/i.test(navigator.userAgent);
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

{#if isVisible}
	<div class="desktop-lifecycle-overlay" role="status" aria-live="polite">
		<section class="desktop-lifecycle-terminal">
			<header class="desktop-lifecycle-topbar">
				<div class="desktop-lifecycle-title-row">
					<h2>{headerTitle}</h2>
					<p class="desktop-lifecycle-elapsed mono">elapsed {elapsedText}</p>
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

			<div class="desktop-lifecycle-log-stream" bind:this={logStreamElement} onscroll={handleLogScroll}>
					{#if events.length === 0}
						<div class="desktop-lifecycle-event-row">
							<span class="desktop-lifecycle-event-time mono">{formatTime(new Date().toISOString())} </span>
							<span class="runtime-pass">[info] </span>
							<span class="desktop-lifecycle-event-code mono">[boot.waiting] </span>
							<span class="desktop-lifecycle-event-message">Waiting for first lifecycle event...</span>
						</div>
				{:else}
					{#each events as event (event.id)}
						<div class="desktop-lifecycle-event-row">
							<span class="desktop-lifecycle-event-time mono">{formatTime(event.atIso)} </span>
							<span class={lifecycleLevelClass(event.level)}>[{event.level}] </span>
							<span class="desktop-lifecycle-event-code mono">[{event.code}] </span>
							<span class="desktop-lifecycle-event-message">{event.message}</span>
						</div>
					{/each}
				{/if}
			</div>
		</section>
	</div>
{/if}
