<script lang="ts">
	import type {
		ApiChain,
		ApiCollection,
		ApiCollectionMediaMode,
		ApiTokenCard
	} from '$lib/api-types';
	import MarketPriceIcon from '$lib/components/MarketPriceIcon.svelte';
	import TokenMediaPreviewTrigger from '$lib/components/TokenMediaPreviewTrigger.svelte';
	import type { BidBookOwnStatusBadge } from '$lib/bidding-bid-book-own-status';
	import type { MarketPriceItem } from '$lib/market-price';
	import type {
		TokenPreviewAdjacentResolver,
		TokenPreviewController
	} from '$lib/components/token-preview-controller';
	import { modifierKeyState } from '$lib/components/modifier-key-state';
	import {
		isExclusiveTokenCardSelectionGesture,
		resolveTokenCardSelectionGesture
	} from '$lib/bidding-automation-controller';
	import type { TokenCardSelectionProps } from '$lib/token-card-selection';
	import { TEST_IDS } from '$lib/test-ids';

	let {
		chain,
		collection,
		token,
		href,
		selectedMediaMode,
		availableMediaModes,
		tokenPreview,
		adjacentTokenResolver = null,
		priceLabel = null,
		priceHref = null,
		priceTitle = null,
		marketPrices = [],
		metaLabel = null,
		showMeta = true,
		ownStatusBadges = [],
		selection = null
	}: {
		chain: ApiChain | null;
		collection: ApiCollection | null;
		token: ApiTokenCard;
		href: string;
		selectedMediaMode: string;
		availableMediaModes: ApiCollectionMediaMode[];
		tokenPreview: TokenPreviewController;
		adjacentTokenResolver?: TokenPreviewAdjacentResolver | null;
		priceLabel?: string | null;
		priceHref?: string | null;
		priceTitle?: string | null;
		marketPrices?: MarketPriceItem[];
		metaLabel?: string | null;
		showMeta?: boolean;
		ownStatusBadges?: BidBookOwnStatusBadge[];
		selection?: TokenCardSelectionProps | null;
	} = $props();

	const selectionShortcutActive = $derived(
		!!selection && !selection.state.disabled && $modifierKeyState.control
	);

	function cardClasses(): string {
		return [
			'token-grid-card',
			selection ? 'token-grid-card-selectable' : '',
			selection?.state.selected ? 'token-grid-card-selected' : '',
			selectionShortcutActive ? 'token-grid-card-selection-shortcut' : '',
			selection?.state.disabled ? 'token-grid-card-selection-disabled' : ''
		]
			.filter(Boolean)
			.join(' ');
	}

	function onCardSelectionMouseEvent(event: MouseEvent): void {
		if (!selection || selection.state.disabled) return;
		const gesture = resolveTokenCardSelectionGesture(event);
		if (!gesture) return;
		event.preventDefault();
		event.stopPropagation();
		selection.onToggle({
			tokenId: token.tokenId,
			gesture,
			selected: isExclusiveTokenCardSelectionGesture(gesture) || !selection.state.selected
		});
	}

	function onSelectionRemoveClick(event: MouseEvent): void {
		if (!selection || selection.state.disabled) return;
		event.preventDefault();
		event.stopPropagation();
		selection.onToggle({
			tokenId: token.tokenId,
			gesture: 'remove_button',
			selected: false
		});
	}
</script>

<article
	class={cardClasses()}
	data-testid={TEST_IDS.TokenCard}
	data-token-id={token.tokenId}
	data-selected={selection ? String(selection.state.selected) : undefined}
	title={selection?.state.title ?? undefined}
	onclickcapture={onCardSelectionMouseEvent}
	onauxclickcapture={onCardSelectionMouseEvent}
>
	<TokenMediaPreviewTrigger
		chainRef={chain?.slug ?? null}
		collectionRef={collection?.slug ?? null}
		tokenId={token.tokenId}
		image={token.image}
		{selectedMediaMode}
		{availableMediaModes}
		{tokenPreview}
		{adjacentTokenResolver}
		mode="grid"
		containerClass="token-grid-media"
		imageClass="token-grid-thumb"
		emptyClass="token-grid-thumb token-grid-thumb-empty token-thumb-empty"
	/>
	{#if selection?.state.selected}
		<button
			type="button"
			class="mono token-grid-selection-marker"
			data-testid={TEST_IDS.TokenCardBiddingToggle}
			aria-label={`unselect token ${token.tokenId}`}
			title="unselect"
			onclick={onSelectionRemoveClick}>x</button
		>
	{/if}
	{#if showMeta}
		<div class="token-grid-meta">
			<a class="mono token-grid-id" href={href}>{token.tokenId}</a>
			{#if token.traitSummary}
				<div class="mono token-grid-traits">{token.traitSummary}</div>
			{/if}
			{#if marketPrices.length > 0}
				<div class="mono token-grid-market-prices" aria-label="market prices">
					{#each marketPrices as price}
						<span class={`token-grid-market-price ${price.kind}-price`} title={price.title ?? undefined}>
							<MarketPriceIcon kind={price.kind} />
							{#if price.href}
								<a
									class="token-price-link"
									href={price.href}
									target="_blank"
									rel="noreferrer noopener"
								>
									{price.label}
								</a>
							{:else}
								<span>{price.label}</span>
							{/if}
						</span>
					{/each}
				</div>
			{:else if priceLabel}
				<div class="mono token-grid-price" title={priceTitle ?? undefined}>
					{#if priceHref}
						<a
							class="token-price-link"
							href={priceHref}
							target="_blank"
							rel="noreferrer noopener"
						>
							{priceLabel}
						</a>
					{:else}
						{priceLabel}
					{/if}
				</div>
			{/if}
			{#if metaLabel}
				<div class="mono token-grid-secondary-meta">{metaLabel}</div>
			{/if}
			{#if ownStatusBadges.length > 0}
				<div class="token-grid-own-statuses" aria-label="own bid status">
					{#each ownStatusBadges as badge (`${badge.kind}:${badge.label}`)}
						<span class={`bid-book-own-status bid-book-own-status-${badge.kind}`}>
							{badge.label}
						</span>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</article>
