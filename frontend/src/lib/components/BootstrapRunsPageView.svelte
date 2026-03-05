<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import type { ApiChain, BootstrapRunsApiResponse } from '$lib/api-types';
	import { createBootstrapRun } from '$lib/backend-api';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import { APP_VERSION } from '$lib/runtime/app-version';

	let {
		chain,
		page,
		status,
		basePath
	}: {
		chain: ApiChain | null;
		page: BootstrapRunsApiResponse['page'];
		status: string;
		basePath: string;
	} = $props();

	const statusOptions = ['', 'requested', 'queued', 'metadata', 'ownership', 'backfill', 'completed', 'failed'];
	const bootstrapInputClass =
		'min-h-8 rounded-none border border-[var(--c-blue)] bg-[var(--c-bg)] px-2 py-1 text-[0.8rem] text-[var(--c-ice)] placeholder:text-[var(--c-sand)] focus:border-[var(--c-yellow)] focus:outline-none';
	const bootstrapSelectClass = `${bootstrapInputClass} pr-6`;
	const bootstrapTextareaClass = `${bootstrapInputClass} min-h-20 resize-y`;
	const bootstrapCheckboxClass =
		'h-4 w-4 rounded-none border-[var(--c-blue)] bg-[var(--c-bg)] text-[var(--c-cyan)] focus:ring-0 focus:outline-none';

	let formOpen = $state(false);
	let bootstrapSlug = $state('');
	let bootstrapAddress = $state('');
	let metadataMode = $state<'best_effort' | 'strict'>('best_effort');
	let supportsEnumerable = $state(true);
	let manualMode = $state<'manual_token_ids' | 'manual_range'>('manual_token_ids');
	let manualTokenIds = $state('');
	let manualRangeStartTokenId = $state('');
	let manualRangeTotalSupply = $state('');
	let deploymentBlock = $state('');
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let submitSuccess = $state<string | null>(null);

	function normalizeFieldValue(value: unknown): string {
		if (typeof value === 'string') return value.trim();
		if (typeof value === 'number' && Number.isFinite(value)) {
			return String(value).trim();
		}
		return '';
	}

	function runHref(runId: number): string {
		if (!chain) return '#';
		return `/${chain.slug}/bootstrap-runs/${runId}`;
	}

	function collectionHref(item: BootstrapRunsApiResponse['page']['items'][number]): string {
		if (!chain) return '#';
		return `/${chain.slug}/${item.collection.slug ?? item.collection.address}`;
	}

	function loadMoreHref(): string {
		if (!page.nextCursor) return '#';
		const query = new URLSearchParams();
		if (status) query.set('status', status);
		query.set('limit', String(page.limit));
		query.set('cursor', page.nextCursor);
		const suffix = query.toString();
		return suffix ? `${basePath}?${suffix}` : basePath;
	}

	function applyStatusFilter(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return;
		const query = new URLSearchParams();
		const nextStatus = target.value.trim();
		if (nextStatus) query.set('status', nextStatus);
		query.set('limit', String(page.limit));
		const suffix = query.toString();
		void goto(suffix ? `${basePath}?${suffix}` : basePath);
	}

	async function onSubmitBootstrap(event: Event): Promise<void> {
		event.preventDefault();
		submitError = null;
		submitSuccess = null;
		if (!chain) {
			submitError = 'chain is not ready';
			return;
		}

		const slug = normalizeFieldValue(bootstrapSlug).toLowerCase();
		const address = normalizeFieldValue(bootstrapAddress).toLowerCase();
		if (!slug || !address) {
			submitError = 'slug and address are required';
			return;
		}

		let manualInput:
			| {
					mode: 'manual_token_ids';
					tokenIds: string[];
			  }
			| {
					mode: 'manual_range';
					startTokenId: string;
					totalSupply: number;
			  }
			| undefined;

		if (!supportsEnumerable) {
			if (manualMode === 'manual_token_ids') {
				const tokenIds = manualTokenIds
					.split(/[\s,]+/)
					.map((value) => value.trim())
					.filter(Boolean);
				if (tokenIds.length === 0) {
					submitError = 'token ids are required';
					return;
				}
				manualInput = {
					mode: 'manual_token_ids',
					tokenIds
				};
			} else {
				const startTokenId = normalizeFieldValue(manualRangeStartTokenId);
				const totalSupply = Number(manualRangeTotalSupply);
				if (!startTokenId) {
					submitError = 'start token id is required';
					return;
				}
				if (!Number.isInteger(totalSupply) || totalSupply <= 0) {
					submitError = 'total supply must be a positive integer';
					return;
				}
				manualInput = {
					mode: 'manual_range',
					startTokenId,
					totalSupply
				};
			}
		}

		const deploymentBlockValue = normalizeFieldValue(deploymentBlock);
		const parsedDeploymentBlock = deploymentBlockValue ? Number(deploymentBlockValue) : undefined;
		if (
			parsedDeploymentBlock !== undefined &&
			(!Number.isInteger(parsedDeploymentBlock) || parsedDeploymentBlock <= 0)
		) {
			submitError = 'deployment block must be a positive integer';
			return;
		}

		submitting = true;
		try {
			const result = await createBootstrapRun(fetch, chain.slug, {
				slug,
				address,
				standard: 'erc721',
				metadataMode,
				supportsEnumerable,
				manualInput,
				deploymentBlock: parsedDeploymentBlock
			});
			submitSuccess = `bootstrap queued (run ${result.runId})`;
			formOpen = false;
			await invalidateAll();
		} catch (error) {
			submitError = error instanceof Error ? error.message : 'bootstrap request failed';
		} finally {
			submitting = false;
		}
	}
