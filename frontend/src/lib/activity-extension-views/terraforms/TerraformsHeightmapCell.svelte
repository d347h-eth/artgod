<script lang="ts">
	import { browser } from '$app/environment';
	import type { ActivityExtensionCellProps } from '$lib/activity-extension-views/types';
	import { TERRAFORMS_HEIGHTMAP_HASH_VISIBLE_CHARS } from '$lib/activity-extension-views/terraforms/constants';
	import HeightmapCopyIcon from '$lib/activity-extension-views/terraforms/HeightmapCopyIcon.svelte';

	let { activity, hrefs }: ActivityExtensionCellProps = $props();
	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');

	function contentHash(): string | null {
		const value = activity.payload?.contentHash;
		return typeof value === 'string' && value.trim() ? value : null;
	}

	function visibleHash(hash: string): string {
		const normalized = hash.startsWith('0x') ? hash.slice(2) : hash;
		return normalized.slice(0, TERRAFORMS_HEIGHTMAP_HASH_VISIBLE_CHARS);
	}

	function canvasRows(): string[] | null {
		const value = activity.payload?.canvasRows;
		if (!Array.isArray(value)) return null;
		const rows = value.map((row) => (typeof row === 'string' ? row : null));
		if (rows.some((row) => row === null)) return null;
		return rows as string[];
	}

	async function copyHeightmap(): Promise<void> {
		const rows = canvasRows();
		if (!browser || !rows?.length) return;
		try {
			await navigator.clipboard.writeText(rows.join('\n'));
			copyState = 'copied';
		} catch {
			copyState = 'failed';
		}
	}
</script>

{#if contentHash()}
	<span class="terraforms-heightmap-cell">
		<a
			class="terraforms-heightmap-hash"
			href={hrefs.filter({ contentHash: contentHash() })}
			title={contentHash() ?? undefined}
		>
			{visibleHash(contentHash() ?? '')}
		</a>
		{#if canvasRows()}
			<button
				class="terraforms-heightmap-copy-button"
				type="button"
				title={copyState === 'copied' ? 'copied heightmap' : 'copy heightmap'}
				aria-label={copyState === 'copied' ? 'copied heightmap' : 'copy heightmap'}
				onclick={copyHeightmap}
			>
				<HeightmapCopyIcon />
			</button>
		{/if}
	</span>
{:else}
	<span class="muted">-</span>
{/if}

<style>
	.terraforms-heightmap-cell {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.terraforms-heightmap-hash {
		font-variant-numeric: tabular-nums;
	}

	.terraforms-heightmap-copy-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--c-blue);
		cursor: pointer;
	}

	.terraforms-heightmap-copy-button:hover,
	.terraforms-heightmap-copy-button:focus-visible {
		color: var(--c-yellow);
	}
</style>
