<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { createBootstrapRun } from '$lib/backend-api';
	import type { ApiChain, ApiCollection, ApiCollectionsPage } from '$lib/api-types';

	let {
		chain,
		page,
		status,
		basePath,
		showBreadcrumbs = false
	}: {
		chain: ApiChain | null;
		page: ApiCollectionsPage;
		status: string;
		basePath: string;
		showBreadcrumbs?: boolean;
	} = $props();

	const statusOptions = ['', 'bootstrapping', 'live', 'paused', 'disabled'];
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

	function collectionRef(collection: ApiCollection): string {
		return collection.slug ?? collection.address;
	}

	function collectionHref(collection: ApiCollection): string {
		if (!chain) return '#';
		return `/${chain.slug}/${collectionRef(collection)}`;
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

	function normalizeFieldValue(value: unknown): string {
		if (typeof value === 'string') return value.trim();
		if (typeof value === 'number' && Number.isFinite(value)) {
			return String(value).trim();
		}
		return '';
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
			await invalidateAll();
		} catch (error) {
			submitError = error instanceof Error ? error.message : 'bootstrap request failed';
		} finally {
			submitting = false;
		}
	}
</script>

<section class="panel">
	{#if showBreadcrumbs}
		<nav class="breadcrumbs" aria-label="Breadcrumb">
			<a href="/">home</a>
			<span class="breadcrumbs-separator">/</span>
			<span class="breadcrumbs-current">collections</span>
		</nav>
	{/if}

	<header class="panel-header">
		<div>
			<h1 class="panel-title">ArtGod Collections</h1>
			<p class="panel-subtitle">
				{#if chain}
					{chain.name} ({chain.slug} / {chain.publicChainId})
				{:else}
					Loading default chain...
				{/if}
			</p>
		</div>
		<form class="status-form" method="GET" action={basePath}>
			<label for="status">status</label>
			<select id="status" name="status">
				{#each statusOptions as option}
					<option value={option} selected={option === status}>{option || 'all'}</option>
				{/each}
			</select>
			<button type="submit">apply</button>
		</form>
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
				<input
					bind:value={bootstrapSlug}
					class={bootstrapInputClass}
					type="text"
					name="slug"
					required
				/>
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
					<th>slug</th>
					<th>address</th>
					<th>status</th>
					<th>standard</th>
					<th>created</th>
				</tr>
			</thead>
			<tbody>
				{#if page.items.length === 0}
					<tr>
						<td colspan="5" class="empty-cell">no collections found</td>
					</tr>
				{:else}
					{#each page.items as collection}
						<tr>
							<td>
								<a href={collectionHref(collection)}>{collection.slug ?? '(no-slug)'}</a>
							</td>
							<td class="mono">{collection.address}</td>
							<td>{collection.status}</td>
							<td>{collection.standard}</td>
							<td class="mono">{collection.createdAt}</td>
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
