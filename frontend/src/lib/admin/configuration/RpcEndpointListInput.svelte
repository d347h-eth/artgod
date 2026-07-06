<script lang="ts">
	import {
		DEFAULT_RPC_ENDPOINT_WEIGHT,
		parseRpcEndpointConfigList,
		parseRpcWebSocketEndpointConfigList
	} from '@artgod/shared/config/rpc-endpoints';
	import type { AdminConfigValidationRule } from '$lib/admin/configuration/ports';

	type RpcEndpointDraft = {
		url: string;
		weight: string;
	};

	let {
		value,
		disabled,
		invalid = false,
		validation = 'rpc_endpoint_list',
		endpointLabel = 'RPC endpoint',
		currentBenchmarkSummary = null,
		onBenchmarkCurrentEndpoints,
		onChange
	}: {
		value: string;
		disabled: boolean;
		invalid?: boolean;
		validation?: AdminConfigValidationRule | null;
		endpointLabel?: string;
		currentBenchmarkSummary?: string | null;
		onBenchmarkCurrentEndpoints?: () => Promise<void>;
		onChange: (value: string) => void;
	} = $props();

	const currentBenchmarkEnabled = $derived(onBenchmarkCurrentEndpoints !== undefined);

	let appliedValue = $state<string | null>(null);
	let drafts = $state<RpcEndpointDraft[]>([emptyDraft()]);

	$effect(() => {
		if (value === appliedValue) {
			return;
		}
		appliedValue = value;
		drafts = parseDrafts(value);
	});

	function updateUrl(index: number, url: string): void {
		const next = drafts.map((draft, draftIndex) =>
			draftIndex === index ? { ...draft, url } : draft
		);
		emitDrafts(next);
	}

	function updateWeight(index: number, weight: string): void {
		const next = drafts.map((draft, draftIndex) =>
			draftIndex === index ? { ...draft, weight } : draft
		);
		emitDrafts(next);
	}

	function addEndpoint(): void {
		emitDrafts([...drafts, emptyDraft()]);
	}

	function removeEndpoint(index: number): void {
		emitDrafts(drafts.filter((_, draftIndex) => draftIndex !== index));
	}

	function emitDrafts(next: RpcEndpointDraft[]): void {
		const normalized = next.length > 0 ? next : [emptyDraft()];
		drafts = normalized;
		const encoded = encodeDrafts(normalized);
		appliedValue = encoded;
		onChange(encoded);
	}

	function parseDrafts(raw: string): RpcEndpointDraft[] {
		if (raw.trim().length === 0) {
			return [emptyDraft()];
		}
		try {
			return parseEndpointList(raw).map((endpoint) => ({
				url: endpoint.url,
				weight: String(endpoint.weight)
			}));
		} catch {
			return [
				{
					url: raw,
					weight: String(DEFAULT_RPC_ENDPOINT_WEIGHT)
				}
			];
		}
	}

	function encodeDrafts(next: RpcEndpointDraft[]): string {
		const entries = next
			.map((draft) => ({
				url: draft.url.trim(),
				weight:
					draft.weight.trim().length === 0
						? DEFAULT_RPC_ENDPOINT_WEIGHT
						: Number(draft.weight)
			}))
			.filter((entry) => entry.url.length > 0);
		return entries.length === 0 ? '' : JSON.stringify(entries);
	}

	function emptyDraft(): RpcEndpointDraft {
		return {
			url: '',
			weight: String(DEFAULT_RPC_ENDPOINT_WEIGHT)
		};
	}

	function parseEndpointList(raw: string): { url: string; weight: number }[] {
		return validation === 'websocket_endpoint_list'
			? parseRpcWebSocketEndpointConfigList(raw)
			: parseRpcEndpointConfigList(raw);
	}

	async function benchmarkCurrentEndpoints(): Promise<void> {
		if (disabled || !onBenchmarkCurrentEndpoints) {
			return;
		}
		await onBenchmarkCurrentEndpoints();
	}
</script>

<div class="rpc-endpoint-list">
	{#each drafts as draft, index (index)}
		<div class="rpc-endpoint-item">
			<input
				class="bootstrap-control admin-config-control rpc-endpoint-url"
				class:admin-config-control-warning={invalid}
				value={draft.url}
				disabled={disabled}
				aria-label={`${endpointLabel} ${index + 1} URL`}
				aria-invalid={invalid}
				oninput={(event) => {
					updateUrl(index, (event.currentTarget as HTMLInputElement).value);
				}}
			/>
			<input
				class="bootstrap-control rpc-endpoint-weight"
				class:admin-config-control-warning={invalid}
				type="number"
				min="1"
				step="1"
				value={draft.weight}
				disabled={disabled}
				aria-label={`${endpointLabel} ${index + 1} weight`}
				aria-invalid={invalid}
				oninput={(event) => {
					updateWeight(index, (event.currentTarget as HTMLInputElement).value);
				}}
			/>
			<div class="rpc-endpoint-actions">
				<button type="button" disabled={disabled} title="add endpoint" onclick={addEndpoint}>+</button>
				<button
					type="button"
					disabled={disabled || drafts.length === 1}
					title="remove endpoint"
					onclick={() => {
						removeEndpoint(index);
					}}
				>
					-
				</button>
			</div>
		</div>
	{/each}
	{#if currentBenchmarkEnabled}
		<div class="rpc-endpoint-current-actions">
			<button
				type="button"
				disabled={disabled || invalid}
				onclick={() => void benchmarkCurrentEndpoints()}
			>
				benchmark current endpoints
			</button>
		</div>
		{#if currentBenchmarkSummary}
			<p class="rpc-endpoint-benchmark-summary">{currentBenchmarkSummary}</p>
		{/if}
		<div class="rpc-endpoint-benchmark-separator" aria-hidden="true"></div>
	{/if}
</div>

<style>
	.rpc-endpoint-list {
		display: grid;
		gap: 0.45rem;
		width: min(25.85rem, 100%);
	}

	.rpc-endpoint-item {
		display: grid;
		grid-template-columns: minmax(12rem, 1fr) 4.6rem max-content;
		align-items: center;
		gap: 0.45rem;
	}

	.rpc-endpoint-url {
		width: 100%;
	}

	.rpc-endpoint-weight {
		width: 4.6rem;
	}

	.rpc-endpoint-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.rpc-endpoint-actions button {
		min-width: 2rem;
	}

	.rpc-endpoint-current-actions {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: 0.45rem;
		flex-wrap: wrap;
	}

	.rpc-endpoint-current-actions button {
		min-width: 8.75rem;
	}

	.rpc-endpoint-benchmark-summary {
		margin: 0;
		font-size: 0.78rem;
		color: var(--c-sand);
		line-height: 1.35;
	}

	.rpc-endpoint-benchmark-separator {
		border-top: 1px solid color-mix(in srgb, var(--c-blue) 70%, transparent);
	}

	@media (max-width: 640px) {
		.rpc-endpoint-item {
			grid-template-columns: minmax(0, 1fr) 4.6rem;
		}

		.rpc-endpoint-actions {
			grid-column: 1 / -1;
		}
	}
</style>
