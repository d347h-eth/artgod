<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		buildTerraformsHypercastleOverviewOutlineSegments,
		buildTerraformsHypercastleOverviewLayers,
		buildTerraformsHypercastleOverviewRenderKey,
		formatTerraformsHypercastleOverviewLayerLabel,
		resolveTerraformsHypercastleOverviewFaceClassName,
		resolveTerraformsHypercastleOverviewFaceGeometry,
		resolveTerraformsHypercastleOverviewLayerElementId,
		resolveTerraformsHypercastleOverviewLayout,
		resolveTerraformsHypercastleOverviewOutlinePositionClassName,
		resolveTerraformsHypercastleOverviewOutlineStyleClassName,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION,
		type TerraformsHypercastleOverviewFaceKind,
		type TerraformsHypercastleOverviewLayer,
		type TerraformsHypercastleOverviewOutlineSegment
	} from '$lib/collection-extension-pages/terraforms/hypercastle-overview';

	type IsometricModule = typeof import('@elchininet/isometric');

	const DOM_EVENTS = {
		resize: 'resize',
		pointerDown: 'pointerdown',
		click: 'click',
		keyDown: 'keydown'
	} as const;
	const DOM_ATTRIBUTES = {
		ariaHidden: 'aria-hidden',
		ariaLabel: 'aria-label',
		role: 'role',
		tabindex: 'tabindex',
		title: 'title'
	} as const;
	const DOM_ATTRIBUTE_VALUES = {
		button: 'button',
		true: 'true',
		zero: '0'
	} as const;
	const POINTER_TYPE_MOUSE = 'mouse';
	const KEYBOARD_SELECT_KEYS = new Set(['Enter', ' ']);

	const layers = buildTerraformsHypercastleOverviewLayers();
	const outlineSegments = buildTerraformsHypercastleOverviewOutlineSegments(layers);
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
		window.addEventListener(DOM_EVENTS.resize, updateViewportWidth);
		removeResizeListener = () => window.removeEventListener(DOM_EVENTS.resize, updateViewportWidth);
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
			renderError = TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.renderError;
		}
	}

	function renderOverview(): void {
		if (!container || !isometricModule) return;
		container.replaceChildren();
		renderError = null;

		const layout = resolveTerraformsHypercastleOverviewLayout(layers, viewportWidth);
		const canvas = new isometricModule.IsometricCanvas({
			container,
			backgroundColor: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.canvasBackground,
			width: layout.width,
			height: layout.height,
			scale: layout.scale
		});
		canvas.getElement().classList.add(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.svg);
		canvas
			.getElement()
			.setAttribute(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.levelCount, String(layers.length));

		const group = new isometricModule.IsometricGroup({
			right: 0,
			left: 0,
			top: layout.groupTopOffsetUnits
		});
		canvas.addChild(group);
		for (const layer of layers) {
			renderLayer(group, layer);
		}
		renderLayerOutlines(group);
	}

	function renderLayer(
		rootGroup: InstanceType<IsometricModule['IsometricGroup']>,
		layer: TerraformsHypercastleOverviewLayer
	): void {
		if (!isometricModule) return;
		const layerGroup = new isometricModule.IsometricGroup({
			id: resolveTerraformsHypercastleOverviewLayerElementId(layer.levelNumber)
		});
		configureLayerElement(layerGroup.getElement(), layer);
		rootGroup.addChild(layerGroup);

		renderLayerFace(
			layerGroup,
			layer,
			TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Top,
			isometricModule.PlaneView.TOP
		);
		renderLayerFace(
			layerGroup,
			layer,
			TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Front,
			isometricModule.PlaneView.FRONT
		);
		renderLayerFace(
			layerGroup,
			layer,
			TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Side,
			isometricModule.PlaneView.SIDE
		);
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
				TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.face,
				resolveTerraformsHypercastleOverviewFaceClassName(faceKind)
			].join(' '),
			fillColor: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color,
			fillOpacity: resolveLayerFaceFillOpacity(faceKind),
			strokeColor: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color,
			strokeDashArray: resolveLayerFaceStrokeDashArray(faceKind),
			strokeOpacity: resolveLayerFaceStrokeOpacity(faceKind),
			strokeWidth: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeWidth
		});
		face
			.getElement()
			.setAttribute(DOM_ATTRIBUTES.ariaHidden, DOM_ATTRIBUTE_VALUES.true);
		layerGroup.addChild(face);
	}

	function renderLayerOutlines(rootGroup: InstanceType<IsometricModule['IsometricGroup']>): void {
		if (!isometricModule) return;
		const outlineGroup = new isometricModule.IsometricGroup({
			id: TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.ids.outlineGroup
		});
		outlineGroup
			.getElement()
			.setAttribute(DOM_ATTRIBUTES.ariaHidden, DOM_ATTRIBUTE_VALUES.true);
		rootGroup.addChild(outlineGroup);
		for (const segment of outlineSegments) {
			renderLayerOutlineSegment(outlineGroup, segment);
		}
	}

	function renderLayerOutlineSegment(
		outlineGroup: InstanceType<IsometricModule['IsometricGroup']>,
		segment: TerraformsHypercastleOverviewOutlineSegment
	): void {
		if (!isometricModule) return;
		const outline = new isometricModule.IsometricPath({
			id: segment.key,
			autoclose: false,
			className: [
				TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.outlineSegment,
				resolveTerraformsHypercastleOverviewOutlineStyleClassName(segment.style),
				resolveTerraformsHypercastleOverviewOutlinePositionClassName(segment.position)
			].join(' '),
			fillColor: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color,
			fillOpacity: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fillOpacity.top,
			strokeColor: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color,
			strokeDashArray: resolveOutlineStrokeDashArray(segment),
			strokeOpacity: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeOpacity.visible,
			strokeWidth: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeWidth
		});
		outline
			.moveTo(segment.start.right, segment.start.left, segment.start.top)
			.lineTo(segment.end.right, segment.end.left, segment.end.top);
		outline
			.getElement()
			.setAttribute(
				TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.levelNumber,
				String(segment.levelNumber)
			);
		outline
			.getElement()
			.setAttribute(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.outlinePosition, segment.position);
		outline
			.getElement()
			.setAttribute(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.outlineStyle, segment.style);
		outlineGroup.addChild(outline);
	}

	function configureLayerElement(element: SVGElement, layer: TerraformsHypercastleOverviewLayer): void {
		const label = formatTerraformsHypercastleOverviewLayerLabel(layer.levelNumber);
		element.classList.add(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layer);
		element.setAttribute(DOM_ATTRIBUTES.role, DOM_ATTRIBUTE_VALUES.button);
		element.setAttribute(DOM_ATTRIBUTES.tabindex, DOM_ATTRIBUTE_VALUES.zero);
		element.setAttribute(DOM_ATTRIBUTES.ariaLabel, label);
		element.setAttribute(DOM_ATTRIBUTES.title, label);
		element.setAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.levelNumber,
			String(layer.levelNumber)
		);
		element.setAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.levelDimension,
			String(layer.dimension)
		);
		element.addEventListener(DOM_EVENTS.pointerDown, (event) => {
			if (event.pointerType === POINTER_TYPE_MOUSE) {
				event.preventDefault();
			}
		});
		element.addEventListener(DOM_EVENTS.click, () => {
			selectLayer(layer);
		});
		element.addEventListener(DOM_EVENTS.keyDown, (event) => {
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
			? TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fillOpacity.vertical
			: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fillOpacity.top;
	}

	function resolveLayerFaceStrokeDashArray(
		faceKind: TerraformsHypercastleOverviewFaceKind
	): number[] {
		void faceKind;
		return [...TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeDashArray.solid];
	}

	function resolveLayerFaceStrokeOpacity(faceKind: TerraformsHypercastleOverviewFaceKind): number {
		return isLayerVerticalFace(faceKind)
			? TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeOpacity.visible
			: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeOpacity.top;
	}

	function resolveOutlineStrokeDashArray(
		segment: TerraformsHypercastleOverviewOutlineSegment
	): number[] {
		return segment.style === TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES.Dashed
			? [...TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeDashArray.dashed]
			: [...TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeDashArray.solid];
	}

	function isLayerVerticalFace(faceKind: TerraformsHypercastleOverviewFaceKind): boolean {
		return (
			faceKind === TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Front ||
			faceKind === TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Side
		);
	}
</script>

<section
	class={TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.root}
	aria-label={TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.ariaLabel}
>
	<div
		bind:this={container}
		class={TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.canvas}
		data-testid={TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.testId}
	></div>
	{#if renderError}
		<div class={`${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.status} muted`}>
			{renderError}
		</div>
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

	:global(.terraforms-hypercastle-overview-layer-face-top),
	:global(.terraforms-hypercastle-overview-outline-segment) {
		pointer-events: none;
	}

	:global(.terraforms-hypercastle-overview-outline-segment) {
		vector-effect: non-scaling-stroke;
	}

	:global(.terraforms-hypercastle-overview-layer:hover .terraforms-hypercastle-overview-layer-face),
	:global(
			.terraforms-hypercastle-overview-layer:focus-visible
				.terraforms-hypercastle-overview-layer-face
	) {
		filter: brightness(1.16);
		stroke-width: 2;
	}
</style>
