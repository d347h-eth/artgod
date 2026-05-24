<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		buildTerraformsHypercastleOverviewLayers,
		buildTerraformsHypercastleOverviewRenderKey,
		resolveTerraformsHypercastleOverviewFaceGeometry,
		resolveTerraformsHypercastleOverviewLayout,
		type TerraformsHypercastleOverviewFaceKind,
		type TerraformsHypercastleOverviewLayer
	} from '$lib/collection-extension-pages/terraforms/hypercastle-overview';

	type IsometricModule = typeof import('@elchininet/isometric');

	const OVERVIEW_ARIA_LABEL = 'Hypercastle overview';
	const OVERVIEW_RENDER_ERROR = 'isometric renderer unavailable';
	const OVERVIEW_LAYER_FILL = 'var(--c-cyan)';
	const OVERVIEW_LAYER_TOP_FILL_OPACITY = 0;
	const OVERVIEW_LAYER_VERTICAL_FILL_OPACITY = 1;
	const OVERVIEW_LAYER_STROKE = 'var(--c-blue)';
	const OVERVIEW_LAYER_BACKWARD_STROKE_DASH_ARRAY = [4, 3];
	const OVERVIEW_LAYER_STROKE_OPACITY = 1;
	const OVERVIEW_LAYER_STROKE_WIDTH = 1;
	const POINTER_TYPE_MOUSE = 'mouse';
	const KEYBOARD_SELECT_KEYS = new Set(['Enter', ' ']);

	const layers = buildTerraformsHypercastleOverviewLayers();
	const renderKey = buildTerraformsHypercastleOverviewRenderKey(layers);

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
		viewportWidth;
		renderKey;
		renderOverview();
	});

	async function loadIsometricModule(): Promise<void> {
		try {
			isometricModule = await import('@elchininet/isometric');
		} catch {
			renderError = OVERVIEW_RENDER_ERROR;
		}
	}

	function renderOverview(): void {
		if (!container || !isometricModule) return;
		container.replaceChildren();
		renderError = null;

		const layout = resolveTerraformsHypercastleOverviewLayout(layers, viewportWidth);
		const canvas = new isometricModule.IsometricCanvas({
			container,
			backgroundColor: 'transparent',
			width: layout.width,
			height: layout.height,
			scale: layout.scale
		});
		canvas.getElement().classList.add('terraforms-hypercastle-overview-svg');
		canvas.getElement().setAttribute('data-level-count', String(layers.length));

		const group = new isometricModule.IsometricGroup({
			right: 0,
			left: 0,
			top: layout.groupTopOffsetUnits
		});
		canvas.addChild(group);
		for (const layer of layers) {
			renderLayer(group, layer);
		}
	}

	function renderLayer(
		rootGroup: InstanceType<IsometricModule['IsometricGroup']>,
		layer: TerraformsHypercastleOverviewLayer
	): void {
		if (!isometricModule) return;
		const layerGroup = new isometricModule.IsometricGroup({
			id: `terraforms-hypercastle-level-${layer.levelNumber}`
		});
		configureLayerElement(layerGroup.getElement(), layer);
		rootGroup.addChild(layerGroup);

		renderLayerFace(layerGroup, layer, 'top', isometricModule.PlaneView.TOP);
		renderLayerFace(layerGroup, layer, 'front', isometricModule.PlaneView.FRONT);
		renderLayerFace(layerGroup, layer, 'side', isometricModule.PlaneView.SIDE);
	}

	function renderLayerFace(
		layerGroup: InstanceType<IsometricModule['IsometricGroup']>,
		layer: TerraformsHypercastleOverviewLayer,
		faceKind: TerraformsHypercastleOverviewFaceKind,
		planeView: IsometricModule['PlaneView'][keyof IsometricModule['PlaneView']]
	): void {
		if (!isometricModule) return;
		const geometry = resolveTerraformsHypercastleOverviewFaceGeometry(layer, faceKind);
		const face = new isometricModule.IsometricRectangle({
			planeView,
			right: geometry.right,
			left: geometry.left,
			top: geometry.top,
			width: geometry.width,
			height: geometry.height,
			className: [
				'terraforms-hypercastle-overview-layer-face',
				`terraforms-hypercastle-overview-layer-face-${faceKind}`
			].join(' '),
			fillColor: OVERVIEW_LAYER_FILL,
			fillOpacity: resolveLayerFaceFillOpacity(faceKind),
			strokeColor: OVERVIEW_LAYER_STROKE,
			strokeDashArray: resolveLayerFaceStrokeDashArray(faceKind),
			strokeOpacity: OVERVIEW_LAYER_STROKE_OPACITY,
			strokeWidth: OVERVIEW_LAYER_STROKE_WIDTH
		});
		face.getElement().setAttribute('aria-hidden', 'true');
		layerGroup.addChild(face);
	}

	function configureLayerElement(element: SVGElement, layer: TerraformsHypercastleOverviewLayer): void {
		const label = `Hypercastle level ${layer.levelNumber}`;
		element.classList.add('terraforms-hypercastle-overview-layer');
		element.setAttribute('role', 'button');
		element.setAttribute('tabindex', '0');
		element.setAttribute('aria-label', label);
		element.setAttribute('title', label);
		element.setAttribute('data-level-number', String(layer.levelNumber));
		element.setAttribute('data-level-dimension', String(layer.dimension));
		element.addEventListener('pointerdown', (event) => {
			if (event.pointerType === POINTER_TYPE_MOUSE) {
				event.preventDefault();
			}
		});
		element.addEventListener('click', () => {
			selectLayer(layer);
		});
		element.addEventListener('keydown', (event) => {
			if (!(event instanceof KeyboardEvent)) return;
			if (!KEYBOARD_SELECT_KEYS.has(event.key)) return;
			event.preventDefault();
			selectLayer(layer);
		});
	}

	function selectLayer(layer: TerraformsHypercastleOverviewLayer): void {
		void layer;
	}

	function resolveLayerFaceFillOpacity(faceKind: TerraformsHypercastleOverviewFaceKind): number {
		return isLayerVerticalFace(faceKind)
			? OVERVIEW_LAYER_VERTICAL_FILL_OPACITY
			: OVERVIEW_LAYER_TOP_FILL_OPACITY;
	}

	function resolveLayerFaceStrokeDashArray(
		faceKind: TerraformsHypercastleOverviewFaceKind
	): number[] {
		return isLayerVerticalFace(faceKind) ? [] : OVERVIEW_LAYER_BACKWARD_STROKE_DASH_ARRAY;
	}

	function isLayerVerticalFace(faceKind: TerraformsHypercastleOverviewFaceKind): boolean {
		return faceKind === 'front' || faceKind === 'side';
	}
