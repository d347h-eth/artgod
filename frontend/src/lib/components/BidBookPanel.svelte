<script lang="ts">
	import type {
		ApiBiddingBidBook,
		ApiBiddingBidBookRow,
		ApiBiddingJob,
		ApiTradingTraitCriterion
	} from '$lib/api-types';
	import { joinPath } from '$lib/route-paths';
	import { buildOwnerTokensHref } from '$lib/token-browser-query';

	type BidBookTimeMode = 'relative' | 'absolute';
	type BidBookPanelView = 'rows' | 'trait-demand';
	type TraitFilterValue = {
		key: string;
		value: string;
	};
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
	type OwnBidStatusBadge = {
		kind: 'winning' | 'draw' | 'losing' | 'ceiling' | 'floor';
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
		traitValueHref?: ((trait: TraitFilterValue) => string) | null;
		makerFilterHref?: ((makerAddress: string) => string) | null;
		makerBidHref?: ((bid: ApiBiddingBidBookRow) => string) | null;
		onSelectBid?: ((bid: ApiBiddingBidBookRow) => void) | null;
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
	const hiddenBidCount = $derived(Math.max(visibleBids.length - collapsedBidCount, 0));
	const displayedBids = $derived(
		bidBookExpanded ? visibleBids : visibleBids.slice(0, collapsedBidCount)
	);
	const ownBid = $derived(bestBid(visibleBids, (bid) => bid.maker.isOwn));
	const opponentBid = $derived(bestBid(visibleBids, (bid) => !bid.maker.isOwn));
	const position = $derived(resolvePosition(job, ownBid, opponentBid));
	const demandGroups = $derived(resolveDemandGroups(visibleBids));
	const demandTraitTabs = $derived(resolveDemandTraitTabs(demandGroups));
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
		const leftPrice = BigInt(left.priceWei);
		const rightPrice = BigInt(right.priceWei);
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
		const maxPrice = BigInt(rows[0].priceWei);
		const minPrice = BigInt(rows[rows.length - 1].priceWei);
		if (maxPrice === minPrice) {
			return rows.length;
		}
		// Collapse the bottom half of the visible price range, not the bottom half of row count.
		const cutoffPrice = minPrice + (maxPrice - minPrice) / 2n;
		const firstHiddenIndex = rows.findIndex((bid) => BigInt(bid.priceWei) < cutoffPrice);
		return firstHiddenIndex === -1 ? rows.length : Math.max(firstHiddenIndex, 1);
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
		if (!bestOpponent || BigInt(bestOwn.priceWei) >= BigInt(bestOpponent.priceWei)) {
			return 'winning';
		}
		return 'outbid';
	}

	function sourceLabel(source: ApiBiddingBidBook['state']['source']): string {
		return source === 'bot_snapshot' ? 'competitive' : 'normal';
	}

	function sourceTitle(source: ApiBiddingBidBook['state']['source']): string {
		const pace = source === 'bot_snapshot' ? 'competitive' : 'normal';
		return `The bid book is refreshed at a ${pace} pace using periodic order book polling and immediate updates from the inbound event stream.`;
	}

	function formatPriceAmount(bid: ApiBiddingBidBookRow): string {
		const price = formatUnitPrice(bid);
		const currency = shouldShowCurrency(bid.currencySymbol) ? ` ${bid.currencySymbol}` : '';
		return `${price}${currency}`;
	}

	function formatQuantityPrefix(bid: ApiBiddingBidBookRow): string | null {
		const quantity = parseQuantity(bid.quantity);
		return quantity > 1n ? `${quantity}x` : null;
	}

	function formatScope(bid: ApiBiddingBidBookRow): string {
		if (bid.scope.kind === 'collection') {
			return 'C';
		}
		if (bid.scope.kind === 'token' && bid.scope.tokenId) {
			return `#${bid.scope.tokenId}`;
		}
		return trimText(bid.scope.label);
	}

	function demandDisplayTraits(
		group: BidBookDemandGroup
	): ApiBiddingBidBookRow['scope']['traits'] {
		return sortDemandTraitsForDisplay(group.traits, activeDemandTraitKey);
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

	function makerDisplayLabel(bid: ApiBiddingBidBookRow): string {
		return bid.maker.isOwn ? bid.maker.label : bid.maker.address;
	}

	function makerTitle(bid: ApiBiddingBidBookRow): string | undefined {
		return bid.maker.isOwn ? bid.maker.address : undefined;
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

	function selectBid(bid: ApiBiddingBidBookRow): void {
		onSelectBid?.(bid);
	}

	function placeBidLabel(label: string): string {
		return `place bid on ${label}`;
	}

	function ownBidStatusBadges(
		rows: ApiBiddingBidBookRow[],
		bid: ApiBiddingBidBookRow
	): OwnBidStatusBadge[] {
		if (!bid.maker.isOwn) {
			return [];
		}
		const badges: OwnBidStatusBadge[] = [resolveOwnBidPositionBadge(rows, bid)];
		const constraint = resolveOwnBidConstraintBadge(bid);
		if (constraint) {
			badges.push(constraint);
		}
		return badges;
	}

	function resolveOwnBidPositionBadge(
		rows: ApiBiddingBidBookRow[],
		bid: ApiBiddingBidBookRow
	): OwnBidStatusBadge {
		const ownPrice = BigInt(bid.priceWei);
		const bestOpponent = bestBid(rows, (row) => !row.maker.isOwn);
		if (!bestOpponent || ownPrice > BigInt(bestOpponent.priceWei)) {
			return { kind: 'winning', label: 'winning' };
		}
		if (ownPrice === BigInt(bestOpponent.priceWei)) {
			return { kind: 'draw', label: 'draw' };
		}
		return { kind: 'losing', label: 'losing' };
	}

	function resolveOwnBidConstraintBadge(bid: ApiBiddingBidBookRow): OwnBidStatusBadge | null {
		if (!job || !bidMatchesJobTarget(bid, job)) {
			return null;
		}
		const priceWei = BigInt(bid.priceWei);
		const ceilingWei = parseEthToWei(job.config.ceilingEth);
		if (ceilingWei !== null && priceWei >= ceilingWei) {
			return { kind: 'ceiling', label: 'ceiling' };
		}
		const floorWei = parseEthToWei(job.config.floorEth);
		if (floorWei !== null && priceWei <= floorWei) {
			return { kind: 'floor', label: 'floor' };
		}
		return null;
	}

	function bidMatchesJobTarget(bid: ApiBiddingBidBookRow, currentJob: ApiBiddingJob): boolean {
		if (currentJob.target.type === 'token') {
			return bid.scope.kind === 'token' && bid.scope.tokenId === currentJob.target.tokenId;
		}
		if (currentJob.target.type === 'collection') {
			return traitsEqual(bid.scope.traits, currentJob.target.targetTraits);
		}
		return traitsEqual(bid.scope.traits, currentJob.target.targetTraits);
	}

	function traitsEqual(
		left: ApiBiddingBidBookRow['scope']['traits'],
		right: ApiTradingTraitCriterion[]
	): boolean {
		const leftKey = canonicalTraitKey(left);
		const rightKey = canonicalTraitKey(right);
		return leftKey === rightKey;
	}

	function canonicalTraitKey(traits: ApiBiddingBidBookRow['scope']['traits']): string {
		return [...traits]
			.sort((left, right) => {
				const typeCompare = left.type.localeCompare(right.type);
				return typeCompare === 0 ? left.value.localeCompare(right.value) : typeCompare;
			})
			.map((trait) => `${trait.type}\u0000${trait.value}`)
			.join('\u0001');
	}

	function parseEthToWei(value: string): bigint | null {
		const trimmed = value.trim();
		if (!/^\d+(\.\d+)?$/.test(trimmed)) {
			return null;
		}
		const [integer, fraction = ''] = trimmed.split('.');
		if (fraction.length > 18) {
			return null;
		}
		return BigInt(integer) * WEI_PER_ETH + BigInt(fraction.padEnd(18, '0'));
	}

	function formatUnitPrice(bid: ApiBiddingBidBookRow): string {
		return formatWeiValue(BigInt(bid.priceWei), priceFractionDigits);
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
						(total, bid) => total + BigInt(bid.priceWei) * parseQuantity(bid.quantity),
						0n
					),
					traitKeys: demandGroupTraitKeys(traits)
				};
			})
			.sort(compareDemandGroups);
	}

	function resolveMedianBidPriceWei(groups: BidBookDemandGroup[]): bigint | null {
		const prices = groups
			.flatMap((group) => group.bids.map((bid) => BigInt(bid.priceWei)))
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
			.map((trait) => `${trimText(trait.type)}=${trimText(trait.value)}`)
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
			const [, fraction = ''] = bid.priceEth.split('.');
			return Math.max(maxDigits, fraction.replace(/0+$/, '').length);
		}, 2);
	}

	function resolveDecimalBucketStepWei(rows: ApiBiddingBidBookRow[]): bigint | null {
		if (rows.length < 2) {
			return null;
		}
		const maxBid = rows.reduce((max, bid) => {
			const price = BigInt(bid.priceWei);
			return price > BigInt(max.priceWei) ? bid : max;
		}, rows[0]);
		const maxPriceWei = BigInt(maxBid.priceWei);
		if (maxPriceWei > WEI_PER_ETH) {
			return WEI_PER_ETH;
		}
		// Group sub-ETH bids by the second significant digit of the current price magnitude.
		const fractionDigits = resolveBucketFractionDigits(maxBid.priceEth);
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
			(total, bid) => total + BigInt(bid.priceWei) * parseQuantity(bid.quantity),
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
		const bestPriceWei = BigInt(bestBid.priceWei);
		if (bestPriceWei <= 0n) {
			return false;
		}
		return BigInt(bid.priceWei) * LOW_BID_MUTE_RATIO_DENOMINATOR < bestPriceWei;
	}

	function isMutedBidForMedian(
		medianPriceWei: bigint | null,
		bid: ApiBiddingBidBookRow
	): boolean {
		return medianPriceWei !== null && BigInt(bid.priceWei) * 2n < medianPriceWei;
	}

	function bidBucketIndex(bid: ApiBiddingBidBookRow, stepWei: bigint): bigint {
		return BigInt(bid.priceWei) / stepWei;
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
		if (valueMs === null) return '-';
		if (mode === 'absolute') return formatRfc3339(valueMs);
		return formatRelativeTime(valueMs);
	}

	function oppositeTimeTitle(valueMs: number | null, mode: BidBookTimeMode): string | undefined {
		if (valueMs === null) return undefined;
		return mode === 'relative' ? formatRfc3339(valueMs) : formatRelativeTime(valueMs);
	}

	function formatRfc3339(valueMs: number): string {
		return new Date(valueMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
	}

	function formatRelativeTime(valueMs: number): string {
		const diffSeconds = Math.round((valueMs - nowMs) / 1000);
		const absoluteSeconds = Math.abs(diffSeconds);
		if (absoluteSeconds < 5) return 'now';
		if (absoluteSeconds < 60) return `${absoluteSeconds}s`;
		if (absoluteSeconds < 3600) return `${Math.floor(absoluteSeconds / 60)}m`;
		if (absoluteSeconds < 86_400) return `${Math.floor(absoluteSeconds / 3600)}h`;
		return `${Math.floor(absoluteSeconds / 86_400)}d`;
	}

	function timeModeLabel(mode: BidBookTimeMode): string {
		return mode === 'relative' ? 'rel' : 'abs';
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

	function trimText(value: string): string {
		const maxLength = 96;
		const trimmed = value.trim();
		return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3)}...`;
	}

	function formatFreshness(): string {
		const updatedAt = bidBook.state.updatedAt;
		if (updatedAt) {
			const updatedAtMs = Date.parse(updatedAt);
			return Number.isFinite(updatedAtMs) ? formatRfc3339(updatedAtMs) : updatedAt;
		}
		const snapshotAt = bidBook.state.snapshotRefreshedAtMs;
		if (bidBook.state.source === 'bot_snapshot' && snapshotAt !== null) {
			return formatRfc3339(snapshotAt);
		}
		return '-';
	}

</script>

<section class="runtime-section bid-book-summary-panel">
	<div class="runtime-kv-grid bid-book-meta">
		<div>
			<span class="runtime-k">bids source</span>
			<span class="runtime-v" title={sourceTitle(bidBook.state.source)}>
				{sourceLabel(bidBook.state.source)}
			</span>
		</div>
		<div>
			<span class="runtime-k">rows</span>
			<span class="runtime-v">{bidBook.state.rowCount}</span>
		</div>
		{#if showTraitDemandView}
			<div>
				<span class="runtime-k">targets</span>
				<span class="runtime-v">{displayedDemandGroupCount}</span>
			</div>
		{/if}
		<div>
			<span class="runtime-k">updated</span>
			<span class="runtime-v mono">{formatFreshness()}</span>
		</div>
		{#if position}
			<div>
				<span class="runtime-k">position</span>
				<span class="runtime-v">{position}</span>
			</div>
		{/if}
	</div>

	{#if bidBook.state.lastError}
		<p class="runtime-error bid-book-error" role="alert">{bidBook.state.lastError}</p>
	{/if}
</section>

{#if visibleBids.length === 0}
	<section class="bid-book-table-panel">
		<p class="muted bid-book-empty">no bids</p>
	</section>
{:else if showTraitDemandView}
	<section class="bid-book-table-panel">
		{#if demandTraitTabs.length > 1}
			<div class="secondary-tabs bid-book-demand-tabs" aria-label="Bid trait buckets">
				{#each demandTraitTabs as tab (tab.key ?? 'all')}
					{#if activeDemandTraitKey === tab.key}
						<span class="secondary-tab-active">{tab.label} [{tab.count}]</span>
					{:else}
						<button type="button" onclick={() => setActiveDemandTraitKey(tab.key)}>
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
							<span>placed</span>
							<button
								type="button"
								class="activities-time-mode-button"
								aria-label="toggle placed-at time mode"
								onclick={togglePlacedAtMode}
							>
								{timeModeLabel(placedAtMode)}
							</button>
						</th>
						<th class="bid-book-time-header bid-book-col-center">
							<span>valid</span>
							<button
								type="button"
								class="activities-time-mode-button"
								aria-label="toggle valid-until time mode"
								onclick={toggleValidUntilMode}
							>
								{timeModeLabel(validUntilMode)}
							</button>
						</th>
					</tr>
				</thead>
				<tbody>
					{#each visibleDemandGroups as group, groupIndex (group.key)}
						{@const groupBucketStepWei = resolveDecimalBucketStepWei(group.bids)}
						{@const groupActiveOfferCount = activeDemandOfferCount(group)}
						{#if shouldShowDemandGroupSpacer(visibleDemandGroups, groupIndex)}
							<tr class="bid-book-demand-group-spacer" aria-hidden="true">
								<td colspan={4}></td>
							</tr>
						{/if}
						<tr
							class="bid-book-demand-group-row"
							class:bid-book-muted-demand-group={isMutedDemandGroup(group)}
							hidden={shouldHideDemandGroup(group)}
						>
							<td colspan={4}>
								<div class="bid-book-demand-group-header">
									<span class="bid-book-demand-group-title">
										<span class="bid-book-demand-trait-list">
											{#each demandDisplayTraits(group) as trait, traitIndex (`${trait.type}:${trait.value}`)}
												<span class="bid-book-demand-trait-entry">
													{#if traitIndex > 0}
														<span class="bid-book-demand-trait-separator">+</span>
													{/if}
													<span class="bid-book-demand-trait">
														<span class="bid-book-demand-trait-key">{trimText(trait.type)}</span>
														<span class="bid-book-demand-trait-equals">=</span>
														{#if traitValueHref}
															<a
																class="bid-book-demand-trait-value-link"
																href={traitValueHref({
																	key: trait.type,
																	value: trait.value
																})}
															>
																{trimText(trait.value)}
															</a>
														{:else}
															<span class="bid-book-demand-trait-value">{trimText(trait.value)}</span>
														{/if}
													</span>
												</span>
											{/each}
										</span>
									</span>
									{#if groupActiveOfferCount > 1}
										<div class="runtime-kv-grid bid-book-demand-group-meta">
											<div>
												<span class="runtime-k">total</span>
												<span class="runtime-v mono bid-book-price">
													{formatWeiAmount(
														activeDemandTotalAmountWei(group),
														group.bestBid.currencySymbol
													)}
												</span>
											</div>
											<div>
												<span class="runtime-k">offers</span>
												<span class="runtime-v mono">{groupActiveOfferCount}</span>
											</div>
											<div>
												<span class="runtime-k">makers</span>
												<span class="runtime-v mono">{activeDemandMakerCount(group)}</span>
											</div>
										</div>
									{/if}
									{#if onSelectBid}
										<button
											type="button"
											class="button-link bid-book-place-bid-icon-button"
											aria-label={placeBidLabel(group.label)}
											title={placeBidLabel(group.label)}
											onclick={() => selectBid(group.bestBid)}
										>
											<svg
												class="bid-book-place-bid-icon"
												viewBox="0 0 16 16"
												aria-hidden="true"
												focusable="false"
											>
												<path d="M3 8h8M8 5l3 3-3 3M4 13h9V3" />
											</svg>
										</button>
									{/if}
								</div>
							</td>
						</tr>
						{#each group.bids as bid, index (bid.orderId)}
							{@const placedAt = placedAtMs(bid)}
							{@const validUntil = validUntilMs(bid)}
							{@const bidMuted = isMutedDemandBid(group, bid)}
							{@const quantityPrefix = formatQuantityPrefix(bid)}
							{@const ownBadges = ownBidStatusBadges(group.bids, bid)}
							{#if startsNewDemandDisplayedBidSection(group, index, groupBucketStepWei)}
								<tr class="bid-book-bucket-spacer" aria-hidden="true">
									<td colspan={4}></td>
								</tr>
							{/if}
							<tr
								class:bid-book-own-row={bid.maker.isOwn}
								class:bid-book-muted-row={bidMuted}
								hidden={shouldHideMutedBid(bidMuted)}
							>
								<td class="mono bid-book-price bid-book-col-right">
									<span hidden data-open-sea-order-hash={bid.orderId}></span>
									<span class="bid-book-price-value">
										<span
											class="bid-book-price-quantity"
											class:bid-book-price-quantity-empty={quantityPrefix === null}
										>
											{quantityPrefix ?? ''}
										</span>
										<span class="bid-book-price-amount">{formatPriceAmount(bid)}</span>
									</span>
								</td>
								<td class="mono bid-book-maker-cell bid-book-col-center">
									<a
										href={makerHref(bid)}
										class:bid-book-maker-highlight={isMakerHighlighted(bid)}
										onpointerenter={() => setHighlightedMaker(bid)}
										onpointerleave={clearHighlightedMaker}
										onfocus={() => setHighlightedMaker(bid)}
										onblur={clearHighlightedMaker}
										title={makerTitle(bid)}
									>
										{makerDisplayLabel(bid)}
									</a>
									{#each ownBadges as badge (`${badge.kind}:${badge.label}`)}
										<span class={`bid-book-own-status bid-book-own-status-${badge.kind}`}>
											{badge.label}
										</span>
									{/each}
								</td>
								<td class="mono bid-book-col-center" title={oppositeTimeTitle(placedAt, placedAtMode)}>
									{formatTime(placedAt, placedAtMode)}
								</td>
								<td class="mono bid-book-col-center" title={oppositeTimeTitle(validUntil, validUntilMode)}>
									{formatTime(validUntil, validUntilMode)}
								</td>
							</tr>
						{/each}
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{:else}
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
							<span>placed</span>
							<button
								type="button"
								class="activities-time-mode-button"
								aria-label="toggle placed-at time mode"
								onclick={togglePlacedAtMode}
							>
								{timeModeLabel(placedAtMode)}
							</button>
						</th>
						<th class="bid-book-time-header bid-book-col-center">
							<span>valid</span>
							<button
								type="button"
								class="activities-time-mode-button"
								aria-label="toggle valid-until time mode"
								onclick={toggleValidUntilMode}
							>
								{timeModeLabel(validUntilMode)}
							</button>
						</th>
					</tr>
				</thead>
				<tbody>
					{#each displayedBids as bid, index (bid.orderId)}
						{@const placedAt = placedAtMs(bid)}
						{@const validUntil = validUntilMs(bid)}
						{@const bidMuted = isMutedBidInRows(displayedBids, bid)}
						{@const quantityPrefix = formatQuantityPrefix(bid)}
						{@const ownBadges = ownBidStatusBadges(displayedBids, bid)}
						{#if startsNewBidBucket(displayedBids, index) && !shouldHideMutedBid(bidMuted)}
							<tr class="bid-book-bucket-spacer" aria-hidden="true">
								<td colspan={bidBookColumnCount()}></td>
							</tr>
						{/if}
						<tr
							class:bid-book-own-row={bid.maker.isOwn}
							class:bid-book-muted-row={bidMuted}
							hidden={shouldHideMutedBid(bidMuted)}
						>
							<td class="mono bid-book-price bid-book-col-right">
								<span hidden data-open-sea-order-hash={bid.orderId}></span>
								<span class="bid-book-price-value">
									<span
										class="bid-book-price-quantity"
										class:bid-book-price-quantity-empty={quantityPrefix === null}
									>
										{quantityPrefix ?? ''}
									</span>
									<span class="bid-book-price-amount">{formatPriceAmount(bid)}</span>
								</span>
								{#if onSelectBid && showRowActions}
									<button
										type="button"
										class="button-link bid-book-row-action"
										onclick={() => selectBid(bid)}
									>
										use
									</button>
								{/if}
							</td>
							{#if showScope}
								<td class="bid-book-col-center">
									<span class="bid-book-scope-label">{formatScope(bid)}</span>
								</td>
							{/if}
							<td class="mono bid-book-maker-cell bid-book-col-center">
								<a
									href={makerHref(bid)}
									class:bid-book-maker-highlight={isMakerHighlighted(bid)}
									onpointerenter={() => setHighlightedMaker(bid)}
									onpointerleave={clearHighlightedMaker}
									onfocus={() => setHighlightedMaker(bid)}
									onblur={clearHighlightedMaker}
									title={makerTitle(bid)}
								>
									{makerDisplayLabel(bid)}
								</a>
								{#each ownBadges as badge (`${badge.kind}:${badge.label}`)}
									<span class={`bid-book-own-status bid-book-own-status-${badge.kind}`}>
										{badge.label}
									</span>
								{/each}
							</td>
							<td class="mono bid-book-col-center" title={oppositeTimeTitle(placedAt, placedAtMode)}>
								{formatTime(placedAt, placedAtMode)}
							</td>
							<td class="mono bid-book-col-center" title={oppositeTimeTitle(validUntil, validUntilMode)}>
								{formatTime(validUntil, validUntilMode)}
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
					onclick={toggleBidBookExpanded}
				>
					{bidBookExpanded ? 'collapse' : `expand ${hiddenBidCount}`}
				</button>
			</div>
		{/if}
	</section>
{/if}
