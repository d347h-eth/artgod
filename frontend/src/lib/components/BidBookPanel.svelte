<script lang="ts">
	import type {
		ApiBiddingBidBook,
		ApiBiddingBidBookRow,
		ApiBiddingJob
	} from '$lib/api-types';
	import {
		TRADING_BIDDING_BID_BOOK_PRICE_KIND,
		TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
		TRADING_BIDDING_BID_SCOPE_KIND
	} from '@artgod/shared/types';
	import {
		formatCompactTime,
		oppositeCompactTimeTitle,
		type CompactTimeDisplayMode
	} from '$lib/compact-time-display';
	import {
		BID_BOOK_ROWS_TABLE_SCOPE_KIND,
		type BidBookDemandTableGroup,
		type BidBookDemandTableTab,
		type BidBookDemandTableBidRow,
		type BidBookRowsTableRow,
		type BidBookRowsTableScope
	} from '$lib/bid-book-view-models';
	import {
		bidBookPriceEffectiveEth,
		bidBookRowEffectivePriceWei
	} from '$lib/bidding-bid-book-price';
	import type { BidBookTraitValueHref } from '$lib/bidding-bid-book-display';
	import { trimBidBookTraitText } from '$lib/bidding-bid-book-display';
	import BidBookMetaBar from '$lib/components/BidBookMetaBar.svelte';
	import BidBookRowsTable from '$lib/components/BidBookRowsTable.svelte';
	import BidBookTraitDemandTable from '$lib/components/BidBookTraitDemandTable.svelte';
	import { joinPath } from '$lib/route-paths';
	import { buildOwnerTokensHref } from '$lib/token-browser-query';

	type BidBookTimeMode = CompactTimeDisplayMode;
	type BidBookPanelView = 'rows' | 'trait-demand';
	type MaybePromise<T> = T | Promise<T>;
	type BidBookDemandGroup = {
		key: string;
		label: string;
		traits: ApiBiddingBidBookRow['scope']['traits'];
		bids: ApiBiddingBidBookRow[];
		bestBid: ApiBiddingBidBookRow;
		tieBreakOfferCount: number;
		tieBreakTotalAmountWei: bigint;
		traitKeys: string[];
	};
	type BidBookDemandTraitTab = {
		key: string | null;
		label: string;
		count: number;
	};
	type BidBookTraitDemandBidSelection = {
		bid: ApiBiddingBidBookRow;
		traits: ApiBiddingBidBookRow['scope']['traits'];
		label: string;
	};
	type BidBookTraitDemandFilterSelection = {
		traits: ApiBiddingBidBookRow['scope']['traits'];
		label: string;
	};
	const WEI_PER_ETH = 1_000_000_000_000_000_000n;
	const LOW_BID_MUTE_RATIO_DENOMINATOR = 10n;

	let {
		bidBook,
		job = null,
		showScope = false,
		showRowActions = true,
		showMuted = false,
		view = 'rows',
		basePath = '/',
		mediaMode = null,
		preferredDemandTraitKey = null,
		traitValueHref = null,
		makerFilterHref = null,
		makerBidHref = null,
		onSelectTraitDemandBid = null,
		onFilterTraitDemandGroup = null,
		canSelectBid = null,
		onSelectBid = null
	}: {
		bidBook: ApiBiddingBidBook;
		job?: ApiBiddingJob | null;
		showScope?: boolean;
		showRowActions?: boolean;
		showMuted?: boolean;
		view?: BidBookPanelView;
		basePath?: string;
		mediaMode?: string | null;
		preferredDemandTraitKey?: string | null;
		traitValueHref?: BidBookTraitValueHref | null;
		makerFilterHref?: ((makerAddress: string) => string) | null;
		makerBidHref?: ((bid: ApiBiddingBidBookRow) => string) | null;
		onSelectTraitDemandBid?:
			| ((selection: BidBookTraitDemandBidSelection) => MaybePromise<void>)
			| null;
		onFilterTraitDemandGroup?:
			| ((selection: BidBookTraitDemandFilterSelection) => MaybePromise<void>)
			| null;
		canSelectBid?: ((bid: ApiBiddingBidBookRow) => boolean) | null;
		onSelectBid?: ((bid: ApiBiddingBidBookRow) => MaybePromise<void>) | null;
	} = $props();

	let placedAtMode = $state<BidBookTimeMode>('relative');
	let validUntilMode = $state<BidBookTimeMode>('relative');
	let bidBookExpanded = $state(false);
	let activeDemandTraitKey = $state<string | null>(preferredDemandTraitKey);
	let lastPreferredDemandTraitKey = $state<string | null>(preferredDemandTraitKey);
	let highlightedMakerAddress = $state<string | null>(null);
	let nowMs = $state(Date.now());

	const visibleBids = $derived([...bidBook.bids].sort(compareBidRows));
	const collapsedBidCount = $derived(resolveCollapsedBidCount(visibleBids));
	const collapsedBids = $derived(resolveCollapsedBids(visibleBids, collapsedBidCount));
	const hiddenBidCount = $derived(Math.max(visibleBids.length - collapsedBids.length, 0));
	const displayedBids = $derived(
		bidBookExpanded ? visibleBids : collapsedBids
	);
	const ownBid = $derived(bestBid(visibleBids, (bid) => bid.maker.isOwn));
	const opponentBid = $derived(bestBid(visibleBids, (bid) => !bid.maker.isOwn));
	const position = $derived(resolvePosition(job, ownBid, opponentBid));
	const demandGroups = $derived(resolveDemandGroups(visibleBids));
	const demandTraitTabs = $derived(resolveDemandTraitTabs(demandGroups));
	const demandTableTabs = $derived(resolveDemandTableTabs(demandTraitTabs));
	const visibleDemandGroups = $derived(
		filterDemandGroupsByTrait(demandGroups, activeDemandTraitKey)
	);
	const visibleDemandMedianPriceWei = $derived(resolveMedianBidPriceWei(visibleDemandGroups));
	const showTraitDemandView = $derived(view === 'trait-demand');
	const displayedDemandGroupCount = $derived(
		visibleDemandGroups.filter((group) => !shouldHideDemandGroup(group)).length
	);
	const priceFractionDigits = $derived(
		resolvePriceFractionDigits(
			showTraitDemandView
				? resolveDemandPrecisionBids(visibleDemandGroups)
				: resolveRowPrecisionBids(displayedBids)
		)
	);
	const bidBucketStepWei = $derived(resolveDecimalBucketStepWei(displayedBids));
	const rowsTableRows = $derived(resolveRowsTableRows(displayedBids));
	const demandTableGroups = $derived(resolveDemandTableGroups(visibleDemandGroups));

	$effect(() => {
		if (activeDemandTraitKey && !demandTraitTabs.some((tab) => tab.key === activeDemandTraitKey)) {
			activeDemandTraitKey = null;
		}
	});

	$effect(() => {
		if (preferredDemandTraitKey === lastPreferredDemandTraitKey) return;
		activeDemandTraitKey = preferredDemandTraitKey;
		lastPreferredDemandTraitKey = preferredDemandTraitKey;
	});

	$effect(() => {
		const timer = window.setInterval(() => {
			nowMs = Date.now();
		}, 60_000);
		return () => window.clearInterval(timer);
	});

	function compareBidRows(left: ApiBiddingBidBookRow, right: ApiBiddingBidBookRow): number {
		const leftPrice = bidSortPriceWei(left);
		const rightPrice = bidSortPriceWei(right);
		if (leftPrice === rightPrice) {
			return left.orderId.localeCompare(right.orderId);
		}
		return leftPrice > rightPrice ? -1 : 1;
	}

	function compareDemandGroups(left: BidBookDemandGroup, right: BidBookDemandGroup): number {
		const priceCompare = compareBidRows(left.bestBid, right.bestBid);
		if (priceCompare !== 0) {
			return priceCompare;
		}
		if (left.tieBreakTotalAmountWei !== right.tieBreakTotalAmountWei) {
			return left.tieBreakTotalAmountWei > right.tieBreakTotalAmountWei ? -1 : 1;
		}
		if (left.tieBreakOfferCount !== right.tieBreakOfferCount) {
			return right.tieBreakOfferCount - left.tieBreakOfferCount;
		}
		return left.label.localeCompare(right.label);
	}

	function bestBid(
		rows: ApiBiddingBidBookRow[],
		predicate: (row: ApiBiddingBidBookRow) => boolean
	): ApiBiddingBidBookRow | null {
		return rows.find(predicate) ?? null;
	}

	function resolveCollapsedBidCount(rows: ApiBiddingBidBookRow[]): number {
		if (rows.length <= 1) {
			return rows.length;
		}
		const maxPrice = bidSortPriceWei(rows[0]);
		const minPrice = bidSortPriceWei(rows[rows.length - 1]);
		if (maxPrice === minPrice) {
			return rows.length;
		}
		// Collapse the bottom half of the visible price range, not the bottom half of row count.
		const cutoffPrice = minPrice + (maxPrice - minPrice) / 2n;
		const firstHiddenIndex = rows.findIndex((bid) => bidSortPriceWei(bid) < cutoffPrice);
		return firstHiddenIndex === -1 ? rows.length : Math.max(firstHiddenIndex, 1);
	}

	function resolveCollapsedBids(
		rows: ApiBiddingBidBookRow[],
		count: number
	): ApiBiddingBidBookRow[] {
		return rows.filter((bid, index) => index < count || bid.maker.isOwn);
	}

	function resolvePosition(
		currentJob: ApiBiddingJob | null,
		bestOwn: ApiBiddingBidBookRow | null,
		bestOpponent: ApiBiddingBidBookRow | null
	): string | null {
		if (!currentJob) {
			return null;
		}
		if (!bestOwn) {
			return 'no active bid';
		}
		if (!bestOpponent || bidSortPriceWei(bestOwn) >= bidSortPriceWei(bestOpponent)) {
			return 'winning';
		}
		return 'outbid';
	}

	function bidSortPriceWei(bid: ApiBiddingBidBookRow): bigint {
		return bidBookRowEffectivePriceWei(bid);
	}

	function formatPriceAmount(bid: ApiBiddingBidBookRow): string {
		const price =
			bid.price.kind === TRADING_BIDDING_BID_BOOK_PRICE_KIND.Range
				? `${formatWeiValue(BigInt(bid.price.floorWei), priceFractionDigits)}-${formatWeiValue(
						BigInt(bid.price.ceilingWei),
						priceFractionDigits
					)}`
				: formatUnitPrice(bid);
		const currency = shouldShowCurrency(bid.currencySymbol) ? ` ${bid.currencySymbol}` : '';
		return `${price}${currency}`;
	}

	function formatQuantityPrefix(bid: ApiBiddingBidBookRow): string | null {
		const quantity = parseQuantity(bid.quantity);
		return quantity > 1n ? `${quantity}x` : null;
	}

	function formatScope(bid: ApiBiddingBidBookRow): string {
		if (bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Collection) {
			return 'C';
		}
		if (bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Token && bid.scope.tokenId) {
			return `#${bid.scope.tokenId}`;
		}
		return trimBidBookTraitText(bid.scope.label);
	}

	function shouldRenderTraitScopeControls(bid: ApiBiddingBidBookRow): boolean {
		return bid.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Trait && bid.scope.traits.length > 0;
	}

	function traitScopeLabel(bid: ApiBiddingBidBookRow): string {
		return bid.scope.label || bid.scope.traits.map((trait) => `${trait.type}=${trait.value}`).join(' + ');
	}

	function scopeActionLabel(bid: ApiBiddingBidBookRow): string {
		return bid.scope.label || formatScope(bid);
	}

	function demandDisplayTraits(
		group: BidBookDemandGroup
	): ApiBiddingBidBookRow['scope']['traits'] {
		return sortDemandTraitsForDisplay(group.traits, activeDemandTraitKey);
	}

	function bidScopeDisplayTraits(
		bid: ApiBiddingBidBookRow
	): ApiBiddingBidBookRow['scope']['traits'] {
		return sortDemandTraitsForDisplay(bid.scope.traits, activeDemandTraitKey);
	}

	function makerHref(bid: ApiBiddingBidBookRow): string {
		return (
			makerBidHref?.(bid) ??
			makerFilterHref?.(bid.maker.address) ??
			buildOwnerTokensHref({
				basePath: joinPath(basePath, `holders/${encodeURIComponent(bid.maker.address)}`),
				selectedTraits: [],
				selectedTraitRanges: [],
				mediaMode
			})
		);
	}

	function makerHighlightKey(bid: ApiBiddingBidBookRow): string {
		return bid.maker.address.toLowerCase();
	}

	function isMakerHighlighted(bid: ApiBiddingBidBookRow): boolean {
		return highlightedMakerAddress === makerHighlightKey(bid);
	}

	function setHighlightedMaker(bid: ApiBiddingBidBookRow): void {
		highlightedMakerAddress = makerHighlightKey(bid);
	}

	function clearHighlightedMaker(): void {
		highlightedMakerAddress = null;
	}

	function setHighlightedRowMaker(row: BidBookRowsTableRow): void {
		setHighlightedMaker(row.bid);
	}

	function setHighlightedDemandRowMaker(row: BidBookDemandTableBidRow): void {
		setHighlightedMaker(row.bid);
	}

	function selectBid(bid: ApiBiddingBidBookRow): void {
		if (!canSelectBidRow(bid)) {
			return;
		}
		void onSelectBid?.(bid);
	}

	function rowActionLabel(bid: ApiBiddingBidBookRow): string {
		return bid.materialization.kind === TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent
			? 'edit'
			: 'use';
	}

	function selectTraitDemandBid(group: BidBookDemandGroup): void {
		if (onSelectTraitDemandBid) {
			void onSelectTraitDemandBid({
				bid: group.bestBid,
				traits: group.traits,
				label: group.label
			});
			return;
		}
		void onSelectBid?.(group.bestBid);
	}

	function filterTraitDemandGroup(group: BidBookDemandGroup): void {
		filterTraits(group.traits, group.label);
	}

	function filterDemandTableGroup(group: BidBookDemandTableGroup): void {
		const sourceGroup = findVisibleDemandGroup(group.key);
		if (sourceGroup) {
			filterTraitDemandGroup(sourceGroup);
		}
	}

	function filterTraitScopeBid(bid: ApiBiddingBidBookRow): void {
		filterTraits(bid.scope.traits, traitScopeLabel(bid));
	}

	function filterRowsTableTraitBid(row: BidBookRowsTableRow): void {
		filterTraitScopeBid(row.bid);
	}

	function shouldShowTraitFilterAction(
		traits: ApiBiddingBidBookRow['scope']['traits']
	): boolean {
		return !!onFilterTraitDemandGroup && traits.length > 1;
	}

	function filterTraits(traits: ApiBiddingBidBookRow['scope']['traits'], label: string): void {
		if (!onFilterTraitDemandGroup) {
			return;
		}
		void onFilterTraitDemandGroup({
			traits,
			label
		});
	}

	function placeBidLabel(label: string): string {
		return `place bid on ${label}`;
	}

	function canSelectBidRow(bid: ApiBiddingBidBookRow): boolean {
		return !!onSelectBid && (canSelectBid?.(bid) ?? true);
	}

	function shouldRenderScopeBidControl(bid: ApiBiddingBidBookRow): boolean {
		return canSelectBidRow(bid) && !shouldRenderTraitScopeControls(bid);
	}

	function selectRowsTableBid(row: BidBookRowsTableRow): void {
		selectBid(row.bid);
	}

	function selectDemandTableGroup(group: BidBookDemandTableGroup): void {
		const sourceGroup = findVisibleDemandGroup(group.key);
		if (sourceGroup) {
			selectTraitDemandBid(sourceGroup);
		}
	}

	function findVisibleDemandGroup(key: string): BidBookDemandGroup | null {
		return visibleDemandGroups.find((group) => group.key === key) ?? null;
	}

	function formatUnitPrice(bid: ApiBiddingBidBookRow): string {
		return formatWeiValue(bidSortPriceWei(bid), priceFractionDigits);
	}

	function resolveDemandGroups(rows: ApiBiddingBidBookRow[]): BidBookDemandGroup[] {
		const groups = new Map<string, ApiBiddingBidBookRow[]>();
		for (const bid of rows) {
			const key = demandGroupKey(bid);
			const group = groups.get(key);
			if (group) {
				group.push(bid);
			} else {
				groups.set(key, [bid]);
			}
		}

		return [...groups.entries()]
			.map(([key, bids]) => {
				const sortedBids = [...bids].sort(compareBidRows);
				const bestBid = sortedBids[0];
				const traits = canonicalBidTraits(bestBid);
				const activeBids = sortedBids.filter((bid) => !isMutedBidForBest(bestBid, bid));
				return {
					key,
					label: formatDemandTraits(traits, null),
					traits,
					bids: sortedBids,
					bestBid,
					tieBreakOfferCount: activeBids.length,
					tieBreakTotalAmountWei: activeBids.reduce(
						(total, bid) => total + bidSortPriceWei(bid) * parseQuantity(bid.quantity),
						0n
					),
					traitKeys: demandGroupTraitKeys(traits)
				};
			})
			.sort(compareDemandGroups);
	}

	function resolveMedianBidPriceWei(groups: BidBookDemandGroup[]): bigint | null {
		const prices = groups
			.flatMap((group) => group.bids.map((bid) => bidSortPriceWei(bid)))
			.sort(compareBigIntAscending);
		if (prices.length === 0) {
			return null;
		}
		const middleIndex = Math.floor(prices.length / 2);
		if (prices.length % 2 === 1) {
			return prices[middleIndex];
		}
		return (prices[middleIndex - 1] + prices[middleIndex]) / 2n;
	}

	function compareBigIntAscending(left: bigint, right: bigint): number {
		if (left === right) {
			return 0;
		}
		return left < right ? -1 : 1;
	}

	function demandGroupKey(bid: ApiBiddingBidBookRow): string {
		const traits = canonicalBidTraits(bid);
		if (traits.length === 0) {
			return `${bid.scope.kind}\u0000${bid.scope.label}\u0000${bid.scope.tokenId ?? ''}`;
		}
		return traits.map((trait) => `${trait.type}\u0000${trait.value}`).join('\u0001');
	}

	function canonicalBidTraits(bid: ApiBiddingBidBookRow): ApiBiddingBidBookRow['scope']['traits'] {
		return [...bid.scope.traits].sort((left, right) => {
			const typeCompare = left.type.localeCompare(right.type);
			return typeCompare === 0 ? left.value.localeCompare(right.value) : typeCompare;
		});
	}

	function demandGroupTraitKeys(traits: ApiBiddingBidBookRow['scope']['traits']): string[] {
		return [...new Set(traits.map((trait) => trait.type))].sort((left, right) =>
			left.localeCompare(right)
		);
	}

	function formatDemandTraits(
		traits: ApiBiddingBidBookRow['scope']['traits'],
		primaryTraitKey: string | null
	): string {
		return sortDemandTraitsForDisplay(traits, primaryTraitKey)
			.map(
				(trait) =>
					`${trimBidBookTraitText(trait.type)}=${trimBidBookTraitText(trait.value)}`
			)
			.join(' + ');
	}

	function sortDemandTraitsForDisplay(
		traits: ApiBiddingBidBookRow['scope']['traits'],
		primaryTraitKey: string | null
	): ApiBiddingBidBookRow['scope']['traits'] {
		if (primaryTraitKey === null) {
			return traits;
		}
		return [...traits].sort((left, right) => {
			const leftPrimary = left.type === primaryTraitKey;
			const rightPrimary = right.type === primaryTraitKey;
			if (leftPrimary !== rightPrimary) {
				return leftPrimary ? -1 : 1;
			}
			const typeCompare = left.type.localeCompare(right.type);
			return typeCompare === 0 ? left.value.localeCompare(right.value) : typeCompare;
		});
	}

	function setActiveDemandTraitKey(nextKey: string | null): void {
		activeDemandTraitKey = nextKey;
	}

	function resolveDemandTraitTabs(groups: BidBookDemandGroup[]): BidBookDemandTraitTab[] {
		const counts = new Map<string, number>();
		for (const group of groups) {
			for (const key of group.traitKeys) {
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}

		const traitTabs = [...counts.entries()]
			.map(([key, count]) => ({ key, label: key, count }))
			.sort((left, right) => {
				if (left.count !== right.count) {
					return right.count - left.count;
				}
				return left.label.localeCompare(right.label);
			});
		return [{ key: null, label: 'All', count: groups.length }, ...traitTabs];
	}

	function resolveDemandTableTabs(tabs: BidBookDemandTraitTab[]): BidBookDemandTableTab[] {
		return tabs.map((tab) => ({
			...tab,
			active: activeDemandTraitKey === tab.key
		}));
	}

	function filterDemandGroupsByTrait(
		groups: BidBookDemandGroup[],
		traitKey: string | null
	): BidBookDemandGroup[] {
		if (traitKey === null) {
			return groups;
		}
		return groups.filter((group) => group.traitKeys.includes(traitKey));
	}

	function resolveRowPrecisionBids(rows: ApiBiddingBidBookRow[]): ApiBiddingBidBookRow[] {
		return rows.filter((bid) => !isMutedBidInRows(rows, bid));
	}

	function resolveDemandPrecisionBids(groups: BidBookDemandGroup[]): ApiBiddingBidBookRow[] {
		return groups.flatMap((group) => activeDemandBids(group));
	}

	function resolvePriceFractionDigits(rows: ApiBiddingBidBookRow[]): number {
		return rows.reduce((maxDigits, bid) => {
			const [, fraction = ''] = bidBookPriceEffectiveEth(bid.price).split('.');
			return Math.max(maxDigits, fraction.replace(/0+$/, '').length);
		}, 2);
	}

	function resolveDecimalBucketStepWei(rows: ApiBiddingBidBookRow[]): bigint | null {
		if (rows.length < 2) {
			return null;
		}
		const maxBid = rows.reduce((max, bid) => {
			const price = bidSortPriceWei(bid);
			return price > bidSortPriceWei(max) ? bid : max;
		}, rows[0]);
		const maxPriceWei = bidSortPriceWei(maxBid);
		if (maxPriceWei > WEI_PER_ETH) {
			return WEI_PER_ETH;
		}
		// Group sub-ETH bids by the second significant digit of the current price magnitude.
		const fractionDigits = resolveBucketFractionDigits(bidBookPriceEffectiveEth(maxBid.price));
		if (fractionDigits === 0) {
			return WEI_PER_ETH;
		}
		const scale = 10n ** BigInt(Math.min(fractionDigits, 18));
		return WEI_PER_ETH / scale;
	}

	function startsNewBidBucket(rows: ApiBiddingBidBookRow[], index: number): boolean {
		return startsNewDisplayedBidSection(rows, index, bidBucketStepWei);
	}

	function startsNewDisplayedBidSection(
		rows: ApiBiddingBidBookRow[],
		index: number,
		stepWei: bigint | null
	): boolean {
		if (
			index > 0 &&
			(isMutedBidInRows(rows, rows[index]) || isMutedBidInRows(rows, rows[index - 1]))
		) {
			return false;
		}
		return startsNewBidBucketWithStep(rows, index, stepWei);
	}

	function startsNewDemandDisplayedBidSection(
		group: BidBookDemandGroup,
		index: number,
		stepWei: bigint | null
	): boolean {
		if (
			index > 0 &&
			(isMutedDemandBid(group, group.bids[index]) ||
				isMutedDemandBid(group, group.bids[index - 1]))
		) {
			return false;
		}
		return startsNewBidBucketWithStep(group.bids, index, stepWei);
	}

	function startsNewBidBucketWithStep(
		rows: ApiBiddingBidBookRow[],
		index: number,
		stepWei: bigint | null
	): boolean {
		if (index === 0 || !stepWei) {
			return false;
		}
		return (
			bidBucketIndex(rows[index], stepWei) !== bidBucketIndex(rows[index - 1], stepWei)
		);
	}

	function isMutedDemandBid(group: BidBookDemandGroup, bid: ApiBiddingBidBookRow): boolean {
		return (
			isMutedBidForBest(group.bestBid, bid) ||
			isMutedBidForMedian(visibleDemandMedianPriceWei, bid)
		);
	}

	function isMutedDemandGroup(group: BidBookDemandGroup): boolean {
		if (group.bids.some((bid) => bid.maker.isOwn)) {
			return false;
		}
		return isMutedBidForMedian(visibleDemandMedianPriceWei, group.bestBid);
	}

	function shouldHideMutedBid(isMuted: boolean): boolean {
		return !showMuted && isMuted;
	}

	function shouldHideDemandGroup(group: BidBookDemandGroup): boolean {
		return shouldHideMutedBid(isMutedDemandGroup(group));
	}

	function shouldShowDemandGroupSpacer(
		groups: BidBookDemandGroup[],
		index: number
	): boolean {
		if (index === 0 || shouldHideDemandGroup(groups[index])) {
			return false;
		}
		return groups.slice(0, index).some((group) => !shouldHideDemandGroup(group));
	}

	function activeDemandBids(group: BidBookDemandGroup): ApiBiddingBidBookRow[] {
		return group.bids.filter((bid) => !isMutedDemandBid(group, bid));
	}

	function activeDemandOfferCount(group: BidBookDemandGroup): number {
		return activeDemandBids(group).length;
	}

	function activeDemandTotalAmountWei(group: BidBookDemandGroup): bigint {
		return activeDemandBids(group).reduce(
			(total, bid) => total + bidSortPriceWei(bid) * parseQuantity(bid.quantity),
			0n
		);
	}

	function activeDemandMakerCount(group: BidBookDemandGroup): number {
		return new Set(activeDemandBids(group).map((bid) => bid.maker.address.toLowerCase())).size;
	}

	function isMutedBidInRows(rows: ApiBiddingBidBookRow[], bid: ApiBiddingBidBookRow): boolean {
		return rows.length > 0 && isMutedBidForBest(rows[0], bid);
	}

	function isMutedBidForBest(
		bestBid: ApiBiddingBidBookRow,
		bid: ApiBiddingBidBookRow
	): boolean {
		if (bid.maker.isOwn) {
			return false;
		}
		const bestPriceWei = bidSortPriceWei(bestBid);
		if (bestPriceWei <= 0n) {
			return false;
		}
		return bidSortPriceWei(bid) * LOW_BID_MUTE_RATIO_DENOMINATOR < bestPriceWei;
	}

	function isMutedBidForMedian(
		medianPriceWei: bigint | null,
		bid: ApiBiddingBidBookRow
	): boolean {
		if (bid.maker.isOwn) {
			return false;
		}
		return medianPriceWei !== null && bidSortPriceWei(bid) * 2n < medianPriceWei;
	}

	function bidBucketIndex(bid: ApiBiddingBidBookRow, stepWei: bigint): bigint {
		return bidSortPriceWei(bid) / stepWei;
	}

	function resolveBucketFractionDigits(priceEth: string): number {
		const [, rawFraction = ''] = priceEth.split('.');
		const fraction = rawFraction.replace(/0+$/, '');
		const firstSignificantIndex = fraction.search(/[1-9]/);
		if (firstSignificantIndex === -1) {
			return 0;
		}
		return Math.min(firstSignificantIndex + 2, fraction.length, 18);
	}

	function bidBookColumnCount(): number {
		return showScope ? 5 : 4;
	}

	function resolveRowsTableRows(rows: ApiBiddingBidBookRow[]): BidBookRowsTableRow[] {
		return rows.map((bid, index) => {
			const placedAt = placedAtMs(bid);
			const validUntil = validUntilMs(bid);
			const bidMuted = isMutedBidInRows(rows, bid);
			return {
				bid,
				price: formatPriceAmount(bid),
				quantityPrefix: formatQuantityPrefix(bid),
				makerHref: makerHref(bid),
				makerHighlighted: isMakerHighlighted(bid),
				placedAtLabel: formatTime(placedAt, placedAtMode),
				placedAtTitle: oppositeTimeTitle(placedAt, placedAtMode),
				validUntilLabel: formatTime(validUntil, validUntilMode),
				validUntilTitle: oppositeTimeTitle(validUntil, validUntilMode),
				muted: bidMuted,
				hidden: shouldHideMutedBid(bidMuted),
				startsNewBucket: startsNewBidBucket(rows, index),
				priceActionLabel: canSelectBidRow(bid) && showRowActions ? rowActionLabel(bid) : null,
				scope: resolveRowsTableScope(bid)
			};
		});
	}

	function resolveRowsTableScope(bid: ApiBiddingBidBookRow): BidBookRowsTableScope {
		if (shouldRenderTraitScopeControls(bid)) {
			const label = traitScopeLabel(bid);
			return {
				kind: BID_BOOK_ROWS_TABLE_SCOPE_KIND.Traits,
				traits: bidScopeDisplayTraits(bid),
				traitValueHref,
				showFilterAction: shouldShowTraitFilterAction(bid.scope.traits),
				filterLabel: `filter ${label}`,
				placeBidLabel: canSelectBidRow(bid) ? placeBidLabel(label) : null
			};
		}
		if (shouldRenderScopeBidControl(bid)) {
			return {
				kind: BID_BOOK_ROWS_TABLE_SCOPE_KIND.PlainAction,
				label: formatScope(bid),
				placeBidLabel: placeBidLabel(scopeActionLabel(bid))
			};
		}
		return {
			kind: BID_BOOK_ROWS_TABLE_SCOPE_KIND.Plain,
			label: formatScope(bid)
		};
	}

	function resolveDemandTableGroups(groups: BidBookDemandGroup[]): BidBookDemandTableGroup[] {
		return groups.map((group, groupIndex) => {
			const groupBucketStepWei = resolveDecimalBucketStepWei(group.bids);
			const activeOfferCount = activeDemandOfferCount(group);
			return {
				key: group.key,
				hidden: shouldHideDemandGroup(group),
				muted: isMutedDemandGroup(group),
				startsNewGroup: shouldShowDemandGroupSpacer(groups, groupIndex),
				traits: demandDisplayTraits(group),
				traitValueHref,
				showFilterAction: shouldShowTraitFilterAction(group.traits),
				filterLabel: `filter ${group.label}`,
				showBidAction: canSelectBidRow(group.bestBid),
				placeBidLabel: placeBidLabel(group.label),
				activeOfferCount,
				totalAmount: formatWeiAmount(
					activeDemandTotalAmountWei(group),
					group.bestBid.currencySymbol
				),
				makerCount: activeDemandMakerCount(group),
				rows: resolveDemandTableRows(group, groupBucketStepWei)
			};
		});
	}

	function resolveDemandTableRows(
		group: BidBookDemandGroup,
		stepWei: bigint | null
	): BidBookDemandTableBidRow[] {
		return group.bids.map((bid, index) => {
			const placedAt = placedAtMs(bid);
			const validUntil = validUntilMs(bid);
			const bidMuted = isMutedDemandBid(group, bid);
			return {
				bid,
				price: formatPriceAmount(bid),
				quantityPrefix: formatQuantityPrefix(bid),
				makerHref: makerHref(bid),
				makerHighlighted: isMakerHighlighted(bid),
				placedAtLabel: formatTime(placedAt, placedAtMode),
				placedAtTitle: oppositeTimeTitle(placedAt, placedAtMode),
				validUntilLabel: formatTime(validUntil, validUntilMode),
				validUntilTitle: oppositeTimeTitle(validUntil, validUntilMode),
				muted: bidMuted,
				hidden: shouldHideMutedBid(bidMuted),
				startsNewBucket: startsNewDemandDisplayedBidSection(group, index, stepWei)
			};
		});
	}

	function parseQuantity(value: string): bigint {
		try {
			const parsed = BigInt(value);
			return parsed > 0n ? parsed : 1n;
		} catch {
			return 1n;
		}
	}

	function shouldShowCurrency(symbol: string | null): boolean {
		return !!symbol && symbol.toUpperCase() !== 'WETH';
	}

	function formatWeiAmount(valueWei: bigint, currencySymbol: string | null): string {
		const value = formatWeiValue(valueWei, priceFractionDigits);
		const currency = shouldShowCurrency(currencySymbol) ? ` ${currencySymbol}` : '';
		return `${value}${currency}`;
	}

	function formatWeiValue(valueWei: bigint, fractionDigits: number): string {
		const digits = Math.max(0, Math.min(fractionDigits, 18));
		if (digits === 18) {
			const integer = valueWei / WEI_PER_ETH;
			const fraction = (valueWei % WEI_PER_ETH).toString().padStart(18, '0');
			return `${integer}.${fraction}`;
		}

		const scale = 10n ** BigInt(18 - digits);
		const roundedWei = ((valueWei + scale / 2n) / scale) * scale;
		const integer = roundedWei / WEI_PER_ETH;
		if (digits === 0) {
			return integer.toString();
		}

		const remainder = roundedWei % WEI_PER_ETH;
		const fraction = (remainder / scale).toString().padStart(digits, '0');
		return `${integer}.${fraction}`;
	}

	function placedAtMs(bid: ApiBiddingBidBookRow): number | null {
		if (!bid.placedAt) return null;
		const parsed = Date.parse(bid.placedAt);
		return Number.isFinite(parsed) ? parsed : null;
	}

	function validUntilMs(bid: ApiBiddingBidBookRow): number | null {
		return bid.validUntil === null ? null : bid.validUntil * 1000;
	}

	function formatTime(valueMs: number | null, mode: BidBookTimeMode): string {
		return formatCompactTime(valueMs, mode, nowMs);
	}

	function oppositeTimeTitle(valueMs: number | null, mode: BidBookTimeMode): string | undefined {
		return oppositeCompactTimeTitle(valueMs, mode, nowMs);
	}

	function togglePlacedAtMode(): void {
		placedAtMode = placedAtMode === 'relative' ? 'absolute' : 'relative';
	}

	function toggleValidUntilMode(): void {
		validUntilMode = validUntilMode === 'relative' ? 'absolute' : 'relative';
	}

	function toggleBidBookExpanded(): void {
		bidBookExpanded = !bidBookExpanded;
	}

</script>

<BidBookMetaBar {bidBook} {position} {showTraitDemandView} {displayedDemandGroupCount} />

{#if visibleBids.length === 0}
	<section class="bid-book-table-panel">
		<p class="muted bid-book-empty">no bids</p>
	</section>
{:else if showTraitDemandView}
	<BidBookTraitDemandTable
		tabs={demandTableTabs}
		groups={demandTableGroups}
		onSetActiveTraitKey={setActiveDemandTraitKey}
		onTogglePlacedAtMode={togglePlacedAtMode}
		onToggleValidUntilMode={toggleValidUntilMode}
		onSelectGroupBid={selectDemandTableGroup}
		onFilterGroup={filterDemandTableGroup}
		onSetHighlighted={setHighlightedDemandRowMaker}
		onClearHighlighted={clearHighlightedMaker}
	/>
{:else}
	<BidBookRowsTable
		rows={rowsTableRows}
		{showScope}
		columnCount={bidBookColumnCount()}
		{hiddenBidCount}
		expanded={bidBookExpanded}
		onTogglePlacedAtMode={togglePlacedAtMode}
		onToggleValidUntilMode={toggleValidUntilMode}
		onToggleExpanded={toggleBidBookExpanded}
		onSelectBid={selectRowsTableBid}
		onFilterTraitBid={filterRowsTableTraitBid}
		onSetHighlighted={setHighlightedRowMaker}
		onClearHighlighted={clearHighlightedMaker}
	/>
{/if}
