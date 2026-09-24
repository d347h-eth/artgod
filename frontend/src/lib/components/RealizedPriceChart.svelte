<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { afterNavigate, pushState } from '$app/navigation';
	import type { Crosshair } from 'klinecharts';
	import {
		PRICE_HISTORY_BUCKET,
		PRICE_HISTORY_RANGE,
		type PriceHistory,
		type PriceHistoryBucket,
		type PriceHistoryRange,
		type RealizedSale
	} from '@artgod/shared/types/price-history';
	import { BackendApiError, getPriceHistory } from '$lib/backend-api';
	import {
		PRICE_CHART_MODE,
		PRICE_CHART_QUERY,
		PRICE_INDICATOR,
		PRICE_INDICATOR_LABEL,
		PRICE_INDICATOR_PARAMETERS,
		defaultPriceIndicators,
		validIndicatorParameters,
		ethText,
		type PriceChartMode,
		type PriceIndicatorKind
	} from '$lib/price-chart/model';
	import type { PriceChartController } from '$lib/price-chart/renderer';

	let {
		chainRef,
		collectionRef,
		tokenId
	}: { chainRef: string; collectionRef: string; tokenId?: string } = $props();
	let bucket = $state<PriceHistoryBucket>(PRICE_HISTORY_BUCKET.Day);
	let range = $state<PriceHistoryRange>(PRICE_HISTORY_RANGE.All);
	let mode = $state<PriceChartMode>(PRICE_CHART_MODE.Candles);
	let element: HTMLDivElement;
	let controller = $state.raw<PriceChartController | null>(null);
	let history = $state.raw<PriceHistory | null>(null);
	let ready = $state(false);
	let loading = $state(true);
	let error = $state('');
	let chartError = $state('');
	let revision = $state(0);
	let indicatorsOpen = $state(false);
	let indicators = $state(defaultPriceIndicators());
	let parameterError = $state('');
	let movingAverageKind = $state<PriceIndicatorKind>(PRICE_INDICATOR.Sma);
	let movingAverageNumber = 0;
	let hoveredSales = $state.raw<RealizedSale[]>([]);
	let hoverPage = $state(0);
	let hoveredBucket = $state<number | null>(null);
	const PAGE_SIZE = 10;
	const panes = $derived(
		indicators.filter(
			(i) => i.enabled && i.kind !== PRICE_INDICATOR.Sma && i.kind !== PRICE_INDICATOR.Ema
		).length
	);
	const bucketsByTime = $derived(new Map(history?.buckets.map((bar) => [bar.timestamp, bar]) ?? []));
	const bucketDetail = $derived(
		hoveredBucket === null ? undefined : bucketsByTime.get(hoveredBucket)
	);

	function choice<T extends string>(value: string | null, values: T[], fallback: T): T {
		return values.includes(value as T) ? (value as T) : fallback;
	}
	function setQuery(key: string, value: string) {
		const url = new URL(window.location.href);
		url.searchParams.set(key, value);
		pushState(url, page.state);
		readQuery(url);
	}
	function readQuery(url: URL) {
		bucket = choice(
			url.searchParams.get(PRICE_CHART_QUERY.Bucket),
			Object.values(PRICE_HISTORY_BUCKET),
			PRICE_HISTORY_BUCKET.Day
		);
		range = choice(
			url.searchParams.get(PRICE_CHART_QUERY.Range),
			Object.values(PRICE_HISTORY_RANGE),
			PRICE_HISTORY_RANGE.All
		);
		mode = choice(
			url.searchParams.get(PRICE_CHART_QUERY.Mode),
			Object.values(PRICE_CHART_MODE),
			PRICE_CHART_MODE.Candles
		);
	}
	afterNavigate(({ to }) => {
		if (to) readQuery(to.url);
	});
	function timestamp(seconds: number) {
		return new Date(seconds * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
	}

	onMount(() => {
		let stopped = false;
		const onPopState = () => readQuery(new URL(window.location.href));
		onPopState();
		window.addEventListener('popstate', onPopState);
		ready = true;
		void import('$lib/price-chart/renderer')
			.then(({ createPriceChart }) => {
				if (stopped) return;
				controller = createPriceChart(element);
				controller.onCrosshair((raw) => {
					const crosshair = raw as Crosshair;
					hoveredBucket = crosshair.kLineData ? crosshair.kLineData.timestamp / 1000 : null;
				});
			})
			.catch((cause) => {
				console.error('Price chart initialization failed', cause);
				chartError = 'Could not open chart. Reload the page.';
			});
		return () => {
			stopped = true;
			window.removeEventListener('popstate', onPopState);
			controller?.dispose();
		};
	});
	$effect(() => {
		if (!ready) return;
		const scope = { chainRef, collectionRef, tokenId, bucket, range, revision };
		const abort = new AbortController();
		loading = true;
		error = '';
		history = null;
		hoveredSales = [];
		hoveredBucket = null;
		void getPriceHistory(
			fetch,
			scope.chainRef,
			scope.collectionRef,
			{
				tokenId: scope.tokenId,
				bucket: scope.bucket as PriceHistoryBucket,
				range: scope.range as PriceHistoryRange
			},
			abort.signal
		)
			.then((result) => {
				if (!abort.signal.aborted) history = result;
			})
			.catch((cause) => {
				if (abort.signal.aborted) return;
				console.error('Price history request failed', cause);
				error =
					cause instanceof BackendApiError && cause.status === 400
						? cause.message
						: 'Could not load sales. Retry.';
			})
			.finally(() => {
				if (!abort.signal.aborted) loading = false;
			});
		return () => abort.abort();
	});
	$effect(() => {
		if (controller && history) controller.setHistory(history);
	});
	$effect(() => {
		controller?.setMode(mode as PriceChartMode);
		hoveredSales = [];
	});
	$effect(() => {
		controller?.setIndicators(indicators);
	});

	function setParameter(id: string, index: number, event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const current = indicators.find((indicator) => indicator.id === id)!;
		const params = current.params.map((n, i) => (i === index ? Number(input.value) : n));
		if (!validIndicatorParameters(current.kind, params)) {
			parameterError =
				current.kind === PRICE_INDICATOR.Macd
					? 'Use whole numbers 1–500; fast must be below slow.'
					: 'Use a whole-number length from 1 to 500.';
			input.value = String(current.params[index]);
			return;
		}
		parameterError = '';
		indicators = indicators.map((indicator) =>
			indicator.id === id ? { ...indicator, params } : indicator
		);
	}
	function hover(event: MouseEvent) {
		if (mode !== PRICE_CHART_MODE.Dots || (event.target as HTMLElement).closest('.sale-inspection'))
			return;
		const sales = controller?.salesAt(event.clientX, event.clientY) ?? [];
		if (
			sales.length &&
			(sales[0]?.id !== hoveredSales[0]?.id || sales.length !== hoveredSales.length)
		) {
			hoveredSales = sales;
			hoverPage = 0;
		}
	}
</script>

<section class="realized-price" aria-label={tokenId === undefined ? 'Collection sale prices' : 'Token sale prices'}>
	<div class="price-toolbar">
		<h2>sale prices · ETH</h2>
		<div class="secondary-tabs" aria-label="Price chart mode">
			{#each Object.values(PRICE_CHART_MODE) as value}
				{#if mode === value}<span class="secondary-tab-active" aria-current="true">{value}</span>
				{:else}<button type="button" class="facet-panel-action-button" onclick={() => setQuery(PRICE_CHART_QUERY.Mode, value)}>{value}</button>{/if}
			{/each}
		</div>
		<label>bucket <select class="bootstrap-control-select" aria-label="Time bucket" value={bucket} onchange={(event) => setQuery(PRICE_CHART_QUERY.Bucket, event.currentTarget.value)}>
			{#each Object.values(PRICE_HISTORY_BUCKET) as value}<option value={value}>{value}</option>{/each}
		</select></label>
		<label>range <select class="bootstrap-control-select" aria-label="History range" value={range} onchange={(event) => setQuery(PRICE_CHART_QUERY.Range, event.currentTarget.value)}>
			{#each Object.values(PRICE_HISTORY_RANGE) as value}<option value={value}>{value}</option>{/each}
		</select></label>
		<button class="facet-panel-action-button" class:facet-collapse-button-active={indicatorsOpen} aria-expanded={indicatorsOpen} onclick={() => indicatorsOpen = !indicatorsOpen}>indicators</button>
		<button class="facet-panel-action-button" disabled={!history?.sales.length || !controller} onclick={() => controller?.fit()}>fit</button>
		<button class="facet-panel-action-button" disabled={loading} onclick={() => revision++}>refresh</button>
	</div>
	{#if indicatorsOpen}
		<div class="price-indicators">
			{#each indicators as indicator (indicator.id)}
				<div class="price-indicator" role="group" aria-label={`${PRICE_INDICATOR_LABEL[indicator.kind]} ${indicator.params.join('/')}`.trim()}>
					<button class="facet-panel-action-button" class:facet-collapse-button-active={indicator.enabled} aria-pressed={indicator.enabled}
						onclick={() => indicators = indicators.map((item) => item.id === indicator.id ? { ...item, enabled: !item.enabled } : item)}>
						{PRICE_INDICATOR_LABEL[indicator.kind]}
					</button>
					{#each PRICE_INDICATOR_PARAMETERS[indicator.kind] as label, index}
						<label>{label.toLowerCase()} <input class="bootstrap-control" type="number" min="1" max="500" step="1"
						    aria-label={`${PRICE_INDICATOR_LABEL[indicator.kind]} ${label}`}
						    value={indicator.params[index]} onchange={(event) => setParameter(indicator.id, index, event)} /></label>
					{/each}
					{#if indicator.kind === PRICE_INDICATOR.Sma || indicator.kind === PRICE_INDICATOR.Ema}
						<button class="facet-panel-action-button facet-reset-button" aria-label={`Remove ${PRICE_INDICATOR_LABEL[indicator.kind]} ${indicator.params[0]}`}
						    onclick={() => indicators = indicators.filter((item) => item.id !== indicator.id)}>remove</button>
					{/if}
				</div>
			{/each}
			<div class="price-indicator">
				<select class="bootstrap-control-select" aria-label="Moving average type" bind:value={movingAverageKind}>
					<option value={PRICE_INDICATOR.Sma}>SMA</option><option value={PRICE_INDICATOR.Ema}>EMA</option>
				</select>
				<button class="facet-panel-action-button" onclick={() => indicators = [...indicators, { id: `ma-added-${++movingAverageNumber}`, kind: movingAverageKind, params: [20], enabled: true }]}>add moving average</button>
			</div>
			<span class="muted">length: populated buckets</span>
			{#if parameterError}<span role="alert">{parameterError}</span>{/if}
		</div>
	{/if}
	{#if loading}<p class="muted" role="status">loading sales…</p>
	{:else if error}<p role="alert">{error} <button class="facet-panel-action-button" onclick={() => revision++}>retry</button></p>
	{:else if history?.sales.length === 0}<p class="muted" role="status">no single-token sales</p>{/if}
	{#if chartError}<p role="alert">{chartError}</p>{/if}
	<div class="price-surface" hidden={loading || !!error || !!chartError || !history?.sales.length}
		onmousemove={hover} role="group" aria-label="Interactive sale price chart">
		<div class="price-canvas" bind:this={element} style:height={`${390 + panes * 110}px`} data-chart-ready={!!controller && !loading}></div>
		<div class="price-readout mono" aria-live="off">
			{#if mode === PRICE_CHART_MODE.Dots && hoveredSales.length}
				<div class="sale-inspection">
					{#each hoveredSales.slice(hoverPage * PAGE_SIZE, (hoverPage + 1) * PAGE_SIZE) as sale (sale.id)}
						<div class="sale-row">
						    <span>{timestamp(sale.timestamp)}</span><span>token #{sale.tokenId}</span>
						    <span>{ethText(sale.priceWei)} {sale.currencySymbol}</span><span title={sale.txHash}>tx {sale.txHash.slice(0, 10)}…</span>
						</div>
					{/each}
					{#if hoveredSales.length > PAGE_SIZE}
						<div class="price-toolbar">
						    <button class="button-link" disabled={hoverPage === 0} onclick={() => hoverPage--}>previous sales</button>
						    <span>{hoverPage * PAGE_SIZE + 1}–{Math.min((hoverPage + 1) * PAGE_SIZE, hoveredSales.length)} of {hoveredSales.length}</span>
						    <button class="button-link" disabled={(hoverPage + 1) * PAGE_SIZE >= hoveredSales.length} onclick={() => hoverPage++}>next sales</button>
						</div>
					{/if}
				</div>
			{:else if bucketDetail}
				<span>{timestamp(bucketDetail.timestamp)} · O {ethText(bucketDetail.openWei)} · H {ethText(bucketDetail.highWei)} · L {ethText(bucketDetail.lowWei)} · C {ethText(bucketDetail.closeWei)} ETH · {bucketDetail.volume} NFTs</span>
			{:else if history}
				<span class="muted">{history.sales.length} sales · UTC</span>
			{/if}
		</div>
	</div>
</section>

<style>
	.realized-price {
		width: min(calc(100% - 1rem), 1100px);
		min-width: 0;
		margin: 1rem auto;
	}
	.price-toolbar,
	.price-indicator {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.55rem;
	}
	.price-toolbar h2 {
		font-size: 0.85rem;
		margin: 0;
		color: var(--c-sand);
	}
	label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.78rem;
		color: var(--c-sand);
	}
	.price-indicators {
		display: grid;
		gap: 0.35rem;
		width: fit-content;
		margin: 0.6rem 0;
	}
	.price-indicator input {
		width: 6ch;
	}
	.price-surface {
		margin-top: 0.5rem;
	}
	.price-canvas {
		width: 100%;
		background: var(--c-bg);
	}
	.price-readout {
		min-height: 2rem;
		font-size: 0.75rem;
		color: var(--c-ice);
		padding-top: 0.3rem;
		overflow-wrap: anywhere;
	}
	.sale-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.65rem;
		padding: 0.15rem 0;
	}
	.sale-inspection {
		max-height: 13rem;
		overflow: auto;
	}
</style>