</script>

<section class="panel">
	<header class="panel-header">
		<h1 class="app-title">ArtGod {APP_VERSION}</h1>
	</header>

	<ListPagesTabs chainSlug={chain?.slug ?? null} active="bootstrapping" />

	<header class="panel-header">
		<div>
			<p class="panel-subtitle">
				{#if chain}
					{chain.name} ({chain.slug} / {chain.publicChainId})
				{:else}
					Loading chain...
				{/if}
			</p>
		</div>
		<div class="status-form">
			<label for="bootstrap-run-status">status</label>
			<select id="bootstrap-run-status" name="status" onchange={applyStatusFilter}>
				{#each statusOptions as option}
					<option value={option} selected={option === status}>{option || 'all'}</option>
				{/each}
			</select>
		</div>
	</header>

	<div class="panel-header">
		<button type="button" onclick={() => (formOpen = !formOpen)}>
			{formOpen ? 'hide bootstrap form' : 'bootstrap collection'}
		</button>
		{#if submitSuccess}
			<span class="muted">{submitSuccess}</span>
		{/if}
		{#if submitError}
			<span class="muted">{submitError}</span>
		{/if}
	</div>

	{#if formOpen}
		<form class="status-form bootstrap-form" onsubmit={onSubmitBootstrap}>
			<label>
				slug
				<input bind:value={bootstrapSlug} class={bootstrapInputClass} type="text" name="slug" required />
			</label>
			<label>
				address
				<input
					bind:value={bootstrapAddress}
					class={bootstrapInputClass}
					type="text"
					name="address"
					required
				/>
			</label>
			<label>
				metadata mode
				<select bind:value={metadataMode} class={bootstrapSelectClass}>
					<option value="best_effort">best effort</option>
					<option value="strict">strict</option>
				</select>
			</label>
			<label>
				deployment block
				<input bind:value={deploymentBlock} class={bootstrapInputClass} type="number" min="1" />
			</label>
			<label>
				supports enumerable
				<input bind:checked={supportsEnumerable} class={bootstrapCheckboxClass} type="checkbox" />
			</label>
			{#if !supportsEnumerable}
				<label>
					manual mode
					<select bind:value={manualMode} class={bootstrapSelectClass}>
						<option value="manual_token_ids">token ids list</option>
						<option value="manual_range">start + total supply</option>
					</select>
				</label>
				{#if manualMode === 'manual_token_ids'}
					<label>
						token ids (comma/space separated)
						<textarea bind:value={manualTokenIds} class={bootstrapTextareaClass} rows="3"></textarea>
					</label>
				{:else}
					<label>
						start token id
						<input bind:value={manualRangeStartTokenId} class={bootstrapInputClass} type="text" />
					</label>
					<label>
						total supply
						<input
							bind:value={manualRangeTotalSupply}
							class={bootstrapInputClass}
							type="number"
							min="1"
						/>
					</label>
				{/if}
			{/if}
			<button type="submit" disabled={submitting}>
				{submitting ? 'submitting...' : 'queue bootstrap'}
			</button>
		</form>
	{/if}

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>run</th>
					<th>collection</th>
					<th>status</th>
					<th>metadata mode</th>
					<th>enumeration</th>
					<th>progress</th>
					<th>updated</th>
				</tr>
			</thead>
			<tbody>
				{#if page.items.length === 0}
					<tr>
						<td colspan="7" class="empty-cell">no bootstrap runs found</td>
					</tr>
				{:else}
					{#each page.items as item}
						<tr>
							<td class="mono">
								<a href={runHref(item.run.runId)}>#{item.run.runId}</a>
							</td>
							<td>
								<a href={collectionHref(item)}>{item.collection.slug ?? item.collection.address}</a>
							</td>
							<td>{item.run.status}</td>
							<td>{item.run.metadataMode}</td>
							<td>{item.run.enumerationMode}</td>
							<td class="mono">
								{item.metadataTasks.succeeded}/{item.metadataTasks.total}
								{#if item.metadataTasks.failedTerminal > 0}
									<span class="muted"> failed:{item.metadataTasks.failedTerminal}</span>
								{/if}
							</td>
							<td class="mono">{item.run.updatedAt}</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>

	<footer class="panel-footer">
		{#if page.nextCursor}
			<a class="button-link" href={loadMoreHref()}>load more</a>
		{:else}
			<span class="muted">end of results</span>
		{/if}
	</footer>
</section>
