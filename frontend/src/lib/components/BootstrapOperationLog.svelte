<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { BOOTSTRAP_OUTPUT_STATUS, BOOTSTRAP_OUTPUT_STEP } from '@artgod/shared/bootstrap/operation-output';
	import type { BootstrapLog } from '$lib/bootstrap-output';
	import JsonPayloadPreview from './JsonPayloadPreview.svelte';
	let { log }: { log: BootstrapLog } = $props();
	let viewport: HTMLDivElement | undefined = $state();
	let following = $state(true);
	let copiedId = $state<number | null>(null);
	let copyError = $state(false);
	$effect(() => {
		void log.nextId;
		untrack(() => {
			if (following) void tick().then(() => {
				if (following && viewport) viewport.scrollTop = viewport.scrollHeight;
			});
		});
	});
	function onScroll() {
		if (viewport) following = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 32;
	}
	async function copyUrl(id: number, url: string) {
		try { await navigator.clipboard.writeText(url); copiedId = id; copyError = false; }
		catch { copyError = true; }
	}
</script>

<aside class="bootstrap-metadata-panel runtime-logs-section" aria-label="setup output">
	<header class="bootstrap-metadata-heading">
		<h2 class="panel-title">setup output</h2>
		{#if !following}
			<button type="button" class="action-button-positive" onclick={() => {
				following = true;
				if (viewport) viewport.scrollTop = viewport.scrollHeight;
			}}>latest</button>
		{/if}
	</header>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (the bounded log must support keyboard scrolling) -->
	<div class="runtime-log-stream bootstrap-output-scroll" bind:this={viewport} onscroll={onScroll}
		role="log" aria-label="bootstrap checks" aria-live="off" tabindex="0">
		{#if log.discarded}<p class="muted">{log.discarded} earlier entries removed.</p>{/if}
		{#if !log.entries.length}<p class="muted">Run a check to see its output.</p>{/if}
		{#each log.entries as entry (entry.id)}
			<div class="bootstrap-output-entry" class:bootstrap-output-failed={entry.status === BOOTSTRAP_OUTPUT_STATUS.Failed}
				class:bootstrap-output-retry={entry.status === BOOTSTRAP_OUTPUT_STATUS.Retrying}>
				<div class="bootstrap-output-line">
					<time class="muted" datetime={entry.timestamp} title={entry.timestamp}>{entry.timestamp.slice(11, 19)}</time>
					<span class="bootstrap-output-status">{entry.operation} · {entry.status}</span>
					<span class="bootstrap-output-message">{entry.message}</span>
				</div>
				{#if entry.url}
					<div class="bootstrap-output-resource">
						<code>{entry.url}</code>
						<button type="button" class="action-button-positive" aria-label={`copy url ${entry.url}`}
							onclick={() => void copyUrl(entry.id, entry.url!)}>{copiedId === entry.id ? 'copied' : 'copy url'}</button>
					</div>
				{/if}
				{#if entry.text !== undefined}
					<details class="bootstrap-output-document" open={entry.step === BOOTSTRAP_OUTPUT_STEP.Metadata}>
						<summary>{entry.step === BOOTSTRAP_OUTPUT_STEP.Metadata ? 'tokenURI response' : 'view value'}</summary>
						<JsonPayloadPreview text={entry.step === BOOTSTRAP_OUTPUT_STEP.Metadata ? entry.text : JSON.stringify(entry.text)}
							title={entry.step === BOOTSTRAP_OUTPUT_STEP.Metadata ? 'tokenURI response' : 'token URI value'} />
					</details>
				{/if}
			</div>
		{/each}
	</div>
	{#if copyError}<p class="bootstrap-check-warning">Copy failed. Select the URL and copy it manually.</p>{/if}
</aside>