</script>

<section class="terraforms-hypercastle-overview" aria-label={OVERVIEW_ARIA_LABEL}>
	<div
		bind:this={container}
		class="terraforms-hypercastle-overview-canvas"
		data-testid="terraforms-hypercastle-overview"
	></div>
	{#if renderError}
		<div class="terraforms-hypercastle-overview-status muted">{renderError}</div>
	{/if}
</section>

<style>
	.terraforms-hypercastle-overview {
		display: grid;
		justify-items: center;
		min-width: 0;
		padding: 14px 0 4px;
	}

	.terraforms-hypercastle-overview-canvas {
		width: fit-content;
		max-width: 100%;
		min-width: 0;
		overflow: visible;
	}

	.terraforms-hypercastle-overview-status {
		margin-top: 0.4rem;
		font-size: 0.78rem;
	}

	:global(.terraforms-hypercastle-overview-svg) {
		display: block;
		max-width: 100%;
		height: auto;
		overflow: visible;
	}

	:global(.terraforms-hypercastle-overview-layer) {
		cursor: pointer;
		outline: none;
	}

	:global(.terraforms-hypercastle-overview-layer-face) {
		pointer-events: visibleStroke;
		vector-effect: non-scaling-stroke;
		transition:
			filter 120ms ease,
			stroke 120ms ease,
			stroke-width 120ms ease;
	}

	:global(.terraforms-hypercastle-overview-layer-face-front),
	:global(.terraforms-hypercastle-overview-layer-face-side) {
		pointer-events: all;
	}

	:global(.terraforms-hypercastle-overview-layer:hover .terraforms-hypercastle-overview-layer-face),
	:global(
			.terraforms-hypercastle-overview-layer:focus-visible
				.terraforms-hypercastle-overview-layer-face
		) {
		filter: brightness(1.12);
		stroke: var(--c-yellow);
		stroke-width: 2;
	}
</style>
