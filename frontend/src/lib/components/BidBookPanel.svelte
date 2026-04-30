<script lang="ts">
	import type { ApiBiddingBidBook, ApiBiddingBidBookRow, ApiBiddingJob } from '$lib/api-types';
	import { buildOwnerTokensHref } from '$lib/token-browser-query';
	import { joinPath } from '$lib/route-paths';

	type BidBookTimeMode = 'relative' | 'absolute';

	const WEI_PER_ETH = 1_000_000_000_000_000_000n;

	let {
		bidBook,
		job = null,
		showScope = false,
		basePath = '/',
		mediaMode = null
	}: {
		bidBook: ApiBiddingBidBook;
		job?: ApiBiddingJob | null;
		showScope?: boolean;
		basePath?: string;
		mediaMode?: string | null;
	} = $props();

	let placedAtMode = $state<BidBookTimeMode>('relative');
	let validUntilMode = $state<BidBookTimeMode>('relative');
	let bidBookExpanded = $state(false);
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
	const priceFractionDigits = $derived(resolvePriceFractionDigits(visibleBids));
	const bidBucketStepWei = $derived(resolveDecimalBucketStepWei(displayedBids));

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

	function formatPrice(bid: ApiBiddingBidBookRow): string {
		const price = formatUnitPrice(bid);
		const quantity = parseQuantity(bid.quantity);
		const prefix = quantity > 1n ? `${quantity}x ` : '';
		const currency = shouldShowCurrency(bid.currencySymbol) ? ` ${bid.currencySymbol}` : '';
		return `${prefix}${price}${currency}`;
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

	function makerHref(bid: ApiBiddingBidBookRow): string {
		return buildOwnerTokensHref({
			basePath: joinPath(basePath, `holders/${encodeURIComponent(bid.maker.address)}`),
			selectedTraits: [],
			selectedTraitRanges: [],
			mediaMode
		});
	}

	function formatUnitPrice(bid: ApiBiddingBidBookRow): string {
		const [integer, fraction = ''] = bid.priceEth.split('.');
		return `${integer}.${fraction.padEnd(priceFractionDigits, '0')}`;
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
		if (index === 0 || !bidBucketStepWei) {
			return false;
		}
		return (
			bidBucketIndex(rows[index], bidBucketStepWei) !==
			bidBucketIndex(rows[index - 1], bidBucketStepWei)
		);
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
		const projectedAt = bidBook.state.projectedAt;
		if (projectedAt) {
			const projectedAtMs = Date.parse(projectedAt);
			return Number.isFinite(projectedAtMs) ? formatRfc3339(projectedAtMs) : projectedAt;
		}
		const snapshotAt = bidBook.state.snapshotRefreshedAtMs;
		if (snapshotAt !== null) {
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
		<div>
			<span class="runtime-k">updated</span>
			<span class="runtime-v mono">{formatFreshness()}</span>
		</div>
		{#if bidBook.state.durationMs !== null}
			<div>
				<span class="runtime-k">projection</span>
				<span class="runtime-v">{bidBook.state.durationMs}ms</span>
			</div>
		{/if}
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
						{#if startsNewBidBucket(displayedBids, index)}
							<tr class="bid-book-bucket-spacer" aria-hidden="true">
								<td colspan={bidBookColumnCount()}></td>
							</tr>
						{/if}
						<tr class:bid-book-own-row={bid.maker.isOwn}>
								<td class="mono bid-book-price bid-book-col-right">{formatPrice(bid)}</td>
								{#if showScope}
									<td class="bid-book-col-center">
										<span class="bid-book-scope-label">{formatScope(bid)}</span>
									</td>
								{/if}
							<td class="mono bid-book-maker-cell bid-book-col-center">
								<a href={makerHref(bid)}>{bid.maker.address}</a>
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
