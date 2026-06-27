<script lang="ts">
	import { goto, pushState } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, tick } from 'svelte';
	import {
		BLOCKSPACE_CONTEXT_ANY,
		BLOCKSPACE_GRID_CELL_COUNT
	} from '@artgod/shared/config/blockspace';
	import type {
		ApiBlockspaceGridCell,
		ApiBlockspaceRangeSummary,
		BlockspaceRangeSummaryApiResponse,
		BlockspaceStateApiResponse
	} from '$lib/api-types';
	import {
		getBlockspaceRangeSummary,
		getBlockspaceState,
		scheduleBlockspaceBackfill
	} from '$lib/backend-api';
	import BlockspaceIsometricGrid from '$lib/components/BlockspaceIsometricGrid.svelte';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import BlockspaceSummary from '$lib/components/BlockspaceSummary.svelte';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import { buildBlockspaceIsometricLevelRenderKey } from '$lib/blockspace-isometric-levels';
	import type {
		BlockspaceIsometricAnchorLayout,
		BlockspaceIsometricPoint,
		BlockspaceVisibleLevel
	} from '$lib/blockspace-isometric-levels';
	import {
		buildBlockspaceStackFetchPlan,
		buildBlockspaceStackStateApiParams,
		buildBlockspaceVisibleLevels,
		buildBlockspaceVisibleStackPages,
		formatBlockspacePageStackEntry,
		parseBlockspacePageStack,
		resolveBlockspaceStackAnchorLevelKey,
		type BlockspaceStackPage
	} from '$lib/blockspace-page-stack';
	import { startBlockspaceLiveRefresh } from '$lib/blockspace-live-refresh';
	import {
		formatBlockspaceAnchoredBlockDuration,
		formatBlockspaceBlockRange,
		formatBlockspaceInteger
	} from '$lib/blockspace-format';
	import {
		buildCollectionBasePath,
		buildCollectionNavigation
	} from '$lib/collection-navigation';

	type BlockRangeSelection = {
		fromBlock: number;
		toBlock: number;
		bucketSize: number;
		levelKey: string;
		markerBlock: number;
	};

	type RangeSummaryLoadOptions = {
		showLoading?: boolean;
		showError?: boolean;
	};

	type RangeDetailTarget = 'bucket' | 'backfill';

	type LevelRangeDetail = {
		range: BlockRangeSelection;
		summary: BlockspaceRangeSummaryApiResponse | null;
		loading: boolean;
		error: string | null;
		requestId: number;
		refreshKey: string | null;
		refreshInFlight: boolean;
	};

	type StackNavigationOptions = {
		updateUrl?: boolean;
	};

	type RouteStackNavigation = {
		collection: string;
		stack: string[];
		stackKey: string;
		urlKey: string;
	};

	type ProjectionLine = {
		key: string;
		start: BlockspaceIsometricPoint;
		end: BlockspaceIsometricPoint;
	};

	type ProjectionGridMask = {
		key: string;
		points: string;
	};

	type ProjectionAnchorLayout = {
		gridTopCorner: BlockspaceIsometricPoint;
		gridLeftCorner: BlockspaceIsometricPoint;
		gridRightCorner: BlockspaceIsometricPoint;
		gridBottomCorner: BlockspaceIsometricPoint;
		sourceLeftCorner: BlockspaceIsometricPoint | null;
		sourceRightCorner: BlockspaceIsometricPoint | null;
	};

	const PROJECTION_SOURCE_GAP_PX = 8;
	const PROJECTION_TARGET_GAP_PX = 14;
	const PROJECTION_GRID_MASK_ID = 'blockspace-projection-grid-mask';

	let {
		state: pageBlockspaceState,
		levels: pageLevels = [],
		basePath,
		collection: pageCollection,
		stack: pageStack,
		showListNavigation = true,
		showContextSelector = true,
		includeCollectionQueryParam = true,
		canCommitBackfill = true,
		showPanelShell = true
	}: {
		state: BlockspaceStateApiResponse | null;
		levels?: BlockspaceVisibleLevel[];
		basePath: string;
		collection: string;
		stack: string[];
		showListNavigation?: boolean;
		showContextSelector?: boolean;
		includeCollectionQueryParam?: boolean;
		canCommitBackfill?: boolean;
		showPanelShell?: boolean;
	} = $props();

	let blockspaceState = $state<BlockspaceStateApiResponse | null>(pageBlockspaceState);
	let levels = $state<BlockspaceVisibleLevel[]>(pageLevels);
	let collection = $state(pageCollection);
	let stack = $state<string[]>(pageStack);
	let submitting = $state(false);
	let feedback: string | null = $state(null);
	let selectedBucketDetailsByLevel = $state<Record<string, LevelRangeDetail>>({});
	let selectedBackfillRangeDetailsByLevel = $state<Record<string, LevelRangeDetail>>({});
	let selectedRangeRequestSequence = 0;
	let drilldownRequestId = 0;
	let liveRefreshRequestId = 0;
	let backfillSelectionMode = $state(false);
	let backfillSelectionFromBlock: number | null = $state(null);
	let backfillSelectionLevelKey: string | null = $state(null);
	let backfillSelectionRange: BlockRangeSelection | null = $state(null);
	let levelsLayoutElement = $state<HTMLDivElement | null>(null);
	let isometricAnchorLayouts = $state<Record<string, ProjectionAnchorLayout>>({});
	let reservedLevelsLayoutHeight = $state(0);

	let selectedCollection = $derived(blockspaceState?.context.selected ?? collection ?? BLOCKSPACE_CONTEXT_ANY);
	let selectedCollectionJumpHref = $derived(
		resolveSelectedCollectionJumpHref(blockspaceState, selectedCollection)
	);
	let currentPageKey = $derived(
		blockspaceState
			? `${blockspaceState.chain.slug}:${selectedCollection}:${blockspaceState.range.fromBlock}:${blockspaceState.range.toBlock}:${blockspaceState.range.bucketSize}`
			: null
	);
	let selectedRangeScopeKey = $derived(`${basePath}:${selectedCollection}`);
	let visibleLevels = $derived(
		levels.length > 0
			? levels
			: blockspaceState
				? [{ key: 'root', label: 'root', stack: [], state: blockspaceState }]
				: []
	);
	let routeStackNavigation = $derived(
		resolveRouteStackNavigation(page.url, includeCollectionQueryParam ? null : selectedCollection)
	);
	let rangeDetailsLiveVersion = $state(0);
	let rangeDetailsLiveKey = $derived(String(rangeDetailsLiveVersion));
	let selectedRangeDetailsRenderKey = $derived(
		[
			formatSelectedRangeDetailsRenderKey(selectedBucketDetailsByLevel),
			formatSelectedRangeDetailsRenderKey(selectedBackfillRangeDetailsByLevel)
		].join('|')
	);
	let isometricRenderKey = $derived(
		[
			currentPageKey,
			backfillSelectionMode ? 'selection' : 'normal',
			backfillSelectionLevelKey ?? '',
			backfillSelectionFromBlock ?? '',
			formatBackfillSelectionRangeKey(backfillSelectionRange),
			selectedRangeDetailsRenderKey
		].join('|')
	);
	let projectionLines = $derived(resolveProjectionLines(visibleLevels, isometricAnchorLayouts));
	let projectionGridMasks = $derived(resolveProjectionGridMasks(visibleLevels, isometricAnchorLayouts));
	let activeSelectedRangeScopeKey: string | null = $state(null);
	let appliedRouteNavigationUrlKey: string | null = $state(null);

	onMount(() => {
		if (!blockspaceState) return;
		const refresh = startBlockspaceLiveRefresh({ refresh: refreshVisibleStack });
		const handleKeydown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || !backfillSelectionMode) return;
			event.preventDefault();
			cancelBackfillSelection();
		};
		window.addEventListener('keydown', handleKeydown);
		return () => {
			refresh.stop();
			window.removeEventListener('keydown', handleKeydown);
		};
	});

	$effect(() => {
		blockspaceState = pageBlockspaceState;
		levels = pageLevels;
		collection = pageCollection;
		stack = pageStack;
	});

	$effect(() => {
		if (activeSelectedRangeScopeKey === selectedRangeScopeKey) return;
		activeSelectedRangeScopeKey = selectedRangeScopeKey;
		backfillSelectionMode = false;
		backfillSelectionFromBlock = null;
		backfillSelectionLevelKey = null;
		backfillSelectionRange = null;
		clearAllRangeDetails();
	});

	$effect(() => {
		const visibleLevelKeys = new Set(visibleLevels.map((level) => level.key));
		pruneRangeDetailsToVisibleLevels(visibleLevelKeys);
	});

	$effect(() => {
		if (!routeStackNavigation) return;
		if (routeStackNavigation.collection !== selectedCollection) return;
		if (routeStackNavigation.urlKey === appliedRouteNavigationUrlKey) return;
		appliedRouteNavigationUrlKey = routeStackNavigation.urlKey;
		if (routeStackNavigation.stackKey === stack.join(',')) return;
		const anchorLevelKey = resolveBlockspaceStackAnchorLevelKey(
			stack,
			routeStackNavigation.stack,
			visibleLevels
		);
		void navigateToStack(routeStackNavigation.stack, anchorLevelKey, {
			updateUrl: false
		});
	});

	$effect(() => {
		const visibleLevelKeys = new Set(visibleLevels.map((level) => level.key));
		refreshRangeDetails(selectedBucketDetailsByLevel, visibleLevelKeys, 'bucket');
		if (backfillSelectionMode) {
			refreshRangeDetails(selectedBackfillRangeDetailsByLevel, visibleLevelKeys, 'backfill');
		}
	});

	$effect(() => {
		const element = levelsLayoutElement;
		if (!element || typeof ResizeObserver === 'undefined') return;
		const preserveHeight = () => {
			reservedLevelsLayoutHeight = Math.max(
				reservedLevelsLayoutHeight,
				Math.ceil(element.getBoundingClientRect().height)
			);
		};
		preserveHeight();
		const observer = new ResizeObserver(preserveHeight);
		observer.observe(element);
		return () => observer.disconnect();
	});

	function queryHref(nextCollection: string, nextStack: string[]): string {
		const query = new URLSearchParams();
		if (
			includeCollectionQueryParam &&
			nextCollection &&
			nextCollection !== BLOCKSPACE_CONTEXT_ANY
		) {
			query.set('collection', nextCollection);
		}
		if (nextStack.length > 0) {
			query.set('stack', nextStack.join(','));
		}
		const suffix = query.toString();
		return suffix ? `${basePath}?${suffix}` : basePath;
	}

	function resolveRouteStackNavigation(
		url: URL,
		collectionOverride: string | null = null
	): RouteStackNavigation | null {
		const parsedStack = parseBlockspacePageStack(url.searchParams.get('stack'));
		if (!parsedStack) return null;
		const rawCollection = url.searchParams.get('collection')?.trim() || BLOCKSPACE_CONTEXT_ANY;
		const collection = collectionOverride ?? rawCollection;
		const stack = parsedStack.map(formatBlockspacePageStackEntry);
		return {
			collection,
			stack,
			stackKey: stack.join(','),
			urlKey: url.pathname + '?' + url.searchParams.toString()
		};
	}

	function onCollectionChange(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return;
		feedback = null;
		void goto(queryHref(target.value, stack));
	}

	function resolveSelectedCollectionJumpHref(
		state: BlockspaceStateApiResponse | null,
		collectionRef: string
	): string | null {
		if (!state || collectionRef === BLOCKSPACE_CONTEXT_ANY) return null;
		return buildCollectionNavigation({
			basePath: buildCollectionBasePath({
				chainRef: state.chain.slug,
				collectionRef
			}),
			selectedTraits: [],
			selectedTraitRanges: []
		}).hrefs.asks;
	}

	async function handleCellClick(
		_event: MouseEvent,
		level: BlockspaceVisibleLevel,
		cell: ApiBlockspaceGridCell
	): Promise<void> {
		if (backfillSelectionMode) {
			await handleBackfillSelectionClick(level, cell);
			return;
		}
		if (cell.blockCount <= 0) return;

		feedback = null;
		void loadRangeSummary('bucket', buildCellRangeSelection(level, cell));
		if (!cell.canDrillDown) {
			await collapseDrilldownAtLevel(level);
			return;
		}

		const childBucketSize = level.state.range.bucketSize / BLOCKSPACE_GRID_CELL_COUNT;
		if (!Number.isInteger(childBucketSize) || childBucketSize < 1) {
			await collapseDrilldownAtLevel(level);
			return;
		}
		await navigateToStack(
			[
				...level.stack,
				formatBlockspacePageStackEntry({
					pageStartBlock: cell.fromBlock,
					bucketSize: childBucketSize
				})
			],
			level.key
		);
	}

	async function collapseDrilldownAtLevel(level: BlockspaceVisibleLevel): Promise<void> {
		if (!blockspaceState || blockspaceStacksEqual(level.stack, stack)) return;
		const levelIndex = visibleLevels.findIndex((candidate) => candidate.key === level.key);
		if (levelIndex < 0) return;

		const requestId = drilldownRequestId + 1;
		drilldownRequestId = requestId;
		const nextStack = [...level.stack];
		const nextLevels = visibleLevels.slice(0, levelIndex + 1);
		const nextState = nextLevels.at(-1)?.state ?? null;
		if (!nextState) return;

		const anchorTop = readLevelAnchorTop(level.key);
		blockspaceState = nextState;
		levels = nextLevels;
		collection = selectedCollection;
		stack = nextStack;
		await tick();
		if (drilldownRequestId !== requestId) return;
		restoreLevelAnchor(level.key, anchorTop);
		pushState(queryHref(selectedCollection, nextStack), page.state);
		await tick();
		restoreLevelAnchor(level.key, anchorTop);
	}

	function blockspaceStacksEqual(left: string[], right: string[]): boolean {
		return left.length === right.length && left.every((entry, index) => entry === right[index]);
	}

	async function handleBackfillSelectionClick(
		level: BlockspaceVisibleLevel,
		cell: ApiBlockspaceGridCell
	): Promise<void> {
		if (cell.blockCount <= 0) return;
		feedback = null;
		if (backfillSelectionFromBlock === null) {
			backfillSelectionFromBlock = cell.fromBlock;
			backfillSelectionLevelKey = level.key;
			backfillSelectionRange = null;
			clearBackfillRangeDetails();
			return;
		}
		if (backfillSelectionLevelKey !== level.key) {
			backfillSelectionFromBlock = cell.fromBlock;
			backfillSelectionLevelKey = level.key;
			backfillSelectionRange = null;
			clearBackfillRangeDetails();
			return;
		}

		const nextRange = {
			fromBlock: backfillSelectionFromBlock,
			toBlock: cell.toBlock,
			bucketSize: level.state.range.bucketSize,
			levelKey: level.key,
			markerBlock: cell.fromBlock
		};
		if (nextRange.toBlock < nextRange.fromBlock) {
			feedback = `select to block >= ${formatBlockspaceInteger(nextRange.fromBlock)}`;
			return;
		}

		backfillSelectionFromBlock = null;
		backfillSelectionLevelKey = null;
		backfillSelectionRange = nextRange;
		await loadRangeSummary('backfill', nextRange);
	}

	function beginBackfillSelection(): void {
		if (!blockspaceState) return;
		backfillSelectionMode = true;
		backfillSelectionFromBlock = null;
		backfillSelectionLevelKey = null;
		backfillSelectionRange = null;
		feedback = null;
		clearBackfillRangeDetails();
	}

	function cancelBackfillSelection(): void {
		backfillSelectionMode = false;
		backfillSelectionFromBlock = null;
		backfillSelectionLevelKey = null;
		backfillSelectionRange = null;
		feedback = null;
		clearBackfillRangeDetails();
	}

	function formatBackfillSelectionRangeKey(range: BlockRangeSelection | null): string {
		return range ? `${range.levelKey}:${range.fromBlock}:${range.toBlock}:${range.markerBlock}` : '';
	}

	function formatRangeSummaryRefreshKey(range: BlockRangeSelection, liveKey: string): string {
		return `${formatBackfillSelectionRangeKey(range)}:${liveKey}`;
	}

	function formatSelectedRangeDetailsRenderKey(details: Record<string, LevelRangeDetail>): string {
		return Object.entries(details)
			.map(([levelKey, detail]) => `${levelKey}:${formatBackfillSelectionRangeKey(detail.range)}`)
			.sort()
			.join('|');
	}

	function refreshRangeDetails(
		details: Record<string, LevelRangeDetail>,
		visibleLevelKeys: Set<string>,
		target: RangeDetailTarget
	): void {
		for (const [levelKey, detail] of Object.entries(details)) {
			if (!visibleLevelKeys.has(levelKey) || detail.loading || detail.refreshInFlight) continue;
			const refreshKey = formatRangeSummaryRefreshKey(detail.range, rangeDetailsLiveKey);
			if (detail.refreshKey === refreshKey) continue;
			void loadRangeSummary(target, detail.range, { showLoading: false, showError: false });
		}
	}

	function pruneRangeDetailsToVisibleLevels(visibleLevelKeys: Set<string>): void {
		const nextBucketDetails = pruneRangeDetails(selectedBucketDetailsByLevel, visibleLevelKeys);
		const nextBackfillDetails = pruneRangeDetails(
			selectedBackfillRangeDetailsByLevel,
			visibleLevelKeys
		);
		if (nextBucketDetails !== selectedBucketDetailsByLevel) {
			selectedBucketDetailsByLevel = nextBucketDetails;
		}
		if (nextBackfillDetails !== selectedBackfillRangeDetailsByLevel) {
			selectedBackfillRangeDetailsByLevel = nextBackfillDetails;
		}
	}

	function pruneRangeDetails(
		details: Record<string, LevelRangeDetail>,
		visibleLevelKeys: Set<string>
	): Record<string, LevelRangeDetail> {
		const entries = Object.entries(details).filter(([levelKey]) => visibleLevelKeys.has(levelKey));
		if (entries.length === Object.keys(details).length) return details;
		return Object.fromEntries(entries);
	}

	function buildCellRangeSelection(
		level: BlockspaceVisibleLevel,
		cell: ApiBlockspaceGridCell
	): BlockRangeSelection {
		return {
			fromBlock: cell.fromBlock,
			toBlock: cell.toBlock,
			bucketSize: level.state.range.bucketSize,
			levelKey: level.key,
			markerBlock: cell.fromBlock
		};
	}

	function handleIsometricAnchorLayout(layout: BlockspaceIsometricAnchorLayout): void {
		if (!levelsLayoutElement) return;
		const bounds = levelsLayoutElement.getBoundingClientRect();
		const nextLayout = {
			gridTopCorner: toLayoutPoint(layout.gridTopCorner, bounds),
			gridLeftCorner: toLayoutPoint(layout.gridLeftCorner, bounds),
			gridRightCorner: toLayoutPoint(layout.gridRightCorner, bounds),
			gridBottomCorner: toLayoutPoint(layout.gridBottomCorner, bounds),
			sourceLeftCorner: layout.sourceLeftCorner
				? toLayoutPoint(layout.sourceLeftCorner, bounds)
				: null,
			sourceRightCorner: layout.sourceRightCorner
				? toLayoutPoint(layout.sourceRightCorner, bounds)
				: null
		};
		const currentLayout = isometricAnchorLayouts[layout.levelKey];
		if (currentLayout && anchorLayoutsEqual(currentLayout, nextLayout)) return;
		isometricAnchorLayouts = {
			...isometricAnchorLayouts,
			[layout.levelKey]: nextLayout
		};
	}

	async function navigateToStack(
		nextStack: string[],
		anchorLevelKey: string,
		options: StackNavigationOptions = {}
	): Promise<void> {
		if (!blockspaceState) return;
		const updateUrl = options.updateUrl ?? true;
		const requestId = drilldownRequestId + 1;
		drilldownRequestId = requestId;
		const href = queryHref(selectedCollection, nextStack);
		const anchorTop = readLevelAnchorTop(anchorLevelKey);
		try {
			const states = await fetchChangedStackStates(selectedCollection, nextStack);
			if (drilldownRequestId !== requestId) return;
			const nextState = states.at(-1);
			if (!nextState) return;
			blockspaceState = nextState;
			levels = buildBlockspaceVisibleLevels(nextStack, states);
			collection = selectedCollection;
			stack = nextStack;
			await tick();
			restoreLevelAnchor(anchorLevelKey, anchorTop);
			if (updateUrl) {
				pushState(href, page.state);
			}
			await tick();
			restoreLevelAnchor(anchorLevelKey, anchorTop);
		} catch (error) {
			if (drilldownRequestId === requestId) {
				feedback = error instanceof Error ? error.message : 'blockspace level request failed';
			}
		}
	}

	async function refreshVisibleStack(): Promise<void> {
		if (!blockspaceState) return;
		const requestId = liveRefreshRequestId + 1;
		liveRefreshRequestId = requestId;
		const refreshCollection = selectedCollection;
		const refreshStack = [...stack];
		const refreshStackKey = refreshStack.join(',');
		const anchorLevelKey = visibleLevels.at(-1)?.key ?? 'root';
		const anchorTop = readLevelAnchorTop(anchorLevelKey);
		try {
			const states = await fetchStackPages(
				refreshCollection,
				buildBlockspaceVisibleStackPages(refreshStack)
			);
			if (
				liveRefreshRequestId !== requestId ||
				refreshCollection !== selectedCollection ||
				refreshStackKey !== stack.join(',')
			) {
				return;
			}
			const nextState = states.at(-1);
			if (!nextState) return;
			blockspaceState = nextState;
			levels = buildBlockspaceVisibleLevels(refreshStack, states);
			collection = refreshCollection;
			rangeDetailsLiveVersion += 1;
			await tick();
			restoreLevelAnchor(anchorLevelKey, anchorTop);
		} catch {
			// Keep the visible stack stable after transient live-refresh failures.
		}
	}

	async function fetchChangedStackStates(
		nextCollection: string,
		nextStack: string[]
	): Promise<BlockspaceStateApiResponse[]> {
		const plan = buildBlockspaceStackFetchPlan(stack, nextStack, visibleLevels);
		const fetchedStates = await fetchStackPages(nextCollection, plan.pagesToFetch);
		return [...plan.reusedStates, ...fetchedStates];
	}

	async function fetchStackPages(
		nextCollection: string,
		stackPages: BlockspaceStackPage[]
	): Promise<BlockspaceStateApiResponse[]> {
		if (!blockspaceState) return [];
		const chainSlug = blockspaceState.chain.slug;
		return Promise.all(
			buildBlockspaceStackStateApiParams(nextCollection, stackPages).map((apiParams) => {
				// Fetch visible level state directly so component-owned refreshes avoid route reloads.
				return getBlockspaceState(fetch, chainSlug, apiParams);
			})
		);
	}

	function readLevelAnchorTop(levelKey: string): number | null {
		const element = findLevelAnchor(levelKey);
		return element ? element.getBoundingClientRect().top : null;
	}

	function restoreLevelAnchor(levelKey: string, previousTop: number | null): void {
		if (previousTop === null) return;
		const element = findLevelAnchor(levelKey);
		if (!element) return;
		const delta = element.getBoundingClientRect().top - previousTop;
		if (Math.abs(delta) < 1) return;
		window.scrollTo(window.scrollX, window.scrollY + delta);
	}

	function findLevelAnchor(levelKey: string): HTMLElement | null {
		if (!levelsLayoutElement) return null;
		const anchors = levelsLayoutElement.querySelectorAll<HTMLElement>('[data-blockspace-level-anchor]');
		return (
			Array.from(anchors).find((element) => element.dataset.blockspaceLevelAnchor === levelKey) ?? null
		);
	}

	function clearAllRangeDetails(): void {
		selectedRangeRequestSequence += 1;
		selectedBucketDetailsByLevel = {};
		selectedBackfillRangeDetailsByLevel = {};
	}

	function clearBackfillRangeDetails(): void {
		selectedRangeRequestSequence += 1;
		selectedBackfillRangeDetailsByLevel = {};
	}

	async function loadRangeSummary(
		target: RangeDetailTarget,
		range: BlockRangeSelection,
		options: RangeSummaryLoadOptions = {}
	): Promise<void> {
		if (!blockspaceState || range.fromBlock > range.toBlock) return;
		const showLoading = options.showLoading ?? true;
		const showError = options.showError ?? true;
		const requestId = selectedRangeRequestSequence + 1;
		selectedRangeRequestSequence = requestId;
		const currentDetail = detailMapForTarget(target)[range.levelKey] ?? null;
		setRangeDetail(target, range.levelKey, {
			range,
			summary: showLoading ? null : currentDetail?.summary ?? null,
			loading: showLoading,
			error: showError ? null : currentDetail?.error ?? null,
			requestId,
			refreshKey: formatRangeSummaryRefreshKey(range, rangeDetailsLiveKey),
			refreshInFlight: !showLoading
		});
		try {
			const params = new URLSearchParams();
			params.set('from_block', String(range.fromBlock));
			params.set('to_block', String(range.toBlock));
			if (selectedCollection !== BLOCKSPACE_CONTEXT_ANY) {
				params.set('collection', selectedCollection);
			}
			const summary = await getBlockspaceRangeSummary(fetch, blockspaceState.chain.slug, params);
			updateRangeDetail(target, range.levelKey, requestId, (detail) => ({
				...detail,
				summary: {
					...summary,
					range: {
						...summary.range,
						bucketSize: range.bucketSize
					}
				},
				error: null
			}));
		} catch (error) {
			if (showError) {
				updateRangeDetail(target, range.levelKey, requestId, (detail) => ({
					...detail,
					error: error instanceof Error ? error.message : 'range request failed'
				}));
			}
		} finally {
			updateRangeDetail(target, range.levelKey, requestId, (detail) => ({
				...detail,
				loading: showLoading ? false : detail.loading,
				refreshInFlight: showLoading ? detail.refreshInFlight : false
			}));
		}
	}

	function detailMapForTarget(target: RangeDetailTarget): Record<string, LevelRangeDetail> {
		return target === 'bucket' ? selectedBucketDetailsByLevel : selectedBackfillRangeDetailsByLevel;
	}

	function setRangeDetail(
		target: RangeDetailTarget,
		levelKey: string,
		detail: LevelRangeDetail
	): void {
		if (target === 'bucket') {
			selectedBucketDetailsByLevel = {
				...selectedBucketDetailsByLevel,
				[levelKey]: detail
			};
			return;
		}

		selectedBackfillRangeDetailsByLevel = {
			...selectedBackfillRangeDetailsByLevel,
			[levelKey]: detail
		};
	}

	function updateRangeDetail(
		target: RangeDetailTarget,
		levelKey: string,
		requestId: number,
		update: (detail: LevelRangeDetail) => LevelRangeDetail
	): void {
		const detail = detailMapForTarget(target)[levelKey];
		if (!detail || detail.requestId !== requestId) return;
		setRangeDetail(target, levelKey, update(detail));
	}

	async function commitBackfillSelection(): Promise<void> {
		if (!canCommitBackfill || !blockspaceState || !backfillSelectionRange) return;
		submitting = true;
		feedback = null;
		try {
			const result = await scheduleBlockspaceBackfill(fetch, blockspaceState.chain.slug, {
				collectionRef:
					selectedCollection === BLOCKSPACE_CONTEXT_ANY ? null : selectedCollection,
				fromBlock: backfillSelectionRange.fromBlock,
				toBlock: backfillSelectionRange.toBlock
			});
			feedback = `queued ${result.queuedJobs} job${result.queuedJobs === 1 ? '' : 's'}`;
			backfillSelectionMode = false;
			backfillSelectionFromBlock = null;
			backfillSelectionLevelKey = null;
			backfillSelectionRange = null;
			clearBackfillRangeDetails();
			await refreshVisibleStack();
		} catch (error) {
			feedback = error instanceof Error ? error.message : 'backfill request failed';
		} finally {
			submitting = false;
		}
	}

	function cellClass(level: BlockspaceVisibleLevel, cell: ApiBlockspaceGridCell): string {
		const classes = ['blockspace-isometric-tile', `blockspace-isometric-tile-${cell.state}`];
		if (cell.blockCount <= 0) {
			classes.push('blockspace-isometric-tile-disabled');
		}
		if (cell.collectionDeploymentBlock) {
			classes.push(
				cell.collectionDeploymentBlock.synced
					? 'blockspace-isometric-tile-deployment-synced'
					: 'blockspace-isometric-tile-deployment-unsynced'
			);
		}
		if (isSelectionCell(level.key, cell)) {
			classes.push('blockspace-isometric-tile-selected');
		}
		if (!backfillSelectionMode && isActiveBucketCell(level.key, cell)) {
			classes.push('blockspace-isometric-tile-active');
		}
		return classes.join(' ');
	}

	function cellLabel(level: BlockspaceVisibleLevel, cell: ApiBlockspaceGridCell): string {
		const range = formatRange(cell.fromBlock, cell.toBlock, cell.blockCount);
		const duration =
			cell.blockCount > 0
				? `, ${formatVisibleBlockDuration(level.state, cell.blockCount)}`
				: '';
		const marker = cell.collectionDeploymentBlock
			? `, deployment block ${formatBlockspaceInteger(cell.collectionDeploymentBlock.blockNumber)} ${
					cell.collectionDeploymentBlock.synced ? 'synced' : 'not synced'
				}`
			: '';
		const action = resolveCellActionLabel(cell);
		return `${range}: ${formatBlockspaceInteger(cell.syncedBlockCount)}/${formatBlockspaceInteger(cell.blockCount)} synced${duration}${marker}${action}`;
	}

	function formatRange(fromBlock: number, toBlock: number, blockCount: number): string {
		if (blockCount <= 0) return 'outside range';
		if (fromBlock === toBlock) return `block ${formatBlockspaceInteger(fromBlock)}`;
		return formatBlockspaceBlockRange(fromBlock, toBlock);
	}

	function resolveCellActionLabel(cell: ApiBlockspaceGridCell): string {
		if (backfillSelectionMode) {
			return backfillSelectionFromBlock === null
				? ', click to select from block'
				: ', click to select to block';
		}
		if (cell.canDrillDown) return ', click to open child level and show range details';
		if (cell.blockCount === 1) return ', click for block details';
		return '';
	}

	function isSelectionCell(levelKey: string, cell: ApiBlockspaceGridCell): boolean {
		if (!backfillSelectionMode || cell.blockCount <= 0) return false;
		if (backfillSelectionRange) {
			if (backfillSelectionRange.levelKey !== levelKey) return false;
			return rangesOverlap(cell, backfillSelectionRange);
		}
		if (backfillSelectionLevelKey !== levelKey) return false;
		return rangeContainsBlock(cell, backfillSelectionFromBlock);
	}

	function isActiveBucketCell(levelKey: string, cell: ApiBlockspaceGridCell): boolean {
		const detail = selectedBucketDetailsByLevel[levelKey];
		return Boolean(detail && rangeContainsBlock(cell, detail.range.markerBlock));
	}

	function selectedBucketDetailForLevel(levelKey: string): LevelRangeDetail[] {
		const detail = selectedBucketDetailsByLevel[levelKey];
		return detail ? [detail] : [];
	}

	function selectedBackfillRangeDetailForLevel(levelKey: string): LevelRangeDetail[] {
		if (!backfillSelectionMode) return [];
		const detail = selectedBackfillRangeDetailsByLevel[levelKey];
		return detail ? [detail] : [];
	}

	function rangesOverlap(cell: ApiBlockspaceGridCell, range: BlockRangeSelection): boolean {
		return cell.fromBlock <= range.toBlock && range.fromBlock <= cell.toBlock;
	}

	function rangeContainsBlock(
		cell: ApiBlockspaceGridCell,
		blockNumber: number | null
	): boolean {
		return blockNumber !== null && cell.fromBlock <= blockNumber && blockNumber <= cell.toBlock;
	}

	function resolveProjectionSourceCell(
		level: BlockspaceVisibleLevel,
		levelIndex: number
	): ApiBlockspaceGridCell | null {
		const childLevel = visibleLevels[levelIndex + 1];
		if (!childLevel) return null;
		return (
			level.state.grid.find(
				(cell) =>
					cell.fromBlock <= childLevel.state.range.fromBlock &&
					childLevel.state.range.toBlock <= cell.toBlock
			) ?? null
		);
	}

	function resolveProjectionLines(
		levels: BlockspaceVisibleLevel[],
		anchors: Record<string, ProjectionAnchorLayout>
	): ProjectionLine[] {
		const lines: ProjectionLine[] = [];
		for (let index = 0; index < levels.length - 1; index += 1) {
			const source = anchors[levels[index].key];
			const target = anchors[levels[index + 1].key];
			if (
				!source?.sourceLeftCorner ||
				!source.sourceRightCorner ||
				!target?.gridLeftCorner ||
				!target.gridRightCorner
			) {
				continue;
			}
			const leftLine = insetProjectionLine(source.sourceLeftCorner, target.gridLeftCorner);
			const rightLine = insetProjectionLine(source.sourceRightCorner, target.gridRightCorner);
			lines.push({
				key: `${levels[index].key}:${levels[index + 1].key}:left`,
				start: leftLine.start,
				end: leftLine.end
			});
			lines.push({
				key: `${levels[index].key}:${levels[index + 1].key}:right`,
				start: rightLine.start,
				end: rightLine.end
			});
		}
		return lines;
	}

	function resolveProjectionGridMasks(
		levels: BlockspaceVisibleLevel[],
		anchors: Record<string, ProjectionAnchorLayout>
	): ProjectionGridMask[] {
		return levels
			.map((level) => {
				const anchor = anchors[level.key];
				if (!anchor) return null;
				return {
					key: level.key,
					points: [
						anchor.gridTopCorner,
						anchor.gridRightCorner,
						anchor.gridBottomCorner,
						anchor.gridLeftCorner
					]
						.map(formatSvgPoint)
						.join(' ')
				};
			})
			.filter((mask): mask is ProjectionGridMask => mask !== null);
	}

	function insetProjectionLine(
		start: BlockspaceIsometricPoint,
		end: BlockspaceIsometricPoint
	): { start: BlockspaceIsometricPoint; end: BlockspaceIsometricPoint } {
		const deltaX = end.x - start.x;
		const deltaY = end.y - start.y;
		const length = Math.hypot(deltaX, deltaY);
		if (length <= PROJECTION_SOURCE_GAP_PX + PROJECTION_TARGET_GAP_PX) {
			return { start, end };
		}
		const unitX = deltaX / length;
		const unitY = deltaY / length;
		return {
			start: {
				x: start.x + unitX * PROJECTION_SOURCE_GAP_PX,
				y: start.y + unitY * PROJECTION_SOURCE_GAP_PX
			},
			end: {
				x: end.x - unitX * PROJECTION_TARGET_GAP_PX,
				y: end.y - unitY * PROJECTION_TARGET_GAP_PX
			}
		};
	}

	function toLayoutPoint(
		point: BlockspaceIsometricPoint,
		bounds: DOMRect
	): BlockspaceIsometricPoint {
		return {
			x: point.x - bounds.left,
			y: point.y - bounds.top
		};
	}

	function anchorLayoutsEqual(
		left: ProjectionAnchorLayout,
		right: ProjectionAnchorLayout
	): boolean {
		return (
			pointsEqual(left.gridTopCorner, right.gridTopCorner) &&
			pointsEqual(left.gridLeftCorner, right.gridLeftCorner) &&
			pointsEqual(left.gridRightCorner, right.gridRightCorner) &&
			pointsEqual(left.gridBottomCorner, right.gridBottomCorner) &&
			nullablePointsEqual(left.sourceLeftCorner, right.sourceLeftCorner) &&
			nullablePointsEqual(left.sourceRightCorner, right.sourceRightCorner)
		);
	}

	function formatSvgPoint(point: BlockspaceIsometricPoint): string {
		return `${point.x},${point.y}`;
	}

	function nullablePointsEqual(
		left: BlockspaceIsometricPoint | null,
		right: BlockspaceIsometricPoint | null
	): boolean {
		if (left === null || right === null) return left === right;
		return pointsEqual(left, right);
	}

	function pointsEqual(
		left: BlockspaceIsometricPoint,
		right: BlockspaceIsometricPoint
	): boolean {
		return Math.abs(left.x - right.x) < 0.5 && Math.abs(left.y - right.y) < 0.5;
	}

	function buildLevelSummaryRange(level: BlockspaceVisibleLevel): ApiBlockspaceRangeSummary {
		return {
			fromBlock: level.state.range.fromBlock,
			toBlock: level.state.range.toBlock,
			blockCount: level.state.range.blockCount,
			bucketSize: level.state.range.bucketSize,
			syncedBlockCount: level.state.summary.selectedRangeSyncedBlockCount,
			time: level.state.range.time
		};
	}

	function formatVisibleBlockDuration(
		state: BlockspaceStateApiResponse,
		blockCount: number
	): string {
		return formatBlockspaceAnchoredBlockDuration({
			blockCount,
			pageBlockCount: state.range.blockCount,
			pageDurationSeconds: state.range.time.durationSeconds,
			averageBlockTimeSeconds: state.chain.averageBlockTimeSeconds
		});
	}

