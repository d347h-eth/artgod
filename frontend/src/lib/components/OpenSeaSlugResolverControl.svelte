<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
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
		inputClass = 'bootstrap-control bootstrap-input-slug',
		openSeaEnabled,
		disabledReason = null,
		resetKey = 0,
		onStateChange
	}: {
		chainSlug: string | null;
		contractAddress: string | null;
		collectionRef?: string | null;
		sampleTokenId?: string | null;
		initialSlug?: string | null;
		inputName?: string;
		inputClass?: string;
		openSeaEnabled: boolean;
		disabledReason?: string | null;
		resetKey?: number;
		onStateChange?: (state: OpenSeaSlugResolverState) => void;
	} = $props();

	let slugValue = $state('');
	let probeStatus = $state<OpenSeaSlugProbeUiStatus>(openSeaSlugProbeUiStatus.Idle);
	let probeResult = $state<BootstrapOpenSeaSlugProbeApiResponse | null>(null);
	let probeError = $state<string | null>(null);
	let probeRequestId = 0;
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

	onDestroy(() => { probeRequestId += 1; });

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

	function invalidate(): void {
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
					});
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

<div class="bootstrap-input-with-note">
	<div class="bootstrap-input-status-row">
		<input
			bind:value={slugValue}
			class={inputClass}
			type="text"
			name={inputName}
			disabled={!openSeaEnabled}
			oninput={invalidate}
			onkeydown={onSlugKeydown}
		/>
		{#if slugResolved}
			<span class="bid-book-own-status bid-book-own-status-draw bootstrap-resolution-badge">
				resolved
			</span>
		{:else if slugIncorrect}
			<span class="bid-book-own-status bid-book-own-status-cancelled bootstrap-resolution-badge">
				incorrect
			</span>
		{:else if probePending}
			<span class="muted">
				<span class="bootstrap-inline-progress">
					<span>resolving</span>
					<LoadingBladeBar ariaLabel="resolving OpenSea slug" barLength={2} />
				</span>
			</span>
		{:else}
			<button type="button" disabled={!canResolve} onclick={() => void resolveSlug()}>
				resolve
			</button>
		{/if}
	</div>
	{#if probeMessage}
		<span class="muted bootstrap-opensea-slug-note">{probeMessage}</span>
	{/if}
</div>
