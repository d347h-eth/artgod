<script lang="ts">
	import { BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS } from '@artgod/shared/bootstrap/opensea-slug-probe';
	import type { BootstrapOpenSeaSlugProbeApiResponse } from '$lib/api-types';
	import { probeBootstrapOpenSeaSlug } from '$lib/backend-api';
	import {
		isBootstrapProbeableAddress,
		normalizeBootstrapAddress
	} from '$lib/bootstrap-contract-probe';
	import LoadingBladeBar from '$lib/components/LoadingBladeBar.svelte';
	import type { OpenSeaSlugResolverState } from '$lib/components/open-sea-slug-resolver-state';

	type OpenSeaSlugProbeRequest = Parameters<typeof probeBootstrapOpenSeaSlug>[2];

	const openSeaSlugProbeUiStatus = {
		Idle: 'idle',
		Waiting: 'waiting',
		Loading: 'loading',
		Ready: 'ready',
		Error: 'error'
	} as const;

	type OpenSeaSlugProbeUiStatus =
		(typeof openSeaSlugProbeUiStatus)[keyof typeof openSeaSlugProbeUiStatus];

	let {
		chainSlug,
		contractAddress,
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
		initialSlug?: string | null;
		inputName?: string;
		inputClass?: string;
		openSeaEnabled: boolean;
		disabledReason?: string | null;
		resetKey?: number;
		onStateChange?: (state: OpenSeaSlugResolverState) => void;
	} = $props();

	let slugValue = $state('');
	let slugInputElement = $state<HTMLInputElement | null>(null);
	let slugInputHasValue = $state(false);
	let probeStatus = $state<OpenSeaSlugProbeUiStatus>(openSeaSlugProbeUiStatus.Idle);
	let probeResult = $state<BootstrapOpenSeaSlugProbeApiResponse | null>(null);
	let probeError = $state<string | null>(null);
	let lastAutoFilledSlug: string | null = null;
	let slugWasAutoFilled = false;
	let probeRequestId = 0;
	let lastContextKey = '';
	let lastEmittedStateKey = '';

	let normalizedContractAddress = $derived(normalizeBootstrapAddress(contractAddress ?? ''));
	let contractAddressCanBeProbed = $derived(isBootstrapProbeableAddress(normalizedContractAddress));
	let probePending = $derived(
		probeStatus === openSeaSlugProbeUiStatus.Waiting ||
			probeStatus === openSeaSlugProbeUiStatus.Loading
	);
	let slugResolved = $derived(isSlugResolved());
	let slugIncorrect = $derived(isSlugIncorrect());
	let resolvedSlug = $derived(slugResolved ? readSlugInputValue() : null);
	let probeMessage = $derived(resolveProbeMessage());

	$effect(() => {
		const contextKey = [
			chainSlug ?? '',
			normalizedContractAddress,
			openSeaEnabled ? 'enabled' : 'disabled',
			String(resetKey),
			initialSlug ?? ''
		].join('|');
		if (contextKey === lastContextKey) return;
		lastContextKey = contextKey;
		probeRequestId += 1;
		setSlugInputValue(initialSlug ?? '');
		lastAutoFilledSlug = null;
		slugWasAutoFilled = false;
		resetProbeState();
		if (!openSeaEnabled || !chainSlug || !contractAddressCanBeProbed) return;
		scheduleAddressProbe(chainSlug, normalizedContractAddress);
	});

	$effect(() => {
		const state = currentState();
		const stateKey = JSON.stringify(state);
		if (stateKey === lastEmittedStateKey) return;
		lastEmittedStateKey = stateKey;
		onStateChange?.(state);
	});

	function currentState(): OpenSeaSlugResolverState {
		return {
			slug: readSlugInputValue(),
			hasValue: slugInputHasValue,
			resolvedSlug,
			resolved: slugResolved,
			incorrect: slugIncorrect,
			pending: probePending,
			message: probeMessage
		};
	}

	function resetProbeState(): void {
		probeStatus = openSeaSlugProbeUiStatus.Idle;
		probeResult = null;
		probeError = null;
	}

	function setSlugInputValue(value: string): void {
		slugValue = value;
		if (slugInputElement) slugInputElement.value = value;
		slugInputHasValue = normalizeSlugInput(value).length > 0;
	}

	function readSlugInputValue(): string {
		return normalizeSlugInput(slugInputElement?.value ?? slugValue);
	}

	function onSlugInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		slugValue = target.value;
		lastAutoFilledSlug = null;
		slugWasAutoFilled = false;
		const slug = normalizeSlugInput(target.value);
		const hasValue = slug.length > 0;
		if (probeStatus !== openSeaSlugProbeUiStatus.Idle || slugInputHasValue !== hasValue) {
			probeRequestId += 1;
			resetProbeState();
		}
		slugInputHasValue = hasValue;
	}

	function onSlugKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		verifyCurrentSlug();
	}

	function onResolveClick(): void {
		verifyCurrentSlug();
	}

	function scheduleAddressProbe(chain: string, address: string): void {
		probeRequestId += 1;
		const requestId = probeRequestId;
		probeStatus = openSeaSlugProbeUiStatus.Waiting;
		probeResult = null;
		probeError = null;
		if (slugWasAutoFilled) {
			setSlugInputValue('');
			lastAutoFilledSlug = null;
			slugWasAutoFilled = false;
		}
		void runSlugProbe(chain, { address }, requestId);
	}

	function verifyCurrentSlug(): void {
		if (!openSeaEnabled || !chainSlug) return;
		const slug = readSlugInputValue();
		if (!slug) {
			slugInputHasValue = false;
			return;
		}
		probeRequestId += 1;
		const requestId = probeRequestId;
		probeStatus = openSeaSlugProbeUiStatus.Waiting;
		probeResult = null;
		probeError = null;
		const input: OpenSeaSlugProbeRequest = contractAddressCanBeProbed
			? { address: normalizedContractAddress, slug }
			: { slug };
		void runSlugProbe(chainSlug, input, requestId);
	}

	async function runSlugProbe(
		chain: string,
		input: OpenSeaSlugProbeRequest,
		requestId: number
	): Promise<void> {
		probeStatus = openSeaSlugProbeUiStatus.Loading;
		try {
			const result = await probeBootstrapOpenSeaSlug(fetch, chain, input);
			if (requestId !== probeRequestId) return;
			probeStatus = openSeaSlugProbeUiStatus.Ready;
			probeResult = result;
			applyProbeResult(result);
		} catch (error) {
			if (requestId !== probeRequestId) return;
			probeStatus = openSeaSlugProbeUiStatus.Error;
			probeResult = null;
			probeError = error instanceof Error ? error.message : 'OpenSea slug probe failed';
		}
	}

	function applyProbeResult(result: BootstrapOpenSeaSlugProbeApiResponse): void {
		if (result.status !== BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found || !result.slug) return;
		const resolved = normalizeSlugInput(result.slug);
		if (!resolved) return;
		if (result.address && result.address !== normalizedContractAddress) return;
		if (result.requestedSlug && result.requestedSlug !== resolved) return;
		if (
			result.address &&
			!result.requestedSlug &&
			(!readSlugInputValue() || slugValue === lastAutoFilledSlug)
		) {
			setSlugInputValue(result.slug);
			lastAutoFilledSlug = result.slug;
			slugWasAutoFilled = true;
			return;
		}
		if (result.requestedSlug && readSlugInputValue() === resolved) {
			setSlugInputValue(resolved);
		}
	}

	function isSlugResolved(): boolean {
		if (!openSeaEnabled || probeStatus !== openSeaSlugProbeUiStatus.Ready) return false;
		if (!probeResult) return false;
		if (probeResult.status !== BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found) return false;
		const resolved = normalizeSlugInput(probeResult.slug ?? '');
		if (!resolved || readSlugInputValue() !== resolved) return false;
		if (probeResult.address) {
			return probeResult.address === normalizedContractAddress;
		}
		return probeResult.requestedSlug === resolved;
	}

	function isSlugIncorrect(): boolean {
		if (!openSeaEnabled || probeStatus !== openSeaSlugProbeUiStatus.Ready || !slugInputHasValue) {
			return false;
		}
		if (
			probeResult?.status === BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Missing &&
			probeResult.requestedSlug !== null
		) {
			return true;
		}
		if (
			probeResult?.status === BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found &&
			probeResult.address !== null
		) {
			return normalizeSlugInput(probeResult.slug ?? '') !== readSlugInputValue();
		}
		return false;
	}

	function resolveProbeMessage(): string | null {
		if (!openSeaEnabled) return disabledReason;
		if (probeError) return probeError;
		if (probeResult?.reason) return probeResult.reason;
		return null;
	}

	function normalizeSlugInput(value: string): string {
		return value.trim().toLowerCase();
	}
</script>

<div class="bootstrap-input-with-note">
	<div class="bootstrap-input-status-row">
		<input
			bind:this={slugInputElement}
			value={slugValue}
			class={inputClass}
			type="text"
			name={inputName}
			disabled={!openSeaEnabled}
			oninput={onSlugInput}
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
			<button type="button" disabled={!openSeaEnabled || !slugInputHasValue} onclick={onResolveClick}>
				resolve
			</button>
		{/if}
	</div>
	{#if probeMessage}
		<span class="muted bootstrap-opensea-slug-note">{probeMessage}</span>
	{/if}
</div>
