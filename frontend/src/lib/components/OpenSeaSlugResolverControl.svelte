<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { BootstrapProgressRecord } from '@artgod/shared/bootstrap/operation-output';
	import {
		OPENSEA_COLLECTION_SLUG_PROBE_STATUS,
		OPENSEA_COLLECTION_SLUG_PROBE_ERROR
	} from '@artgod/shared/opensea/collection-slug-probe';
	import type { BootstrapOpenSeaSlugProbeApiResponse } from '$lib/api-types';
	import {
		BackendApiError,
		probeBootstrapOpenSeaSlug,
		probeCollectionOpenSeaSlug
	} from '$lib/backend-api';
	import {
		isBootstrapProbeableAddress,
		normalizeBootstrapAddress
	} from '$lib/bootstrap-contract-probe';
	import LoadingBladeBar from '$lib/components/LoadingBladeBar.svelte';
	import type { OpenSeaSlugResolverState } from '$lib/components/open-sea-slug-resolver-state';

	const openSeaSlugProbeUiStatus = {
		Idle: 'idle',
		Loading: 'loading',
		Ready: 'ready',
		Error: 'error'
	} as const;
	type OpenSeaSlugProbeUiStatus =
		(typeof openSeaSlugProbeUiStatus)[keyof typeof openSeaSlugProbeUiStatus];

	let {
		chainSlug,
		contractAddress,
		collectionRef = null,
		sampleTokenId = null,
		initialSlug = '',
		inputName = 'openseaSlug',
		inputId,
		gridLayout = false,
		inputClass = 'bootstrap-control bootstrap-input-slug',
		inputDisabled,
		openSeaEnabled,
		disabledReason = null,
		resetKey = 0,
		resolvedScopeHref = null,
		onStateChange,
		onOutput
	}: {
		chainSlug: string | null;
		contractAddress: string | null;
		collectionRef?: string | null;
		sampleTokenId?: string | null;
		initialSlug?: string | null;
		inputName?: string;
		inputId?: string;
		gridLayout?: boolean;
		inputClass?: string;
		// Callers can allow manual slug entry for browsing without enabling API lookups.
		inputDisabled?: boolean;
		openSeaEnabled: boolean;
		disabledReason?: string | null;
		resetKey?: number;
		// Preserve the successful lookup while the caller fixes its independent token scope.
		resolvedScopeHref?: string | null;
		onStateChange?: (state: OpenSeaSlugResolverState) => void;
		onOutput?: (record: BootstrapProgressRecord) => void;
	} = $props();

	let slugValue = $state('');
	let probeStatus = $state<OpenSeaSlugProbeUiStatus>(openSeaSlugProbeUiStatus.Idle);
	let probeResult = $state<BootstrapOpenSeaSlugProbeApiResponse | null>(null);
	let probeError = $state<string | null>(null);
	let probeRequestId = 0;
	let requestController: AbortController | undefined;
	let normalizedContractAddress = $derived(normalizeBootstrapAddress(contractAddress ?? ''));
	let slugInputHasValue = $derived(slugValue.trim().length > 0);
	let probePending = $derived(probeStatus === openSeaSlugProbeUiStatus.Loading);
	let slugResolved = $derived(
		openSeaEnabled &&
			probeStatus === openSeaSlugProbeUiStatus.Ready &&
			probeResult?.status === OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Found &&
			probeResult.slug === slugValue.trim().toLowerCase()
	);
	let slugIncorrect = $derived(
		openSeaEnabled &&
			slugInputHasValue &&
			probeStatus === openSeaSlugProbeUiStatus.Ready &&
			probeResult?.status === OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Missing
	);
	let probeMessage = $derived(
		!openSeaEnabled ? disabledReason : (probeError ?? probeResult?.reason ?? null)
	);
	let canResolve = $derived(
		openSeaEnabled &&
			chainSlug !== null &&
			isBootstrapProbeableAddress(normalizedContractAddress) &&
			(collectionRef !== null || /^\d+$/.test(sampleTokenId?.trim() ?? ''))
	);
	let sampleLabel = $derived(
		!collectionRef && sampleTokenId?.trim() ? ` #${sampleTokenId.trim()}` : ''
	);
	let resolveLabel = $derived(`resolve${sampleLabel}`);

	$effect(() => {
		const initial = initialSlug ?? '';
		void resetKey;
		untrack(() => {
			slugValue = initial;
			invalidate();
		});
	});

	$effect(() => {
		// Edits only invalidate old evidence. Network work requires an explicit action.
		void chainSlug;
		void normalizedContractAddress;
		void collectionRef;
		void sampleTokenId;
		void openSeaEnabled;
		untrack(invalidate);
	});

	onDestroy(() => {
		requestController?.abort();
		probeRequestId += 1;
	});

	$effect(() => {
		const state: OpenSeaSlugResolverState = {
			slug: slugValue.trim().toLowerCase(),
			hasValue: slugInputHasValue,
			resolvedSlug: slugResolved ? (probeResult?.slug ?? null) : null,
			resolved: slugResolved,
			incorrect: slugIncorrect,
			pending: probePending,
			message: probeMessage
		};
		untrack(() => onStateChange?.(state));
	});

	// Cancel a superseded check without discarding the user's OpenSea slug input.
	export function invalidate(): void {
		requestController?.abort();
		probeRequestId += 1;
		probeStatus = openSeaSlugProbeUiStatus.Idle;
		probeResult = null;
		probeError = null;
	}

	// The bootstrap action and the standalone sync modal share this explicit lookup.
	export async function resolveSlug(): Promise<void> {
		if (!canResolve || !chainSlug) {
			if (openSeaEnabled && !collectionRef)
				probeError = OPENSEA_COLLECTION_SLUG_PROBE_ERROR.SampleRequired;
			return;
		}
		const requestId = ++probeRequestId;
		requestController?.abort();
		requestController = new AbortController();
		const slug = slugValue.trim().toLowerCase() || undefined;
		probeStatus = openSeaSlugProbeUiStatus.Loading;
		probeError = null;
		probeResult = null;
		try {
			const result = collectionRef
				? await probeCollectionOpenSeaSlug(fetch, chainSlug, collectionRef, slug)
				: await probeBootstrapOpenSeaSlug(fetch, chainSlug, {
						address: normalizedContractAddress,
						sampleTokenId: sampleTokenId!.trim(),
						slug
					}, onOutput ? { signal: requestController.signal, onOutput: record => {
						if (requestId === probeRequestId) onOutput?.(record);
					} } : undefined);
			if (requestId !== probeRequestId) return;
			probeResult = result;
			probeStatus = openSeaSlugProbeUiStatus.Ready;
			// Resolving a blank slug is an explicit user action; never replace a staged slug.
			if (!slug && result.status === OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Found && result.slug) {
				slugValue = result.slug;
			}
		} catch (error) {
			if (requestId !== probeRequestId) return;
			probeStatus = openSeaSlugProbeUiStatus.Error;
			probeError =
				error instanceof BackendApiError &&
				Object.values(OPENSEA_COLLECTION_SLUG_PROBE_ERROR).some(
					(message) => message === error.message
				)
					? error.message
					: 'OpenSea lookup failed. Try resolve again.';
		}
	}

	function onSlugKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		void resolveSlug();
	}
