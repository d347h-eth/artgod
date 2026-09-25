<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { afterNavigate, pushState } from '$app/navigation';
	import {
		PRICE_HISTORY_BUCKET,
		PRICE_HISTORY_RANGE,
		type PriceHistory,
		type PriceHistoryBucket,
		type PriceHistoryRange,
		type RealizedSale
	} from '@artgod/shared/types/price-history';
	import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
	import type { ApiChain, ApiCollection, ApiCollectionMediaState } from '$lib/api-types';
	import type { BlockExplorerConfig } from '@artgod/shared/config/block-explorer';
	import { BackendApiError, getPriceHistory, getTokenCard } from '$lib/backend-api';
	import { buildTokenMediaQuery } from '$lib/media-mode';
	import { COLLECTION_CHART_TOKEN_QUERY } from '$lib/price-chart/routing';
	import {
		PRICE_CHART_QUERY,
		PRICE_INDICATOR,
		PRICE_INDICATOR_LABEL,
		PRICE_INDICATOR_PARAMETERS,
		defaultPriceIndicators,
		validIndicatorParameters,
		type PriceIndicatorKind
	} from '$lib/price-chart/model';
	import {
		createSaleMediaLoader,
		type SaleMediaLoader,
		type SalePreviewTarget
	} from '$lib/price-chart/media';
	import type { PriceChartController } from '$lib/price-chart/renderer';
	import SaleHistorySidebar from './SaleHistorySidebar.svelte';
	import SaleCardPreview from './SaleCardPreview.svelte';

	let {
		chain,
		collection,
		media,
		basePath,
		blockExplorer
	}: {
		chain: ApiChain;
		collection: ApiCollection;
		media: ApiCollectionMediaState;
		basePath: string;
		blockExplorer: BlockExplorerConfig;
	} = $props();
	const chainRef = $derived(chain.slug),
		collectionRef = $derived(collection.slug);
	let bucket = $state<PriceHistoryBucket>(PRICE_HISTORY_BUCKET.Day);
	let range = $state<PriceHistoryRange>(PRICE_HISTORY_RANGE.All);
	let tokenId = $state<string | undefined>();
	let root: HTMLElement;
	let element: HTMLDivElement;
	let height = $state(600);
	let controller = $state.raw<PriceChartController | null>(null);
	let loader = $state.raw<SaleMediaLoader | null>(null);
	let history = $state.raw<PriceHistory | null>(null);
	let ready = $state(false),
		loading = $state(true);
	let error = $state(''),
		chartError = $state('');
	let revision = $state(0),
		indicatorsOpen = $state(false);
	let indicators = $state(defaultPriceIndicators()),
		parameterError = $state('');
	let movingAverageKind = $state<PriceIndicatorKind>(PRICE_INDICATOR.Sma);
	let movingAverageNumber = 0;
	let hoveredSales = $state.raw<RealizedSale[]>([]);
	let pinnedSales = $state.raw<RealizedSale[]>([]);
	let preview = $state.raw<SalePreviewTarget | null>(null);
	let pinnedPreview = $state.raw<SalePreviewTarget | null>(null);
	let sidebarPreview = $state.raw<SalePreviewTarget | null>(null);
	let press: { x: number; y: number } | null = null;
	const recentSales = $derived(history ? [...history.sales].reverse() : []);
	const sidebarSales = $derived(
		pinnedSales.length ? pinnedSales : hoveredSales.length ? hoveredSales : recentSales
	);

	function choice<T extends string>(value: string | null, values: T[], fallback: T): T {
		return values.includes(value as T) ? (value as T) : fallback;
	}
	function setQuery(key: string, value: string | null) {
		const url = new URL(window.location.href);
		if (value === null) url.searchParams.delete(key);
		else url.searchParams.set(key, value);
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
		tokenId = url.searchParams.get(COLLECTION_CHART_TOKEN_QUERY) || undefined;
	}
	afterNavigate(({ to }) => {
		if (to) readQuery(to.url);
	});

	onMount(() => {
		let stopped = false;
		const onPopState = () => readQuery(new URL(window.location.href));
		const measure = () => {
			height = Math.max(
				240,
				(window.visualViewport?.height ?? window.innerHeight) - root.getBoundingClientRect().top - 12
			);
		};
		onPopState();
		measure();
		window.addEventListener('popstate', onPopState);
		window.addEventListener('resize', measure);
		window.visualViewport?.addEventListener('resize', measure);
		const observer = new ResizeObserver(measure);
		observer.observe(root.parentElement!);
		ready = true;
		void import('$lib/price-chart/renderer')
			.then(({ createPriceChart }) => {
				if (!stopped) controller = createPriceChart(element);
			})
			.catch((cause) => {
				console.error('Price chart initialization failed', cause);
				chartError = 'Could not open chart. Reload the page.';
			});
		return () => {
			stopped = true;
			observer.disconnect();
			window.removeEventListener('popstate', onPopState);
			window.removeEventListener('resize', measure);
			window.visualViewport?.removeEventListener('resize', measure);
			controller?.dispose();
		};
	});
	$effect(() => {
		if (!ready) return;
		const chain = chainRef,
			collection = collectionRef;
		const query = buildTokenMediaQuery({
			mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			mediaPreference: media.preference,
			mediaVariant: null
		});
		revision; // Refresh the current ask and card presentation with the history.
		const instance = createSaleMediaLoader(
			async (id, signal) => (await getTokenCard(fetch, chain, collection, id, query, signal)).token
		);
		loader = instance;
		return () => instance.dispose();
	});
	$effect(() => {
		if (!ready) return;
		const scope = { chainRef, collectionRef, tokenId, bucket, range, revision };
		const abort = new AbortController();
		loading = true;
		error = '';
		history = null;
		hoveredSales = [];
		pinnedSales = [];
		pinnedPreview = null;
		preview = null;
		sidebarPreview = null;
		void getPriceHistory(
			fetch,
			scope.chainRef,
			scope.collectionRef,
			{ tokenId: scope.tokenId, bucket: scope.bucket, range: scope.range },
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
		controller?.setIndicators(indicators);
	});
	$effect(() => {
		controller?.setSelection(pinnedSales);
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
	function leaveChart() {
		hoveredSales = [];
		preview = null;
	}
	function clearPin() {
		pinnedSales = [];
		pinnedPreview = null;
		leaveChart();
	}
	function hover(event: MouseEvent) {
		if (event.buttons) {
			leaveChart();
			return;
		}
		const sales = controller?.salesAt(event.clientX, event.clientY) ?? [];
		if (
			sales.length !== hoveredSales.length ||
			sales.some((sale, i) => sale.id !== hoveredSales[i]?.id)
		)
			hoveredSales = sales;
		preview = sales.length ? { tokenId: sales[0].tokenId, x: event.clientX, y: event.clientY } : null;
	}
	function pin(event: MouseEvent) {
		// A completed pan must never turn its release point into a selection.
		const start = press;
		press = null;
		if (
			!start ||
			event.button !== 0 ||
			Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
		)
			return;
		const sales = controller?.salesAt(event.clientX, event.clientY) ?? [];
		if (!sales.length) return clearPin();
		const pinnedIds = new Set(pinnedSales.map((sale) => sale.id));
		const same = sales.length === pinnedSales.length && sales.every((sale) => pinnedIds.has(sale.id));
		if (same) return clearPin();
		pinnedSales = sales;
		pinnedPreview = { tokenId: sales[0].tokenId, x: event.clientX, y: event.clientY };
		preview = null;
	}
</script>

<section class="realized-price" bind:this={root} style:height={height + 'px'} aria-label={tokenId === undefined ? 'Collection sale prices' : 'Token sale prices'}>
	<div class="price-toolbar">
		{#if tokenId}<span class="muted">token #{tokenId}</span><button class="facet-panel-action-button" onclick={() => setQuery(COLLECTION_CHART_TOKEN_QUERY, null)}>all tokens</button>{/if}
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
	<div class="price-workspace" hidden={loading || !!error || !!chartError || !history?.sales.length}>
		<div class="price-canvas" bind:this={element} data-chart-ready={!!controller && !loading}
			role="group" aria-label="Interactive sale price chart"
			onmousemove={hover} onmouseleave={leaveChart}
			onpointerdown={(event) => { press = { x: event.clientX, y: event.clientY }; preview = null; }}
			onpointerup={pin} onwheel={() => { preview = null; hoveredSales = []; }}>
		</div>
		{#if loader}<SaleHistorySidebar sales={sidebarSales} pinned={pinnedSales.length > 0} {clearPin} {basePath} {blockExplorer} {loader} onpreview={(target) => sidebarPreview = target} />{/if}
	</div>
	{#if loader && (pinnedPreview || preview)}
		<SaleCardPreview target={(pinnedPreview || preview)!} pinned={!!pinnedPreview} {loader} {chain} {collection} {media} {basePath} />
	{/if}
	{#if loader && sidebarPreview}
		<SaleCardPreview target={sidebarPreview} pinned={false} {loader} {chain} {collection} {media} {basePath} />
	{/if}
</section>

<style>
	.realized-price {
		position: relative;
		width: 100%;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.price-toolbar,
	.price-indicator {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.55rem;
	}
	label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.78rem;
		color: var(--c-sand);
	}
	.price-indicators {
		position: absolute;
		z-index: 40;
		top: 2.8rem;
		left: 0;
		display: grid;
		gap: 0.35rem;
		padding: 0.65rem;
		width: max-content;
		max-width: 100%;
		max-height: 80%;
		overflow: auto;
		border: 1px solid var(--c-blue);
		background: var(--c-bg);
	}
	.price-indicator input {
		width: 6ch;
	}
	.price-workspace {
		display: grid;
		grid-template-columns: minmax(0, 9fr) minmax(208px, 1fr);
		gap: 0.4rem;
		flex: 1;
		min-height: 0;
		min-width: 0;
	}
	.price-workspace[hidden] {
		display: none;
	}
	.price-canvas {
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		background: var(--c-bg);
	}
</style>
