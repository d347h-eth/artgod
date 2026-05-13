<script lang="ts">
	import { TRADING_JOB_STATUS } from '@artgod/shared/types';
	import type { ApiBiddingPriceTier } from '$lib/api-types';
	import {
		formatCompactTime,
		oppositeCompactTimeTitle,
		parseCompactTimeMs,
		type CompactTimeDisplayMode
	} from '$lib/compact-time-display';

	let {
		tier,
		parentName = null,
		armedActionKey = null,
		canMoveUp = false,
		canMoveDown = false,
		busy = false,
		nowMs = Date.now(),
		onEdit,
		onMove,
		onStatusChange,
		onArchive
	}: {
		tier: ApiBiddingPriceTier;
		parentName?: string | null;
		armedActionKey?: string | null;
		canMoveUp?: boolean;
		canMoveDown?: boolean;
		busy?: boolean;
		nowMs?: number;
		onEdit: (tier: ApiBiddingPriceTier) => void;
		onMove: (tier: ApiBiddingPriceTier, direction: -1 | 1) => void | Promise<void>;
		onStatusChange: (
			tier: ApiBiddingPriceTier,
			status: typeof TRADING_JOB_STATUS.Enabled | typeof TRADING_JOB_STATUS.Paused
		) => void | Promise<void>;
		onArchive: (tier: ApiBiddingPriceTier) => void | Promise<void>;
	} = $props();

	const isEnabled = $derived(tier.status === TRADING_JOB_STATUS.Enabled);
	const isPaused = $derived(tier.status === TRADING_JOB_STATUS.Paused);
	const resolvedAtMs = $derived(parseCompactTimeMs(tier.resolvedAt));
	const pauseActionKey = $derived(`pause:${tier.tierId}`);
	const activateActionKey = $derived(`activate:${tier.tierId}`);
	const archiveActionKey = $derived(`archive:${tier.tierId}`);
	let resolvedAtMode = $state<CompactTimeDisplayMode>('relative');

	function valueLabel(value: string | null): string {
		return value ?? '-';
	}

	function toggleResolvedAtMode(): void {
		resolvedAtMode = resolvedAtMode === 'relative' ? 'absolute' : 'relative';
	}
</script>

<tr>
	<td class="mono">{tier.name}</td>
	<td class="mono tier-cell-center">{tier.status}</td>
	<td class="mono tier-cell-right">{valueLabel(tier.resolvedFloorEth)}</td>
	<td class="mono tier-cell-right">{valueLabel(tier.resolvedCeilingEth)}</td>
	<td class="mono tier-cell-center">{parentName ?? '-'}</td>
	<td class="mono tier-cell-center">{tier.sortOrder}</td>
	<td class="mono tier-cell-center">{tier.revision}</td>
	<td class="mono tier-cell-center">
		{#if resolvedAtMs === null}
			-
		{:else}
			<button
				type="button"
				class="activities-time-mode-button price-tier-time-value"
				aria-label="toggle resolved time mode"
				title={oppositeCompactTimeTitle(resolvedAtMs, resolvedAtMode, nowMs)}
				onclick={toggleResolvedAtMode}
			>
				{formatCompactTime(resolvedAtMs, resolvedAtMode, nowMs)}
			</button>
		{/if}
	</td>
	<td class="mono tier-cell-error">{tier.lastError ?? '-'}</td>
	<td>
		<div class="tier-row-actions">
			<button type="button" onclick={() => onEdit(tier)} disabled={busy}>edit</button>
			<button type="button" onclick={() => onMove(tier, -1)} disabled={busy || !canMoveUp}>up</button>
			<button type="button" onclick={() => onMove(tier, 1)} disabled={busy || !canMoveDown}>down</button>
			{#if isPaused}
				<button
					type="button"
					class="token-bidding-action-positive"
					class:token-bidding-action-armed={armedActionKey === activateActionKey}
					data-price-tier-action={activateActionKey}
					onclick={() => onStatusChange(tier, TRADING_JOB_STATUS.Enabled)}
					disabled={busy}
				>
					activate
				</button>
			{:else}
				<button
					type="button"
					class="token-bidding-action-negative"
					class:token-bidding-action-armed={armedActionKey === pauseActionKey}
					data-price-tier-action={pauseActionKey}
					onclick={() => onStatusChange(tier, TRADING_JOB_STATUS.Paused)}
					disabled={busy || !isEnabled}
				>
					pause
				</button>
			{/if}
			<button
				type="button"
				class="token-bidding-action-negative"
				class:token-bidding-action-armed={armedActionKey === archiveActionKey}
				data-price-tier-action={archiveActionKey}
				onclick={() => onArchive(tier)}
				disabled={busy || (!isEnabled && !isPaused)}
			>
				archive
			</button>
		</div>
	</td>
</tr>
