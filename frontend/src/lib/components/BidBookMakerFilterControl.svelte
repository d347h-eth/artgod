<script lang="ts">
	import { resolveOwnerAddressRef } from '$lib/components/owner-ref';

	type MaybePromise<T> = T | Promise<T>;

	let {
		chainRef,
		value = null,
		onApply,
		onClear
	}: {
		chainRef: string;
		value?: string | null;
		onApply: (makerAddress: string) => MaybePromise<void>;
		onClear: () => MaybePromise<void>;
	} = $props();

	let draft = $state(value ?? '');
	let pending = $state(false);
	let invalid = $state(false);

	$effect(() => {
		draft = value ?? '';
		invalid = false;
	});

	async function onSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const nextValue = draft.trim();
		if (!nextValue) {
			await onClear();
			return;
		}

		pending = true;
		invalid = false;
		try {
			// Resolve ENS once at the UI boundary so bid-book reads stay address-indexed.
			const makerAddress = await resolveOwnerAddressRef({
				fetchFn: fetch,
				chainRef,
				value: nextValue
			});
			if (!makerAddress) {
				invalid = true;
				return;
			}
			await onApply(makerAddress);
		} catch {
			invalid = true;
		} finally {
			pending = false;
		}
	}

	function onClearClick(): void {
		draft = '';
		invalid = false;
		void onClear();
	}
</script>

<form class="bid-book-maker-filter" onsubmit={onSubmit}>
	<input
		class="bid-book-maker-filter-input"
		type="text"
		bind:value={draft}
		placeholder="maker address/.eth"
		aria-label="Filter bids by maker address or ENS name"
		aria-invalid={invalid}
		autocomplete="off"
		autocapitalize="off"
		spellcheck="false"
		disabled={pending}
	/>
	{#if value || draft.trim()}
		<button
			class="facet-panel-action-button facet-reset-button bid-book-maker-filter-clear"
			type="button"
			title="clear maker filter"
			aria-label="clear maker filter"
			disabled={pending}
			onclick={onClearClick}
		>
			x
		</button>
	{/if}
</form>
