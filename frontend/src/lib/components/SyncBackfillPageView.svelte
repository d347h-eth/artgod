<script lang="ts">
	import { goto, pushState } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, tick } from 'svelte';
	import {
		SYNC_BACKFILL_CONTEXT_ANY,
		SYNC_BACKFILL_GRID_CELL_COUNT
	} from '@artgod/shared/config/sync-backfill';
	import type {
		ApiSyncBackfillGridCell,
		ApiSyncBackfillRangeSummary,
		SyncBackfillRangeSummaryApiResponse,
		SyncBackfillStateApiResponse
	} from '$lib/api-types';
	import {
		getSyncBackfillRangeSummary,
		getSyncBackfillState,
		scheduleSyncBackfill
	} from '$lib/backend-api';
	import SyncBackfillIsometricGrid from '$lib/components/SyncBackfillIsometricGrid.svelte';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import SyncBackfillSummary from '$lib/components/SyncBackfillSummary.svelte';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import { buildSyncBackfillIsometricLevelRenderKey } from '$lib/sync-backfill-isometric-levels';
	import type {
		SyncBackfillIsometricAnchorLayout,
		SyncBackfillIsometricPoint,
		SyncBackfillVisibleLevel
	} from '$lib/sync-backfill-isometric-levels';
	import {
		buildSyncBackfillStackFetchPlan,
		buildSyncBackfillStackStateApiParams,
		buildSyncBackfillVisibleLevels,
		buildSyncBackfillVisibleStackPages,
		formatSyncBackfillPageStackEntry,
		parseSyncBackfillPageStack,
		resolveSyncBackfillStackAnchorLevelKey,
		type SyncBackfillStackPage
	} from '$lib/sync-backfill-page-stack';
	import { startSyncBackfillLiveRefresh } from '$lib/sync-backfill-live-refresh';
	import {
		formatSyncBackfillAnchoredBlockDuration,
		formatSyncBackfillBlockRange,
		formatSyncBackfillInteger
	} from '$lib/sync-backfill-format';

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

	type StackNavigationOptions = {
		updateUrl?: boolean;
	};

	type RouteStackNavigation = {
		collection: string;
		stack: string[];
		stackKey: string;
	};

	type ProjectionLine = {
		key: string;
		start: SyncBackfillIsometricPoint;
		end: SyncBackfillIsometricPoint;
	};

	type ProjectionAnchorLayout = {
		gridLeftCorner: SyncBackfillIsometricPoint;
		gridRightCorner: SyncBackfillIsometricPoint;
		sourceLeftCorner: SyncBackfillIsometricPoint | null;
		sourceRightCorner: SyncBackfillIsometricPoint | null;
	};

	const PROJECTION_SOURCE_GAP_PX = 8;
	const PROJECTION_TARGET_GAP_PX = 14;

	let {
		state: pageSyncState,
		levels: pageLevels = [],
		basePath,
		collection: pageCollection,
		stack: pageStack
	}: {
		state: SyncBackfillStateApiResponse | null;
		levels?: SyncBackfillVisibleLevel[];
		basePath: string;
		collection: string;
		stack: string[];
	} = $props();

	let syncState = $state<SyncBackfillStateApiResponse | null>(pageSyncState);
	let levels = $state<SyncBackfillVisibleLevel[]>(pageLevels);
	let collection = $state(pageCollection);
	let stack = $state<string[]>(pageStack);
	let submitting = $state(false);
	let feedback: string | null = $state(null);
	let selectedRangeSummary: SyncBackfillRangeSummaryApiResponse | null = $state(null);
	let selectedRangeLoading = $state(false);
	let selectedRangeError: string | null = $state(null);
	let selectedRangeLevelKey: string | null = $state(null);
	let selectedLocationMarker: BlockRangeSelection | null = $state(null);
	let selectedRangeRequestId = 0;
	let selectedRangeRefreshKey: string | null = $state(null);
	let selectedRangeRefreshRequestId = 0;
	let selectedRangeRefreshInFlight = $state(false);
	let drilldownRequestId = 0;
	let liveRefreshRequestId = 0;
	let backfillSelectionMode = $state(false);
	let backfillSelectionFromBlock: number | null = $state(null);
	let backfillSelectionLevelKey: string | null = $state(null);
	let backfillSelectionRange: BlockRangeSelection | null = $state(null);
	let levelsLayoutElement = $state<HTMLDivElement | null>(null);
	let isometricAnchorLayouts = $state<Record<string, ProjectionAnchorLayout>>({});
	let reservedLevelsLayoutHeight = $state(0);

	let selectedCollection = $derived(syncState?.context.selected ?? collection ?? SYNC_BACKFILL_CONTEXT_ANY);
	let currentPageKey = $derived(
		syncState
			? `${syncState.chain.slug}:${selectedCollection}:${syncState.range.fromBlock}:${syncState.range.toBlock}:${syncState.range.bucketSize}`
			: null
	);
	let selectedRangeScopeKey = $derived(`${basePath}:${selectedCollection}:${stack.join(',')}`);
	let visibleLevels = $derived(
		levels.length > 0
			? levels
			: syncState
				? [{ key: 'root', label: 'root', stack: [], state: syncState }]
				: []
	);
	let routeStackNavigation = $derived(resolveRouteStackNavigation(page.url.searchParams));
	let visibleLevelsLiveKey = $derived(
		visibleLevels.map((level) => buildSyncBackfillIsometricLevelRenderKey(level)).join('||')
	);
	let isometricRenderKey = $derived(
		[
			currentPageKey,
			backfillSelectionMode ? 'selection' : 'normal',
			backfillSelectionLevelKey ?? '',
			backfillSelectionFromBlock ?? '',
			formatBackfillSelectionRangeKey(backfillSelectionRange)
		].join('|')
	);
	let projectionLines = $derived(resolveProjectionLines(visibleLevels, isometricAnchorLayouts));
	let activeSelectedRangeScopeKey: string | null = $state(null);

	onMount(() => {
		if (!syncState) return;
		const refresh = startSyncBackfillLiveRefresh({ refresh: refreshVisibleStack });
		return refresh.stop;
	});

	$effect(() => {
		syncState = pageSyncState;
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
		clearRangeSummary();
	});

	$effect(() => {
		if (!routeStackNavigation) return;
		if (routeStackNavigation.collection !== selectedCollection) return;
		if (routeStackNavigation.stackKey === stack.join(',')) return;
		const anchorLevelKey = resolveSyncBackfillStackAnchorLevelKey(
			stack,
			routeStackNavigation.stack,
			visibleLevels
		);
		void navigateToStack(routeStackNavigation.stack, anchorLevelKey, {
			updateUrl: false
		});
	});

	$effect(() => {
		const range = selectedLocationMarker;
		if (!range || selectedRangeLoading || selectedRangeRefreshInFlight) return;
		const refreshKey = formatRangeSummaryRefreshKey(range, visibleLevelsLiveKey);
		if (selectedRangeRefreshKey === refreshKey) return;
		void loadRangeSummary(range, { showLoading: false, showError: false });
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
		if (nextCollection && nextCollection !== SYNC_BACKFILL_CONTEXT_ANY) {
			query.set('collection', nextCollection);
		}
		if (nextStack.length > 0) {
			query.set('stack', nextStack.join(','));
		}
		const suffix = query.toString();
		return suffix ? `${basePath}?${suffix}` : basePath;
	}

	function resolveRouteStackNavigation(searchParams: URLSearchParams): RouteStackNavigation | null {
		const parsedStack = parseSyncBackfillPageStack(searchParams.get('stack'));
		if (!parsedStack) return null;
		const collection = searchParams.get('collection')?.trim() || SYNC_BACKFILL_CONTEXT_ANY;
		const stack = parsedStack.map(formatSyncBackfillPageStackEntry);
		return {
			collection,
			stack,
			stackKey: stack.join(',')
		};
	}

	function onCollectionChange(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return;
		feedback = null;
		void goto(queryHref(target.value, stack));
	}

	async function handleCellClick(
		event: MouseEvent,
		level: SyncBackfillVisibleLevel,
		cell: ApiSyncBackfillGridCell
	): Promise<void> {
		if (backfillSelectionMode) {
			await handleBackfillSelectionClick(level, cell);
			return;
		}
		if (event.ctrlKey) {
			await loadRangeSummary({
				fromBlock: cell.fromBlock,
				toBlock: cell.toBlock,
				bucketSize: level.state.range.bucketSize,
				levelKey: level.key,
				markerBlock: cell.fromBlock
			});
			return;
		}
		if (cell.canDrillDown) {
			const childBucketSize = level.state.range.bucketSize / SYNC_BACKFILL_GRID_CELL_COUNT;
			if (Number.isInteger(childBucketSize) && childBucketSize >= 1) {
				feedback = null;
				await navigateToStack(
					[
						...level.stack,
						formatSyncBackfillPageStackEntry({
							pageStartBlock: cell.fromBlock,
							bucketSize: childBucketSize
						})
					],
					level.key
				);
			}
			return;
		}
		if (cell.blockCount === 1) {
			await loadRangeSummary({
				fromBlock: cell.fromBlock,
				toBlock: cell.toBlock,
				bucketSize: level.state.range.bucketSize,
				levelKey: level.key,
				markerBlock: cell.fromBlock
			});
		}
	}

	async function handleBackfillSelectionClick(
		level: SyncBackfillVisibleLevel,
		cell: ApiSyncBackfillGridCell
	): Promise<void> {
		if (cell.blockCount <= 0) return;
		feedback = null;
		if (backfillSelectionFromBlock === null) {
			backfillSelectionFromBlock = cell.fromBlock;
			backfillSelectionLevelKey = level.key;
			backfillSelectionRange = null;
			clearRangeSummary();
			return;
		}
		if (backfillSelectionLevelKey !== level.key) {
			feedback = 'select to block on the same level';
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
			feedback = `select to block >= ${formatSyncBackfillInteger(nextRange.fromBlock)}`;
			return;
		}

		backfillSelectionFromBlock = null;
		backfillSelectionLevelKey = null;
		backfillSelectionRange = nextRange;
		await loadRangeSummary(nextRange);
	}

	function beginBackfillSelection(): void {
		if (!syncState) return;
		backfillSelectionMode = true;
		backfillSelectionFromBlock = null;
		backfillSelectionLevelKey = null;
		backfillSelectionRange = null;
		feedback = null;
		clearRangeSummary();
	}

	function cancelBackfillSelection(): void {
		backfillSelectionMode = false;
		backfillSelectionFromBlock = null;
		backfillSelectionLevelKey = null;
		backfillSelectionRange = null;
		feedback = null;
		clearRangeSummary();
	}

	function formatBackfillSelectionRangeKey(range: BlockRangeSelection | null): string {
		return range ? `${range.levelKey}:${range.fromBlock}:${range.toBlock}:${range.markerBlock}` : '';
	}

	function formatRangeSummaryRefreshKey(range: BlockRangeSelection, liveKey: string): string {
		return `${formatBackfillSelectionRangeKey(range)}:${liveKey}`;
	}

	function handleIsometricAnchorLayout(layout: SyncBackfillIsometricAnchorLayout): void {
		if (!levelsLayoutElement) return;
		const bounds = levelsLayoutElement.getBoundingClientRect();
		const nextLayout = {
			gridLeftCorner: toLayoutPoint(layout.gridLeftCorner, bounds),
			gridRightCorner: toLayoutPoint(layout.gridRightCorner, bounds),
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
		if (!syncState) return;
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
			syncState = nextState;
			levels = buildSyncBackfillVisibleLevels(nextStack, states);
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
				feedback = error instanceof Error ? error.message : 'sync level request failed';
			}
		}
	}

	async function refreshVisibleStack(): Promise<void> {
		if (!syncState) return;
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
				buildSyncBackfillVisibleStackPages(refreshStack)
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
			syncState = nextState;
			levels = buildSyncBackfillVisibleLevels(refreshStack, states);
			collection = refreshCollection;
			await tick();
			restoreLevelAnchor(anchorLevelKey, anchorTop);
		} catch {
			// Keep the visible stack stable after transient live-refresh failures.
		}
	}

	async function fetchChangedStackStates(
		nextCollection: string,
		nextStack: string[]
	): Promise<SyncBackfillStateApiResponse[]> {
		const plan = buildSyncBackfillStackFetchPlan(stack, nextStack, visibleLevels);
		const fetchedStates = await fetchStackPages(nextCollection, plan.pagesToFetch);
		return [...plan.reusedStates, ...fetchedStates];
	}

	async function fetchStackPages(
		nextCollection: string,
		stackPages: SyncBackfillStackPage[]
	): Promise<SyncBackfillStateApiResponse[]> {
		if (!syncState) return [];
		const chainSlug = syncState.chain.slug;
		return Promise.all(
			buildSyncBackfillStackStateApiParams(nextCollection, stackPages).map((apiParams) => {
				// Fetch visible level state directly so component-owned refreshes avoid route reloads.
				return getSyncBackfillState(fetch, chainSlug, apiParams);
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
		const anchors = levelsLayoutElement.querySelectorAll<HTMLElement>('[data-sync-level-anchor]');
		return (
			Array.from(anchors).find((element) => element.dataset.syncLevelAnchor === levelKey) ?? null
		);
	}

	function clearRangeSummary(): void {
		selectedRangeRequestId += 1;
		selectedRangeSummary = null;
		selectedRangeLoading = false;
		selectedRangeError = null;
		selectedRangeLevelKey = null;
		selectedLocationMarker = null;
		selectedRangeRefreshKey = null;
		selectedRangeRefreshRequestId = 0;
		selectedRangeRefreshInFlight = false;
	}

	async function loadRangeSummary(
		range: BlockRangeSelection,
		options: RangeSummaryLoadOptions = {}
	): Promise<void> {
		if (!syncState || range.fromBlock > range.toBlock) return;
		const showLoading = options.showLoading ?? true;
		const showError = options.showError ?? true;
		const requestId = selectedRangeRequestId + 1;
		selectedRangeRequestId = requestId;
		selectedRangeRefreshKey = formatRangeSummaryRefreshKey(range, visibleLevelsLiveKey);
		if (showLoading) {
			selectedRangeLoading = true;
		} else {
			selectedRangeRefreshRequestId = requestId;
			selectedRangeRefreshInFlight = true;
		}
		if (showError) {
			selectedRangeError = null;
		}
		selectedRangeLevelKey = range.levelKey;
		selectedLocationMarker = range;
		try {
			const params = new URLSearchParams();
			params.set('from_block', String(range.fromBlock));
			params.set('to_block', String(range.toBlock));
			if (selectedCollection !== SYNC_BACKFILL_CONTEXT_ANY) {
				params.set('collection', selectedCollection);
			}
			const summary = await getSyncBackfillRangeSummary(fetch, syncState.chain.slug, params);
			if (selectedRangeRequestId === requestId) {
				selectedRangeSummary = {
					...summary,
					range: {
						...summary.range,
						bucketSize: range.bucketSize
					}
				};
			}
		} catch (error) {
			if (showError && selectedRangeRequestId === requestId) {
				selectedRangeError = error instanceof Error ? error.message : 'range request failed';
			}
		} finally {
			if (showLoading) {
				if (selectedRangeRequestId === requestId) {
					selectedRangeLoading = false;
				}
			} else {
				if (selectedRangeRefreshRequestId === requestId) {
					selectedRangeRefreshInFlight = false;
				}
			}
		}
	}

	async function commitBackfillSelection(): Promise<void> {
		if (!syncState || !backfillSelectionRange) return;
		submitting = true;
		feedback = null;
		try {
			const result = await scheduleSyncBackfill(fetch, syncState.chain.slug, {
				collectionRef:
					selectedCollection === SYNC_BACKFILL_CONTEXT_ANY ? null : selectedCollection,
				fromBlock: backfillSelectionRange.fromBlock,
				toBlock: backfillSelectionRange.toBlock
			});
			feedback = `queued ${result.queuedJobs} job${result.queuedJobs === 1 ? '' : 's'}`;
			backfillSelectionMode = false;
			backfillSelectionFromBlock = null;
			backfillSelectionLevelKey = null;
			backfillSelectionRange = null;
			await refreshVisibleStack();
		} catch (error) {
			feedback = error instanceof Error ? error.message : 'backfill request failed';
		} finally {
			submitting = false;
		}
	}

	function cellClass(level: SyncBackfillVisibleLevel, cell: ApiSyncBackfillGridCell): string {
		const classes = ['sync-isometric-tile', `sync-isometric-tile-${cell.state}`];
		if (cell.blockCount <= 0) {
			classes.push('sync-isometric-tile-disabled');
		}
		if (cell.collectionDeploymentBlock) {
			classes.push(
				cell.collectionDeploymentBlock.synced
					? 'sync-isometric-tile-deployment-synced'
					: 'sync-isometric-tile-deployment-unsynced'
			);
		}
		if (isSelectionCell(level.key, cell)) {
			classes.push('sync-isometric-tile-selected');
		}
		return classes.join(' ');
	}

	function cellLabel(level: SyncBackfillVisibleLevel, cell: ApiSyncBackfillGridCell): string {
		const range = formatRange(cell.fromBlock, cell.toBlock, cell.blockCount);
		const duration =
			cell.blockCount > 0
				? `, ${formatVisibleBlockDuration(level.state, cell.blockCount)}`
				: '';
		const marker = cell.collectionDeploymentBlock
			? `, deployment block ${formatSyncBackfillInteger(cell.collectionDeploymentBlock.blockNumber)} ${
					cell.collectionDeploymentBlock.synced ? 'synced' : 'not synced'
				}`
			: '';
		const action = resolveCellActionLabel(cell);
		return `${range}: ${formatSyncBackfillInteger(cell.syncedBlockCount)}/${formatSyncBackfillInteger(cell.blockCount)} synced${duration}${marker}${action}`;
	}

	function formatRange(fromBlock: number, toBlock: number, blockCount: number): string {
		if (blockCount <= 0) return 'outside range';
		if (fromBlock === toBlock) return `block ${formatSyncBackfillInteger(fromBlock)}`;
		return formatSyncBackfillBlockRange(fromBlock, toBlock);
	}

	function resolveCellActionLabel(cell: ApiSyncBackfillGridCell): string {
		if (backfillSelectionMode) {
			return backfillSelectionFromBlock === null
				? ', click to select from block'
				: ', click to select to block';
		}
		if (cell.canDrillDown) return ', ctrl-click for range details';
		if (cell.blockCount === 1) return ', click for block details';
		return '';
	}

	function isSelectionCell(levelKey: string, cell: ApiSyncBackfillGridCell): boolean {
		if (!backfillSelectionMode || cell.blockCount <= 0) return false;
		if (backfillSelectionRange) {
			if (backfillSelectionRange.levelKey !== levelKey) return false;
			return rangesOverlap(cell, backfillSelectionRange);
		}
		if (backfillSelectionLevelKey !== levelKey) return false;
		return rangeContainsBlock(cell, backfillSelectionFromBlock);
	}

	function isLocationMarkerCell(
		level: SyncBackfillVisibleLevel,
		cell: ApiSyncBackfillGridCell
	): boolean {
		return (
			selectedLocationMarker?.levelKey === level.key &&
			rangeContainsBlock(cell, selectedLocationMarker.markerBlock)
		);
	}

	function rangesOverlap(cell: ApiSyncBackfillGridCell, range: BlockRangeSelection): boolean {
		return cell.fromBlock <= range.toBlock && range.fromBlock <= cell.toBlock;
	}

	function rangeContainsBlock(
		cell: ApiSyncBackfillGridCell,
		blockNumber: number | null
	): boolean {
		return blockNumber !== null && cell.fromBlock <= blockNumber && blockNumber <= cell.toBlock;
	}

	function resolveProjectionSourceCell(
		level: SyncBackfillVisibleLevel,
		levelIndex: number
	): ApiSyncBackfillGridCell | null {
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
		levels: SyncBackfillVisibleLevel[],
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

	function insetProjectionLine(
		start: SyncBackfillIsometricPoint,
		end: SyncBackfillIsometricPoint
	): { start: SyncBackfillIsometricPoint; end: SyncBackfillIsometricPoint } {
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
		point: SyncBackfillIsometricPoint,
		bounds: DOMRect
	): SyncBackfillIsometricPoint {
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
			pointsEqual(left.gridLeftCorner, right.gridLeftCorner) &&
			pointsEqual(left.gridRightCorner, right.gridRightCorner) &&
			nullablePointsEqual(left.sourceLeftCorner, right.sourceLeftCorner) &&
			nullablePointsEqual(left.sourceRightCorner, right.sourceRightCorner)
		);
	}

	function nullablePointsEqual(
		left: SyncBackfillIsometricPoint | null,
		right: SyncBackfillIsometricPoint | null
	): boolean {
		if (left === null || right === null) return left === right;
		return pointsEqual(left, right);
	}

	function pointsEqual(
		left: SyncBackfillIsometricPoint,
		right: SyncBackfillIsometricPoint
	): boolean {
		return Math.abs(left.x - right.x) < 0.5 && Math.abs(left.y - right.y) < 0.5;
	}

	function buildLevelSummaryRange(level: SyncBackfillVisibleLevel): ApiSyncBackfillRangeSummary {
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
		state: SyncBackfillStateApiResponse,
		blockCount: number
	): string {
		return formatSyncBackfillAnchoredBlockDuration({
			blockCount,
			pageBlockCount: state.range.blockCount,
			pageDurationSeconds: state.range.time.durationSeconds,
			averageBlockTimeSeconds: state.chain.averageBlockTimeSeconds
		});
	}

</script>

<section class="panel">
	<header class="panel-header">
		<h1 class="app-title">ArtGod {APP_VERSION}</h1>
	</header>

	<ListPagesTabs chainSlug={syncState?.chain.slug ?? null} active="sync-backfill" />

	<header class="panel-header sync-backfill-controls-header">
		<div>
			<p class="panel-subtitle">
				{#if syncState}
					{syncState.chain.name} ({syncState.chain.slug} / {syncState.chain.publicChainId})
				{:else}
					Loading chain...
				{/if}
			</p>
		</div>
		<div class="sync-toolbar">
			<label class="status-form" for="sync-collection">
				<span>context</span>
				<select id="sync-collection" value={selectedCollection} onchange={onCollectionChange}>
					<option value={SYNC_BACKFILL_CONTEXT_ANY}>any</option>
					{#each syncState?.context.collections ?? [] as option}
						<option value={option.slug}>{option.slug}</option>
					{/each}
				</select>
			</label>
		</div>
	</header>

	{#if syncState}
		<div class="sync-backfill-content">
			<div
				class="sync-levels-layout"
				style:min-height={reservedLevelsLayoutHeight > 0
					? `${reservedLevelsLayoutHeight}px`
					: undefined}
				bind:this={levelsLayoutElement}
			>
				<svg class="sync-projection-overlay" aria-hidden="true">
					{#each projectionLines as line (line.key)}
						<line
							class="sync-projection-line"
							x1={line.start.x}
							y1={line.start.y}
							x2={line.end.x}
							y2={line.end.y}
						/>
					{/each}
				</svg>
				{#each visibleLevels as level, levelIndex (levelIndex)}
					<section class="sync-level-row" aria-label={`${level.label} sync level`}>
						<aside class="sync-level-summary-panel">
							<SyncBackfillSummary
								chain={level.state.chain}
								range={buildLevelSummaryRange(level)}
								ariaLabel={`${level.label} sync summary`}
							/>
						</aside>
						<div class="sync-grid-wrap" data-sync-level-anchor={level.key}>
							<SyncBackfillIsometricGrid
								{level}
								selectionMode={backfillSelectionMode}
								renderKey={`${isometricRenderKey}:${buildSyncBackfillIsometricLevelRenderKey(level)}`}
								projectionSourceCell={resolveProjectionSourceCell(level, levelIndex)}
								{isLocationMarkerCell}
								resolveCellClass={cellClass}
								resolveCellLabel={cellLabel}
								onCellClick={handleCellClick}
								onAnchorLayout={handleIsometricAnchorLayout}
							/>
						</div>
						<aside class="sync-level-selection-panel">
							{#if selectedRangeLevelKey === level.key}
								{#if selectedRangeLoading}
									<div class="sync-range-detail-status muted">loading range</div>
								{:else if selectedRangeError}
									<div class="sync-range-detail-status muted">{selectedRangeError}</div>
								{:else if selectedRangeSummary}
									<SyncBackfillSummary
										chain={selectedRangeSummary.chain}
										range={selectedRangeSummary.range}
										ariaLabel="Selected range summary"
									/>
								{/if}
							{/if}
						</aside>
					</section>
				{/each}
			</div>

			<div
				class={`sync-backfill-actions ${backfillSelectionMode ? 'sync-backfill-actions-selection' : ''}`}
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
						disabled={!backfillSelectionRange || submitting}
					>
						{submitting ? 'queueing...' : 'commit to backfill'}
					</button>
				{:else}
					<button type="button" onclick={beginBackfillSelection} disabled={!syncState || submitting}>
						backfill range
					</button>
				{/if}
				{#if feedback}
					<span class="muted">{feedback}</span>
				{/if}
			</div>
		</div>
	{:else}
		<div class="empty-cell">loading sync state</div>
	{/if}
</section>
