<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { ApiSyncBackfillGridCell } from '$lib/api-types';
	import {
		buildSyncBackfillIsometricSlots,
		resolveSyncBackfillIsometricDimension,
		type SyncBackfillIsometricAnchorLayout,
		type SyncBackfillIsometricPoint,
		type SyncBackfillVisibleLevel
	} from '$lib/sync-backfill-isometric-levels';

	type IsometricModule = typeof import('@elchininet/isometric');

	type IsometricCanvasLayout = {
		width: number;
		height: number;
		scale: number;
		topOffsetUnits: number;
	};

	type IsometricSideCorners = {
		left: SyncBackfillIsometricPoint;
		right: SyncBackfillIsometricPoint;
	};

	type Props = {
		level: SyncBackfillVisibleLevel;
		selectionMode: boolean;
		renderKey: string;
		projectionSourceCell?: ApiSyncBackfillGridCell | null;
		isLocationMarkerCell: (
			level: SyncBackfillVisibleLevel,
			cell: ApiSyncBackfillGridCell
		) => boolean;
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
		onAnchorLayout?: (layout: SyncBackfillIsometricAnchorLayout) => void;
	};

	const ISOMETRIC_TILE_UNIT = 1;
	const ISOMETRIC_MIN_SCALE = 7;
	const ISOMETRIC_MAX_SCALE = 16;
	const ISOMETRIC_CANVAS_MARGIN = 24;
	const ISOMETRIC_BOTTOM_PAD = 16;
	const ISOMETRIC_WIDTH_FACTOR = Math.sqrt(3);
	const ISOMETRIC_DESKTOP_SIDE_ALLOWANCE = 560;
	const ISOMETRIC_MOBILE_SIDE_ALLOWANCE = 32;
	const ISOMETRIC_MARKER_FONT_SCALE = 2.1;
	const ISOMETRIC_DEPLOYMENT_MARKER_LIFT_SCALE = 1.2;
	const ISOMETRIC_LOCATION_MARKER_LIFT_SCALE = 0;
	const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

	let {
		level,
		selectionMode,
		renderKey,
		projectionSourceCell = null,
		isLocationMarkerCell,
		resolveCellClass,
		resolveCellLabel,
		onCellClick,
		onAnchorLayout
	}: Props = $props();

	let container: HTMLDivElement;
	let isometricModule = $state<IsometricModule | null>(null);
	let viewportWidth = $state(0);
	let renderError = $state<string | null>(null);
	let removeResizeListener: (() => void) | null = null;

	onMount(() => {
		const updateViewportWidth = () => {
			viewportWidth = window.innerWidth;
		};
		updateViewportWidth();
		window.addEventListener('resize', updateViewportWidth);
		removeResizeListener = () => window.removeEventListener('resize', updateViewportWidth);
		void loadIsometricModule();
	});

	onDestroy(() => {
		removeResizeListener?.();
		container?.replaceChildren();
	});

	$effect(() => {
		if (!container || !isometricModule) return;
		renderKey;
		selectionMode;
		projectionSourceCell;
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

		const layout = resolveCanvasLayout(level, viewportWidth);
		const canvas = new isometricModule.IsometricCanvas({
			container,
			backgroundColor: 'transparent',
			width: layout.width,
			height: layout.height,
			scale: layout.scale
		});
		canvas.getElement().classList.add('sync-isometric-svg');

		const group = new isometricModule.IsometricGroup({
			right: 0,
			left: 0,
			top: layout.topOffsetUnits
		});
		canvas.addChild(group);
		const sourceCorners = renderLevelTiles(group, layout, level);
		reportAnchorLayout(group, layout, level, sourceCorners);
	}

	function renderLevelTiles(
		group: InstanceType<IsometricModule['IsometricGroup']>,
		layout: IsometricCanvasLayout,
		level: SyncBackfillVisibleLevel
	): IsometricSideCorners | null {
		if (!isometricModule) return null;
		const markers: Array<{
			column: number;
			row: number;
			glyph: string;
			className: string;
			liftScale: number;
		}> = [];
		let sourceCorners: IsometricSideCorners | null = null;
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
				fillColor: 'var(--c-ice)',
				strokeColor: 'var(--c-sand)',
				strokeWidth: 1
			});
			configureTileElement(tile.getElement(), level, slot.cell);
			group.addChild(tile);
			if (isProjectionSourceCell(slot.cell)) {
				sourceCorners = resolveTileSideCorners(layout, slot.column, slot.row);
			}
			if (slot.cell.collectionDeploymentBlock) {
				markers.push({
					column: slot.column,
					row: slot.row,
					glyph: '❀',
					className: 'sync-isometric-marker-deployment',
					liftScale: ISOMETRIC_DEPLOYMENT_MARKER_LIFT_SCALE
				});
			}
			if (isLocationMarkerCell(level, slot.cell)) {
				markers.push({
					column: slot.column,
					row: slot.row,
					glyph: '⫯',
					className: 'sync-isometric-marker-location',
					liftScale: ISOMETRIC_LOCATION_MARKER_LIFT_SCALE
				});
			}
		}
		for (const marker of markers) {
			renderTileMarker(
				group,
				layout,
				marker.column,
				marker.row,
				marker.glyph,
				marker.className,
				marker.liftScale
			);
		}
		return sourceCorners;
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

		element.addEventListener('pointerdown', (event) => {
			if (event.pointerType === 'mouse') {
				event.preventDefault();
			}
		});
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

	function renderTileMarker(
		group: InstanceType<IsometricModule['IsometricGroup']>,
		layout: IsometricCanvasLayout,
		column: number,
		row: number,
		glyph: string,
		className: string,
		liftScale: number
	): void {
		const marker = document.createElementNS(SVG_NAMESPACE, 'text');
		const center = projectIsometricPoint(layout, column + 0.5, row + 0.5);
		marker.textContent = glyph;
		marker.setAttribute('x', String(center.x));
		marker.setAttribute('y', String(center.y - layout.scale * liftScale));
		marker.setAttribute('class', `sync-isometric-marker ${className}`);
		marker.setAttribute('font-size', String(Math.max(15, layout.scale * ISOMETRIC_MARKER_FONT_SCALE)));
		marker.setAttribute('text-anchor', 'middle');
		marker.setAttribute('dominant-baseline', 'central');
		marker.setAttribute('aria-hidden', 'true');
		group.getElement().appendChild(marker);
	}

	function reportAnchorLayout(
		group: InstanceType<IsometricModule['IsometricGroup']>,
		layout: IsometricCanvasLayout,
		level: SyncBackfillVisibleLevel,
		sourceCorners: IsometricSideCorners | null
	): void {
		if (!onAnchorLayout) return;
		const dimension = resolveSyncBackfillIsometricDimension(level.state.grid.length);
		const gridCorners = resolveGridSideCorners(layout, dimension);
		const groupElement = group.getElement();
		if (!(groupElement instanceof SVGGraphicsElement)) return;
		onAnchorLayout({
			levelKey: level.key,
			gridLeftCorner: toClientPoint(groupElement, gridCorners.left),
			gridRightCorner: toClientPoint(groupElement, gridCorners.right),
			sourceLeftCorner: sourceCorners ? toClientPoint(groupElement, sourceCorners.left) : null,
			sourceRightCorner: sourceCorners ? toClientPoint(groupElement, sourceCorners.right) : null
		});
	}

	function isProjectionSourceCell(cell: ApiSyncBackfillGridCell): boolean {
		return (
			projectionSourceCell !== null &&
			cell.fromBlock <= projectionSourceCell.fromBlock &&
			projectionSourceCell.toBlock <= cell.toBlock
		);
	}

	function resolveTileSideCorners(
		layout: IsometricCanvasLayout,
		column: number,
		row: number
	): IsometricSideCorners {
		return {
			left: projectIsometricPoint(layout, column, row + 1),
			right: projectIsometricPoint(layout, column + 1, row)
		};
	}

	function resolveGridSideCorners(
		layout: IsometricCanvasLayout,
		dimension: number
	): IsometricSideCorners {
		return {
			left: projectIsometricPoint(layout, 0, dimension),
			right: projectIsometricPoint(layout, dimension, 0)
		};
	}

	function toClientPoint(
		element: SVGGraphicsElement,
		point: SyncBackfillIsometricPoint
	): SyncBackfillIsometricPoint {
		const matrix = element.getScreenCTM();
		if (!matrix) return point;
		const transformed = new DOMPoint(point.x, point.y).matrixTransform(matrix);
		return {
			x: transformed.x,
			y: transformed.y
		};
	}

	function projectIsometricPoint(
		layout: IsometricCanvasLayout,
		right: number,
		left: number
	): { x: number; y: number } {
		return {
			x: layout.width / 2 + (right - left) * layout.scale * (Math.sqrt(3) / 2),
			y: layout.height / 2 + ((right + left) / 2) * layout.scale
		};
	}

	function resolveCanvasLayout(
		visibleLevel: SyncBackfillVisibleLevel,
		viewportWidth: number
	): IsometricCanvasLayout {
		const dimension = resolveSyncBackfillIsometricDimension(visibleLevel.state.grid.length);
		const sideAllowance =
			viewportWidth > 900 ? ISOMETRIC_DESKTOP_SIDE_ALLOWANCE : ISOMETRIC_MOBILE_SIDE_ALLOWANCE;
		const availableCanvasWidth = Math.max(viewportWidth - sideAllowance, 320);
		const scale = clamp(
			Math.floor(
				(availableCanvasWidth - ISOMETRIC_CANVAS_MARGIN * 2) /
					((dimension + 1) * ISOMETRIC_WIDTH_FACTOR)
			),
			ISOMETRIC_MIN_SCALE,
			ISOMETRIC_MAX_SCALE
		);
		const width = Math.ceil(
			(dimension + 1) * ISOMETRIC_WIDTH_FACTOR * scale + ISOMETRIC_CANVAS_MARGIN * 2
		);
		const height = ISOMETRIC_CANVAS_MARGIN * 2 + (dimension + 1) * scale + ISOMETRIC_BOTTOM_PAD;
		return {
			width,
			height,
			scale,
			topOffsetUnits: (height / 2 - ISOMETRIC_CANVAS_MARGIN) / scale
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
