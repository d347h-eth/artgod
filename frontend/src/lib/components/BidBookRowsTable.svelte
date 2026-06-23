<script lang="ts">
	import { BID_BOOK_ROWS_TABLE_SCOPE_KIND, type BidBookRowsTableRow } from '$lib/bid-book-view-models';
	import BidBookMakerCell from '$lib/components/BidBookMakerCell.svelte';
	import BidBookPriceCell from '$lib/components/BidBookPriceCell.svelte';
	import BidBookTraitList from '$lib/components/BidBookTraitList.svelte';
	import FilterIcon from '$lib/components/FilterIcon.svelte';
	import PlaceBidIcon from '$lib/components/PlaceBidIcon.svelte';
	import { bidBookUpdateFlash } from '$lib/bid-book-update-flash';
	import { TEST_IDS } from '$lib/test-ids';

	type MaybePromise<T> = T | Promise<T>;

	let {
		rows,
		showScope,
		columnCount,
		hiddenBidCount,
		expanded,
		onTogglePlacedAtMode,
		onToggleValidUntilMode,
		onToggleExpanded,
		onSelectBid,
		onFilterTraitBid,
		onSetHighlighted,
		onClearHighlighted,
		flashKey = null
	}: {
		rows: BidBookRowsTableRow[];
		showScope: boolean;
		columnCount: number;
		hiddenBidCount: number;
		expanded: boolean;
		onTogglePlacedAtMode: () => void;
		onToggleValidUntilMode: () => void;
		onToggleExpanded: () => void;
		onSelectBid: (row: BidBookRowsTableRow) => MaybePromise<void>;
		onFilterTraitBid: (row: BidBookRowsTableRow) => MaybePromise<void>;
		onSetHighlighted: (row: BidBookRowsTableRow) => void;
		onClearHighlighted: () => void;
		flashKey?: string | null;
	} = $props();

	function selectBid(row: BidBookRowsTableRow): void {
		void onSelectBid(row);
	}

	function filterTraitBid(row: BidBookRowsTableRow): void {
		void onFilterTraitBid(row);
	}

	function setHighlighted(row: BidBookRowsTableRow): void {
		onSetHighlighted(row);
	}

	function rowTraitSignature(row: BidBookRowsTableRow): string {
		return row.scope.kind === BID_BOOK_ROWS_TABLE_SCOPE_KIND.Traits
			? row.scope.traits.map((trait) => `${trait.type}=${trait.value}`).join('|')
			: '';
	}
</script>

<section class="bid-book-table-panel">
	<div class="table-wrap bid-book-table-wrap">
		<table class="bid-book-table">
			<thead>
				<tr>
					<th class="bid-book-col-right">price</th>
					{#if showScope}
						<th class="bid-book-col-center">scope</th>
					{/if}
					<th class="bid-book-col-center">maker</th>
					<th class="bid-book-time-header bid-book-col-center">
						<button
							type="button"
							class="activities-time-mode-button"
							aria-label="toggle placed-at time mode"
							onclick={onTogglePlacedAtMode}
						>
							placed
						</button>
					</th>
					<th class="bid-book-time-header bid-book-col-center">
						<button
							type="button"
							class="activities-time-mode-button"
							aria-label="toggle valid-until time mode"
							onclick={onToggleValidUntilMode}
						>
							valid
						</button>
					</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.bid.orderId)}
					{#if row.startsNewBucket && !row.hidden}
						<tr class="bid-book-bucket-spacer" aria-hidden="true">
							<td colspan={columnCount}></td>
						</tr>
					{/if}
					<tr
						class:bid-book-own-row={row.bid.maker.isOwn}
						class:bid-book-muted-row={row.muted}
						hidden={row.hidden}
						use:bidBookUpdateFlash={row.bid.maker.isOwn ? flashKey : null}
					>
						<BidBookPriceCell
							bid={row.bid}
							quantityPrefix={row.quantityPrefix}
							price={row.price}
							actionLabel={row.priceActionLabel}
							onSelect={() => selectBid(row)}
						/>
						{#if showScope}
							<td class="bid-book-col-center">
								{#if row.scope.kind === BID_BOOK_ROWS_TABLE_SCOPE_KIND.Traits}
									<div class="bid-book-demand-group-header bid-book-row-scope-header">
										<span class="bid-book-demand-group-title">
											<BidBookTraitList
												traits={row.scope.traits}
												traitValueHref={row.scope.traitValueHref}
											/>
										</span>
										{#if row.scope.showFilterAction}
											<button
												type="button"
												class="bid-book-place-bid-icon-button"
												data-testid={TEST_IDS.BidBookRowFilter}
												data-traits={rowTraitSignature(row)}
												aria-label={row.scope.filterLabel}
												title={row.scope.filterLabel}
												onclick={() => filterTraitBid(row)}
											>
												<FilterIcon />
											</button>
										{/if}
										{#if row.scope.placeBidLabel}
											<button
												type="button"
												class="bid-book-place-bid-icon-button"
												data-testid={TEST_IDS.BidBookRowBid}
												data-traits={rowTraitSignature(row)}
												aria-label={row.scope.placeBidLabel}
												title={row.scope.placeBidLabel}
												onclick={() => selectBid(row)}
											>
												<PlaceBidIcon className="bid-book-place-bid-icon" />
											</button>
										{/if}
									</div>
								{:else if row.scope.kind === BID_BOOK_ROWS_TABLE_SCOPE_KIND.PlainAction}
									<div class="bid-book-demand-group-header bid-book-row-scope-header">
										<span class="bid-book-scope-label">{row.scope.label}</span>
										<button
											type="button"
											class="bid-book-place-bid-icon-button"
											data-testid={TEST_IDS.BidBookRowBid}
											aria-label={row.scope.placeBidLabel}
											title={row.scope.placeBidLabel}
											onclick={() => selectBid(row)}
										>
											<PlaceBidIcon className="bid-book-place-bid-icon" />
										</button>
									</div>
								{:else}
									<span class="bid-book-scope-label">{row.scope.label}</span>
								{/if}
							</td>
						{/if}
						<BidBookMakerCell
							bid={row.bid}
							href={row.makerHref}
							highlighted={row.makerHighlighted}
							onSetHighlighted={() => setHighlighted(row)}
							onClearHighlighted={onClearHighlighted}
						/>
						<td class="mono bid-book-col-center" title={row.placedAtTitle}>
							{row.placedAtLabel}
						</td>
						<td class="mono bid-book-col-center" title={row.validUntilTitle}>
							{row.validUntilLabel}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if hiddenBidCount > 0}
		<div class="bid-book-expand-row">
			<button
				type="button"
				class="facet-panel-action-button bid-book-expand-button"
				onclick={onToggleExpanded}
			>
				{expanded ? 'collapse' : `expand ${hiddenBidCount}`}
			</button>
		</div>
	{/if}
</section>
