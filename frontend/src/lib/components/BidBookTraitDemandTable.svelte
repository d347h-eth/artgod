<script lang="ts">
	import type { Component } from 'svelte';
	import type { BidBookTraitDemandGroupPreviewProps } from '$lib/bid-book-trait-previews';
	import type {
		BidBookDemandTableGroup,
		BidBookDemandTableTab
	} from '$lib/bid-book-view-models';
	import BidBookMakerCell from '$lib/components/BidBookMakerCell.svelte';
	import BidBookPriceCell from '$lib/components/BidBookPriceCell.svelte';
	import BidBookTraitList from '$lib/components/BidBookTraitList.svelte';
	import FilterIcon from '$lib/components/FilterIcon.svelte';
	import PlaceBidIcon from '$lib/components/PlaceBidIcon.svelte';
	import {
		BID_BOOK_UPDATE_FLASH_MODE,
		bidBookOwnRowFlashKey,
		bidBookUpdateFlash
	} from '$lib/bid-book-update-flash';
	import { TEST_IDS } from '$lib/test-ids';

	type MaybePromise<T> = T | Promise<T>;
	type BidBookDemandTableRow = BidBookDemandTableGroup['rows'][number];

	let {
		tabs,
		groups,
		onSetActiveTraitKey,
		onTogglePlacedAtMode,
		onToggleValidUntilMode,
		onSelectGroupBid,
		onFilterGroup,
		onSetHighlighted,
		onClearHighlighted,
		TraitDemandGroupPreview = null
	}: {
		tabs: BidBookDemandTableTab[];
		groups: BidBookDemandTableGroup[];
		onSetActiveTraitKey: (key: string | null) => void;
		onTogglePlacedAtMode: () => void;
		onToggleValidUntilMode: () => void;
		onSelectGroupBid: (group: BidBookDemandTableGroup) => MaybePromise<void>;
		onFilterGroup: (group: BidBookDemandTableGroup) => MaybePromise<void>;
		onSetHighlighted: (row: BidBookDemandTableRow) => void;
		onClearHighlighted: () => void;
		TraitDemandGroupPreview?: Component<BidBookTraitDemandGroupPreviewProps> | null;
	} = $props();

	function selectGroupBid(group: BidBookDemandTableGroup): void {
		void onSelectGroupBid(group);
	}

	function filterGroup(group: BidBookDemandTableGroup): void {
		void onFilterGroup(group);
	}

	function groupTraitSignature(group: BidBookDemandTableGroup): string {
		return group.traits.map((trait) => `${trait.type}=${trait.value}`).join('|');
	}

	function hasVisibleRows(group: BidBookDemandTableGroup): boolean {
		return group.rows.some((row) => !row.hidden);
	}
</script>

<section class="bid-book-table-panel">
	{#if tabs.length > 1}
		<div class="secondary-tabs bid-book-demand-tabs" aria-label="Bid trait buckets">
			{#each tabs as tab (tab.key ?? 'all')}
				{#if tab.active}
					<span class="secondary-tab-active">{tab.label} [{tab.count}]</span>
				{:else}
					<button type="button" onclick={() => onSetActiveTraitKey(tab.key)}>
						{tab.label} [{tab.count}]
					</button>
				{/if}
			{/each}
		</div>
	{/if}
	<div class="table-wrap bid-book-table-wrap">
		<table class="bid-book-table bid-book-demand-table">
			<thead>
				<tr>
					<th class="bid-book-col-right">price</th>
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
				{#each groups as group (group.key)}
					{#if group.startsNewGroup}
						<tr class="bid-book-demand-group-spacer" aria-hidden="true">
							<td colspan={4}></td>
						</tr>
					{/if}
					<tr
						class="bid-book-demand-group-row"
						class:bid-book-muted-demand-group={group.muted}
						hidden={group.hidden}
					>
						<td colspan={4}>
							<div class="bid-book-demand-group-header">
								<span class="bid-book-demand-group-title">
									<BidBookTraitList
										traits={group.traits}
										traitValueHref={group.traitValueHref}
									/>
								</span>
								{#if group.showFilterAction || group.showBidAction}
									<div class="bid-book-demand-group-controls">
										{#if group.showFilterAction}
											<button
												type="button"
												class="bid-book-place-bid-icon-button"
												data-testid={TEST_IDS.BidBookTraitBucketFilter}
												data-traits={groupTraitSignature(group)}
												aria-label={group.filterLabel}
												title={group.filterLabel}
												onclick={() => filterGroup(group)}
											>
												<FilterIcon />
											</button>
										{/if}
										{#if group.showBidAction}
											<button
												type="button"
												class="bid-book-place-bid-icon-button"
												data-testid={TEST_IDS.BidBookTraitBucketBid}
												data-traits={groupTraitSignature(group)}
												aria-label={group.placeBidLabel}
												title={group.placeBidLabel}
												onclick={() => selectGroupBid(group)}
											>
												<PlaceBidIcon className="bid-book-place-bid-icon" />
											</button>
										{/if}
									</div>
								{/if}
								{#if TraitDemandGroupPreview}
									<div class="bid-book-demand-group-preview">
										<TraitDemandGroupPreview traits={group.traits} />
									</div>
								{/if}
							</div>
						</td>
					</tr>
					{#if !group.hidden && hasVisibleRows(group)}
						<tr class="bid-book-bucket-spacer" aria-hidden="true">
							<td colspan={4}></td>
						</tr>
					{/if}
					{#each group.rows as row (row.bid.orderId)}
						{#if row.startsNewBucket}
							<tr class="bid-book-bucket-spacer" aria-hidden="true">
								<td colspan={4}></td>
							</tr>
						{/if}
						<tr
							class:bid-book-own-row={row.bid.maker.isOwn}
							class:bid-book-muted-row={row.muted}
							hidden={row.hidden}
							use:bidBookUpdateFlash={row.bid.maker.isOwn
								? {
										key: bidBookOwnRowFlashKey(row.bid),
										mode: BID_BOOK_UPDATE_FLASH_MODE.Persistent,
										playOnMount: true
									}
								: null}
						>
							<BidBookPriceCell
								bid={row.bid}
								quantityPrefix={row.quantityPrefix}
								price={row.price}
							/>
							<BidBookMakerCell
								bid={row.bid}
								href={row.makerHref}
								highlighted={row.makerHighlighted}
								onSetHighlighted={() => onSetHighlighted(row)}
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
					{#if group.activeOfferCount > 1}
						{#if !group.hidden && hasVisibleRows(group)}
							<tr class="bid-book-bucket-spacer" aria-hidden="true">
								<td colspan={4}></td>
							</tr>
						{/if}
						<tr class="bid-book-demand-group-meta-row" hidden={group.hidden}>
							<td colspan={4}>
								<div class="runtime-kv-grid bid-book-demand-group-meta">
									<div>
										<span class="runtime-k">total</span>
										<span class="runtime-v mono bid-book-price">
											{group.totalAmount}
										</span>
									</div>
									<div>
										<span class="runtime-k">offers</span>
										<span class="runtime-v mono">{group.activeOfferCount}</span>
									</div>
									<div>
										<span class="runtime-k">makers</span>
										<span class="runtime-v mono">{group.makerCount}</span>
									</div>
								</div>
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</div>
</section>