</script>

<div class="bootstrap-input-with-note" class:bootstrap-resolver-grid={gridLayout}>
	<div class="bootstrap-input-status-row">
		<input
			id={inputId}
			bind:value={slugValue}
			class={inputClass}
			type="text"
			name={inputName}
			disabled={inputDisabled ?? !openSeaEnabled}
			oninput={invalidate}
			onkeydown={onSlugKeydown}
		/>
		<div class:bootstrap-row-actions={gridLayout} class:bootstrap-resolver-actions={!gridLayout}>
			{#if slugResolved}
				{#if resolvedScopeHref}
					<a href={resolvedScopeHref} class="bid-book-own-status bid-book-own-status-cancelled bootstrap-resolution-badge">check scope</a>
				{:else}
					<span class="bid-book-own-status bid-book-own-status-draw bootstrap-resolution-badge">resolved</span>
				{/if}
			{:else}
				<button
					type="button"
					class="action-button-positive"
					aria-label={resolveLabel}
					title={resolveLabel}
					aria-busy={probePending}
					disabled={!canResolve || probePending}
					onclick={() => void resolveSlug()}
				>
					{#if probePending}
						<span class="bootstrap-inline-progress">
							<span class="action-button-value">resolving{sampleLabel}</span>
							<LoadingBladeBar ariaLabel="resolving OpenSea slug" barLength={2} />
						</span>
					{:else}<span class="action-button-value">{resolveLabel}</span>{/if}
				</button>
				{#if slugIncorrect && !gridLayout}
					<span class="bid-book-own-status bid-book-own-status-cancelled bootstrap-resolution-badge">
						incorrect
					</span>
				{/if}
			{/if}
		</div>
	</div>
	{#if probeMessage}
		<span class="muted bootstrap-opensea-slug-note" class:bootstrap-row-note={gridLayout}>{probeMessage}</span>
	{/if}
</div>
