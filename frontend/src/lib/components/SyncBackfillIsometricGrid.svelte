<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { ApiSyncBackfillGridCell } from '$lib/api-types';
	import {
		buildSyncBackfillIsometricSlots,
		resolveSyncBackfillIsometricDimension,
		type SyncBackfillVisibleLevel
	} from '$lib/sync-backfill-isometric-levels';

	type IsometricModule = typeof import('@elchininet/isometric');

	type IsometricCanvasLayout = {
		width: number;
		height: number;
		scale: number;
		topOffsetUnits: number;
	};

	type Props = {
		level: SyncBackfillVisibleLevel;
		selectionMode: boolean;
		renderKey: string;
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
	};

	const ISOMETRIC_TILE_UNIT = 1;
	const ISOMETRIC_MIN_SCALE = 7;
	const ISOMETRIC_MAX_SCALE = 16;
	const ISOMETRIC_CANVAS_MARGIN = 24;
	const ISOMETRIC_BOTTOM_PAD = 16;
	const ISOMETRIC_WIDTH_FACTOR = Math.sqrt(3);
	const ISOMETRIC_MARKER_FONT_SCALE = 1.9;
	const ISOMETRIC_DESKTOP_SIDE_ALLOWANCE = 560;
	const ISOMETRIC_MOBILE_SIDE_ALLOWANCE = 32;
	const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

	let {
		level,
		selectionMode,
		renderKey,
		isLocationMarkerCell,
		resolveCellClass,
		resolveCellLabel,
		onCellClick
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
		renderLevelTiles(group, layout, level);
	}

	function renderLevelTiles(
		group: InstanceType<IsometricModule['IsometricGroup']>,
		layout: IsometricCanvasLayout,
		level: SyncBackfillVisibleLevel
	): void {
		if (!isometricModule) return;
		const markers: Array<{
			column: number;
			row: number;
			glyph: string;
			className: string;
		}> = [];
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
			if (slot.cell.collectionDeploymentBlock) {
				markers.push({
					column: slot.column,
					row: slot.row,
					glyph: '❀',
					className: 'sync-isometric-marker-deployment'
				});
			}
			if (isLocationMarkerCell(level, slot.cell)) {
				markers.push({
					column: slot.column,
					row: slot.row,
					glyph: '⫯',
					className: 'sync-isometric-marker-location'
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
				marker.className
			);
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
		className: string
	): void {
		const marker = document.createElementNS(SVG_NAMESPACE, 'text');
		const center = resolveTileCenter(layout, column + 0.5, row + 0.5);
		marker.textContent = glyph;
		marker.setAttribute('x', String(center.x));
		marker.setAttribute('y', String(center.y));
		marker.setAttribute('class', `sync-isometric-marker ${className}`);
		marker.setAttribute('font-size', String(Math.max(15, layout.scale * ISOMETRIC_MARKER_FONT_SCALE)));
		marker.setAttribute('text-anchor', 'middle');
		marker.setAttribute('dominant-baseline', 'central');
		marker.setAttribute('aria-hidden', 'true');
		group.getElement().appendChild(marker);
	}

	function resolveTileCenter(
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
