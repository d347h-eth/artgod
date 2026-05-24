<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type {
		TerraformsLevelSummary,
		TerraformsLevelZoneBucket
	} from '@artgod/shared/extensions/terraforms';
	import {
		TERRAFORMS_HYPERCASTLE_ARIA_LABELS,
		TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES,
		TERRAFORMS_HYPERCASTLE_ISOMETRIC_CLASSES,
		TERRAFORMS_HYPERCASTLE_ISOMETRIC_RENDER_ERROR,
		TERRAFORMS_HYPERCASTLE_LABELS
	} from '$lib/collection-extension-pages/terraforms/constants';
	import {
		buildTerraformsHypercastleIsometricBands,
		type TerraformsHypercastleIsometricBand
	} from '$lib/collection-extension-pages/terraforms/hypercastle-isometric-level';

	type IsometricModule = typeof import('@elchininet/isometric');

	type IsometricCanvasLayout = {
		width: number;
		height: number;
		scale: number;
		topOffsetUnits: number;
	};

	type Props = {
		level: TerraformsLevelSummary;
		selectedBucketIndex: number | null;
		renderKey: string;
		onBucketSelect: (bucket: TerraformsLevelZoneBucket) => void;
	};

	const ISOMETRIC_CANVAS_MARGIN = 20;
	const ISOMETRIC_BOTTOM_PAD = 16;
	const ISOMETRIC_WIDTH_FACTOR = Math.sqrt(3);
	const ISOMETRIC_MIN_SCALE = 5;
	const ISOMETRIC_MAX_SCALE = 11;
	const ISOMETRIC_DESKTOP_SIDE_ALLOWANCE = 700;
	const ISOMETRIC_MOBILE_SIDE_ALLOWANCE = 38;
	const ISOMETRIC_MIN_AVAILABLE_WIDTH = 300;
	const POINTER_TYPE_MOUSE = 'mouse';
	const KEYBOARD_SELECT_KEYS = new Set(['Enter', ' ']);

	let { level, selectedBucketIndex, renderKey, onBucketSelect }: Props = $props();

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
		selectedBucketIndex;
		renderLevel();
	});

	async function loadIsometricModule(): Promise<void> {
		try {
			isometricModule = await import('@elchininet/isometric');
		} catch {
			renderError = TERRAFORMS_HYPERCASTLE_ISOMETRIC_RENDER_ERROR;
		}
	}

	function renderLevel(): void {
		if (!container || !isometricModule) return;
		container.replaceChildren();
		renderError = null;

		const bands = buildTerraformsHypercastleIsometricBands(level);
		const layout = resolveCanvasLayout(bands, viewportWidth);
		const canvas = new isometricModule.IsometricCanvas({
			container,
			backgroundColor: 'transparent',
			width: layout.width,
			height: layout.height,
			scale: layout.scale
		});
		canvas.getElement().classList.add(TERRAFORMS_HYPERCASTLE_ISOMETRIC_CLASSES.Svg);

		const group = new isometricModule.IsometricGroup({
			right: 0,
			left: 0,
			top: layout.topOffsetUnits
		});
		canvas.addChild(group);
		for (const band of bands) {
			renderBand(group, band);
		}
	}

	function renderBand(
		group: InstanceType<IsometricModule['IsometricGroup']>,
		band: TerraformsHypercastleIsometricBand
	): void {
		if (!isometricModule) return;
		const className =
			band.bucket.topographyBucketIndex === selectedBucketIndex
				? `${TERRAFORMS_HYPERCASTLE_ISOMETRIC_CLASSES.Band} ${TERRAFORMS_HYPERCASTLE_ISOMETRIC_CLASSES.BandSelected}`
				: TERRAFORMS_HYPERCASTLE_ISOMETRIC_CLASSES.Band;
		const rectangle = new isometricModule.IsometricRectangle({
			planeView: isometricModule.PlaneView.TOP,
			right: band.right,
			left: band.left,
			top: band.top,
			width: band.width,
			height: band.height,
			className,
			fillColor: band.fillColor,
			strokeColor: band.strokeColor,
			strokeWidth: band.bucket.topographyBucketIndex === selectedBucketIndex ? 2 : 1
		});
		configureBandElement(rectangle.getElement(), band);
		group.addChild(rectangle);
	}

	function configureBandElement(
		element: SVGElement,
		band: TerraformsHypercastleIsometricBand
	): void {
		const selected = band.bucket.topographyBucketIndex === selectedBucketIndex;
		const label = resolveBandLabel(band);
		element.setAttribute('aria-label', label);
		element.setAttribute('aria-pressed', selected ? 'true' : 'false');
		element.setAttribute('title', label);
		element.setAttribute('role', 'button');
		element.setAttribute('tabindex', '0');
		element.addEventListener('pointerdown', (event) => {
			if (event.pointerType === POINTER_TYPE_MOUSE) {
				event.preventDefault();
			}
		});
		element.addEventListener('click', () => {
			onBucketSelect(band.bucket);
		});
		element.addEventListener('keydown', (event) => {
			if (!(event instanceof KeyboardEvent)) return;
			if (!KEYBOARD_SELECT_KEYS.has(event.key)) return;
			event.preventDefault();
			onBucketSelect(band.bucket);
		});
	}

	function resolveBandLabel(band: TerraformsHypercastleIsometricBand): string {
		return [
			`${TERRAFORMS_HYPERCASTLE_LABELS.Band} ${band.bucket.topographyBucketIndex}`,
			`${TERRAFORMS_HYPERCASTLE_LABELS.Zone} ${band.zone.name}`,
			`${TERRAFORMS_HYPERCASTLE_LABELS.Elevation} ${band.bucket.elevation}`,
			`${TERRAFORMS_HYPERCASTLE_ENTITY_PREFIXES.Level}${level.levelNumber}`
		].join(', ');
	}

	function resolveCanvasLayout(
		bands: readonly TerraformsHypercastleIsometricBand[],
		viewportWidth: number
	): IsometricCanvasLayout {
		const displayDimension = Math.max(...bands.map((band) => band.width));
		const sideAllowance =
			viewportWidth > 900 ? ISOMETRIC_DESKTOP_SIDE_ALLOWANCE : ISOMETRIC_MOBILE_SIDE_ALLOWANCE;
		const availableCanvasWidth = Math.max(
			viewportWidth - sideAllowance,
			ISOMETRIC_MIN_AVAILABLE_WIDTH
		);
		const scale = clamp(
			Math.floor(
				(availableCanvasWidth - ISOMETRIC_CANVAS_MARGIN * 2) /
					((displayDimension + 1) * ISOMETRIC_WIDTH_FACTOR)
			),
			ISOMETRIC_MIN_SCALE,
			ISOMETRIC_MAX_SCALE
		);
		const width = Math.ceil(
			(displayDimension + 1) * ISOMETRIC_WIDTH_FACTOR * scale + ISOMETRIC_CANVAS_MARGIN * 2
		);
		const height = Math.ceil(
			ISOMETRIC_CANVAS_MARGIN * 2 + (displayDimension + 1) * scale + ISOMETRIC_BOTTOM_PAD
		);
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

<div class="terraforms-hypercastle-isometric-level">
	<div
		bind:this={container}
		class="terraforms-hypercastle-isometric-canvas"
		aria-label={TERRAFORMS_HYPERCASTLE_ARIA_LABELS.LevelIsometric}
	></div>
	{#if renderError}
		<div class="terraforms-hypercastle-isometric-status">{renderError}</div>
	{/if}
</div>

<style>
	.terraforms-hypercastle-isometric-level {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.terraforms-hypercastle-isometric-canvas {
		min-height: 180px;
		overflow: hidden;
		border: 1px solid var(--c-blue);
		border-radius: 6px;
		background: color-mix(in srgb, var(--c-bg) 88%, var(--c-blue));
	}

	.terraforms-hypercastle-isometric-status {
		color: var(--c-sand);
		font-size: 0.74rem;
	}

	:global(.terraforms-hypercastle-isometric-svg) {
		display: block;
		max-width: 100%;
		height: auto;
	}

	:global(.terraforms-hypercastle-isometric-band) {
		cursor: pointer;
		transition:
			filter 120ms ease,
			opacity 120ms ease;
	}

	:global(.terraforms-hypercastle-isometric-band:hover),
	:global(.terraforms-hypercastle-isometric-band:focus-visible) {
		filter: brightness(1.18);
	}

	:global(.terraforms-hypercastle-isometric-band-selected) {
		filter: brightness(1.28);
	}
</style>