</script>

{#snippet blockspaceContent()}
	<header class="panel-header blockspace-controls-header">
		<div>
			<p class="panel-subtitle">
				{#if blockspaceState}
					{blockspaceState.chain.name} ({blockspaceState.chain.slug} / {blockspaceState.chain.publicChainId})
				{:else}
					Loading chain...
				{/if}
			</p>
		</div>
		<div class="blockspace-toolbar">
			{#if showContextSelector}
				<div class="status-form">
					<label class="status-form" for="blockspace-collection">
						<span>context</span>
						<select id="blockspace-collection" value={selectedCollection} onchange={onCollectionChange}>
							<option value={BLOCKSPACE_CONTEXT_ANY}>any</option>
							{#each blockspaceState?.context.collections ?? [] as option}
								<option value={option.slug}>{option.slug}</option>
							{/each}
						</select>
					</label>
					{#if selectedCollectionJumpHref}
						<a class="button-link" href={selectedCollectionJumpHref}>jump to collection</a>
					{/if}
				</div>
			{/if}
			<div
				class={backfillSelectionMode
					? 'blockspace-actions blockspace-actions-selection'
					: 'blockspace-actions'}
			>
				{#if backfillSelectionMode}
					<button
						type="button"
						class="action-button-negative"
						onclick={cancelBackfillSelection}
						disabled={submitting}
					>
						cancel
					</button>
					<button
						type="button"
						class="action-button-positive"
						onclick={commitBackfillSelection}
						disabled={!canCommitBackfill || !backfillSelectionRange || submitting}
					>
						{submitting ? 'queueing...' : 'commit to backfill'}
					</button>
				{:else}
					<button type="button" onclick={beginBackfillSelection} disabled={!blockspaceState || submitting}>
						backfill range
					</button>
				{/if}
				{#if feedback}
					<span class="muted">{feedback}</span>
				{/if}
			</div>
		</div>
	</header>

	{#if blockspaceState}
		<div class="blockspace-content">
			<div
				class="blockspace-levels-layout"
				style:min-height={reservedLevelsLayoutHeight > 0
					? `${reservedLevelsLayoutHeight}px`
					: undefined}
				bind:this={levelsLayoutElement}
			>
				<svg class="blockspace-projection-overlay" aria-hidden="true">
					<defs>
						<mask id={PROJECTION_GRID_MASK_ID} maskUnits="userSpaceOnUse">
							<rect
								x="-100000"
								y="-100000"
								width="200000"
								height="200000"
								fill="white"
							/>
							{#each projectionGridMasks as gridMask (gridMask.key)}
								<polygon
									class="blockspace-projection-grid-mask"
									points={gridMask.points}
								/>
							{/each}
						</mask>
					</defs>
					{#each projectionLines as line (line.key)}
						<line
							class="blockspace-projection-line"
							x1={line.start.x}
							y1={line.start.y}
							x2={line.end.x}
							y2={line.end.y}
							mask={`url(#${PROJECTION_GRID_MASK_ID})`}
						/>
					{/each}
				</svg>
				{#each visibleLevels as level, levelIndex (levelIndex)}
					<section class="blockspace-level-row" aria-label={`${level.label} blockspace level`}>
						<aside class="blockspace-level-summary-panel">
							<BlockspaceSummary
								chain={level.state.chain}
								range={buildLevelSummaryRange(level)}
								ariaLabel={`${level.label} blockspace summary`}
							/>
						</aside>
						<div class="blockspace-grid-wrap" data-blockspace-level-anchor={level.key}>
							<BlockspaceIsometricGrid
								{level}
								selectionMode={backfillSelectionMode}
								renderKey={`${isometricRenderKey}:${buildBlockspaceIsometricLevelRenderKey(level)}`}
								projectionSourceCell={resolveProjectionSourceCell(level, levelIndex)}
								resolveCellClass={cellClass}
								resolveCellLabel={cellLabel}
								onCellClick={handleCellClick}
								onAnchorLayout={handleIsometricAnchorLayout}
							/>
						</div>
						<aside class="blockspace-level-selection-panel">
							{#each selectedBucketDetailForLevel(level.key) as selectedBucketDetail}
								<div class="blockspace-level-detail-panel">
									{#if selectedBucketDetail.loading}
										<div class="blockspace-range-detail-status muted">loading range</div>
									{:else if selectedBucketDetail.error}
										<div class="blockspace-range-detail-status muted">{selectedBucketDetail.error}</div>
									{:else if selectedBucketDetail.summary}
										<BlockspaceSummary
											chain={selectedBucketDetail.summary.chain}
											range={selectedBucketDetail.summary.range}
											observedLabel="selected"
											ariaLabel={level.label + ' selected bucket summary'}
										/>
									{/if}
								</div>
							{/each}
							{#each selectedBackfillRangeDetailForLevel(level.key) as selectedBackfillRangeDetail}
								<div class="blockspace-level-detail-panel blockspace-level-detail-panel-backfill">
									{#if selectedBackfillRangeDetail.loading}
										<div class="blockspace-range-detail-status blockspace-range-detail-status-backfill muted">
											loading range
										</div>
									{:else if selectedBackfillRangeDetail.error}
										<div class="blockspace-range-detail-status blockspace-range-detail-status-backfill muted">
											{selectedBackfillRangeDetail.error}
										</div>
									{:else if selectedBackfillRangeDetail.summary}
										<BlockspaceSummary
											chain={selectedBackfillRangeDetail.summary.chain}
											range={selectedBackfillRangeDetail.summary.range}
											observedLabel="selected"
											ariaLabel={level.label + ' selected backfill range summary'}
										/>
									{/if}
								</div>
							{/each}
						</aside>
					</section>
				{/each}
			</div>

		</div>
	{:else}
		<div class="empty-cell">loading blockspace state</div>
	{/if}
{/snippet}

{#if showPanelShell}
	<section class="panel">
		<header class="panel-header">
			<h1 class="app-title">ArtGod {APP_VERSION}</h1>
		</header>

		{#if showListNavigation}
			<ListPagesTabs chainSlug={blockspaceState?.chain.slug ?? null} active="blockspace" />
		{/if}

		{@render blockspaceContent()}
	</section>
{:else}
	{@render blockspaceContent()}
{/if}
