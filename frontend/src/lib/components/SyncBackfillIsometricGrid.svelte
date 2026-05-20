<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { ApiSyncBackfillGridCell } from '$lib/api-types';
	import {
		buildSyncBackfillIsometricSlots,
		resolveSyncBackfillIsometricDimension,
		type SyncBackfillVisibleLevel
	} from '$lib/sync-backfill-isometric-levels';

	type IsometricModule = typeof import('@elchininet/isometric');

	type Props = {
		levels: SyncBackfillVisibleLevel[];
		selectionMode: boolean;
		renderKey: string;
		resolveCellClass: (
			level: SyncBackfillVisibleLevel,
			cell: ApiSyncBackfillGridCell
		) => string;
		resolveCellLabel: (
			level: SyncBackfillVisibleLevel,
			cell: ApiSyncBackfillGridCell
		) => string;
		onCellClick: (
			event: MouseEvent,
			level: SyncBackfillVisibleLevel,
			cell: ApiSyncBackfillGridCell
		) => void | Promise<void>;
	};

	const ISOMETRIC_TILE_UNIT = 1;
	const ISOMETRIC_MIN_SCALE = 7;
	const ISOMETRIC_MAX_SCALE = 16;
	const ISOMETRIC_CANVAS_MARGIN = 24;
	const ISOMETRIC_LEVEL_GAP = 56;
	const ISOMETRIC_WIDTH_FACTOR = Math.sqrt(3);

	let {
		levels,
		selectionMode,
		renderKey,
		resolveCellClass,
		resolveCellLabel,
		onCellClick
	}: Props = $props();

	let container: HTMLDivElement;
	let isometricModule = $state<IsometricModule | null>(null);
	let containerWidth = $state(0);
	let renderError = $state<string | null>(null);
	let resizeObserver: ResizeObserver | null = null;

	onMount(() => {
		containerWidth = container?.clientWidth ?? 0;
		resizeObserver = new ResizeObserver((entries) => {
			containerWidth = Math.floor(entries[0]?.contentRect.width ?? container?.clientWidth ?? 0);
		});
		if (container) {
			resizeObserver.observe(container);
		}
		void loadIsometricModule();
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		container?.replaceChildren();
	});

	$effect(() => {
		if (!container || !isometricModule) return;
		renderKey;
		selectionMode;
		renderLevels();
	});

	async function loadIsometricModule(): Promise<void> {
		try {
			isometricModule = await import('@elchininet/isometric');
		} catch {
			renderError = 'isometric renderer unavailable';
		}
	}

	function renderLevels(): void {
		if (!container || !isometricModule) return;
		container.replaceChildren();
		renderError = null;
		if (levels.length === 0) return;

		const layout = resolveCanvasLayout(levels, containerWidth || container.clientWidth);
		const canvas = new isometricModule.IsometricCanvas({
			container,
			backgroundColor: 'transparent',
			width: layout.width,
			height: layout.height,
			scale: layout.scale
		});
		canvas.getElement().classList.add('sync-isometric-svg');

		levels.forEach((level, index) => {
			const group = new isometricModule!.IsometricGroup({
				right: layout.levelOffsets[index] / layout.scale,
				left: layout.levelOffsets[index] / layout.scale,
				top: layout.topOffsetUnits
			});
			canvas.addChild(group);
			renderLevelTiles(group, level);
		});
	}

	function renderLevelTiles(
		group: InstanceType<IsometricModule['IsometricGroup']>,
		level: SyncBackfillVisibleLevel
	): void {
		if (!isometricModule) return;
		for (const slot of buildSyncBackfillIsometricSlots(level.state.grid)) {
			if (!slot.cell) {
				group.addChild(
					new isometricModule.IsometricRectangle({
						planeView: isometricModule.PlaneView.TOP,
						right: slot.column,
						left: slot.row,
						top: 0,
						width: ISOMETRIC_TILE_UNIT,
						height: ISOMETRIC_TILE_UNIT,
						className: 'sync-isometric-tile sync-isometric-tile-padding',
						fillColor: 'transparent',
						strokeColor: 'transparent',
						strokeWidth: 1
					})
				);
				continue;
			}

			const tile = new isometricModule.IsometricRectangle({
				planeView: isometricModule.PlaneView.TOP,
				right: slot.column,
				left: slot.row,
				top: 0,
				width: ISOMETRIC_TILE_UNIT,
				height: ISOMETRIC_TILE_UNIT,
				className: resolveCellClass(level, slot.cell),
				fillColor: 'var(--c-sand)',
				strokeColor: 'var(--c-bg)',
				strokeWidth: 1
			});
			configureTileElement(tile.getElement(), level, slot.cell);
			group.addChild(tile);
		}
	}

	function configureTileElement(
		element: SVGElement,
		level: SyncBackfillVisibleLevel,
		cell: ApiSyncBackfillGridCell
	): void {
		const disabled = cell.blockCount <= 0;
		const label = resolveCellLabel(level, cell);
		element.setAttribute('aria-label', label);
		element.setAttribute('title', label);
		element.setAttribute('role', 'button');
		element.setAttribute('tabindex', disabled ? '-1' : '0');
		element.setAttribute('aria-disabled', disabled ? 'true' : 'false');
		if (disabled) return;

		element.addEventListener('click', (event) => {
			if (event instanceof MouseEvent) {
				void onCellClick(event, level, cell);
			}
		});
		element.addEventListener('keydown', (event) => {
			if (!(event instanceof KeyboardEvent)) return;
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			void onCellClick(
				new MouseEvent('click', {
					ctrlKey: event.ctrlKey,
					metaKey: event.metaKey,
					shiftKey: event.shiftKey,
					altKey: event.altKey
				}),
				level,
				cell
			);
		});
	}

	function resolveCanvasLayout(
		visibleLevels: SyncBackfillVisibleLevel[],
		availableWidth: number
	): {
		width: number;
		height: number;
		scale: number;
		topOffsetUnits: number;
		levelOffsets: number[];
	} {
		const dimensions = visibleLevels.map((level) =>
			resolveSyncBackfillIsometricDimension(level.state.grid.length)
		);
		const maxDimension = Math.max(...dimensions, 1);
		const availableCanvasWidth = Math.max(availableWidth, 320);
		const scale = clamp(
			Math.floor(
				(availableCanvasWidth - ISOMETRIC_CANVAS_MARGIN * 2) /
					((maxDimension + 1) * ISOMETRIC_WIDTH_FACTOR)
			),
			ISOMETRIC_MIN_SCALE,
			ISOMETRIC_MAX_SCALE
		);
		const width = Math.ceil(
			(maxDimension + 1) * ISOMETRIC_WIDTH_FACTOR * scale + ISOMETRIC_CANVAS_MARGIN * 2
		);
		const levelHeights = dimensions.map((dimension) => (dimension + 1) * scale);
		const levelOffsets = levelHeights.reduce<number[]>((offsets, height, index) => {
			offsets.push(index === 0 ? 0 : offsets[index - 1] + levelHeights[index - 1] + ISOMETRIC_LEVEL_GAP);
			return offsets;
		}, []);
		const height =
			ISOMETRIC_CANVAS_MARGIN * 2 +
			levelHeights.reduce((sum, levelHeight) => sum + levelHeight, 0) +
			Math.max(visibleLevels.length - 1, 0) * ISOMETRIC_LEVEL_GAP;
		return {
			width,
			height,
			scale,
			topOffsetUnits: (height / 2 - ISOMETRIC_CANVAS_MARGIN) / scale,
			levelOffsets
		};
	}

	function clamp(value: number, minimum: number, maximum: number): number {
		return Math.min(Math.max(value, minimum), maximum);
	}
</script>

<div class={`sync-isometric-grid ${selectionMode ? 'sync-isometric-grid-selection-mode' : ''}`}>
	<div bind:this={container} class="sync-isometric-canvas" aria-label="Block sync coverage grid"></div>
	{#if renderError}
		<div class="sync-range-detail-status muted">{renderError}</div>
	{/if}
</div>
