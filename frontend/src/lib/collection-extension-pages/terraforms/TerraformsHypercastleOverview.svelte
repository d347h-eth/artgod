<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		buildTerraformsHypercastleOverviewLevelGuides,
		buildTerraformsHypercastleOverviewOutlineSegments,
		buildTerraformsHypercastleOverviewLayers,
		buildTerraformsHypercastleOverviewRenderKey,
		formatTerraformsHypercastleOverviewLayerLabel,
		isTerraformsHypercastleOverviewFadedFace,
		isTerraformsHypercastleOverviewVerticalFace,
		resolveTerraformsHypercastleOverviewFaceClassName,
		resolveTerraformsHypercastleOverviewFaceGeometry,
		resolveTerraformsHypercastleOverviewLayerElementId,
		resolveTerraformsHypercastleOverviewLevelGuideElementId,
		resolveTerraformsHypercastleOverviewLayout,
		resolveTerraformsHypercastleOverviewOutlinePositionClassName,
		resolveTerraformsHypercastleOverviewOutlineStyleClassName,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION,
		type TerraformsHypercastleOverviewFaceKind,
		type TerraformsHypercastleOverviewLevelGuide,
		type TerraformsHypercastleOverviewLayer,
		type TerraformsHypercastleOverviewOutlineSegment
	} from '$lib/collection-extension-pages/terraforms/hypercastle-overview';

	type IsometricModule = typeof import('@elchininet/isometric');

	const DOM_EVENTS = {
		resize: 'resize',
		pointerEnter: 'pointerenter',
		pointerLeave: 'pointerleave',
		focus: 'focus',
		blur: 'blur',
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
	const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
	const SVG_TAGS = {
		defs: 'defs',
		pattern: 'pattern',
		rect: 'rect',
		group: 'g',
		line: 'line',
		text: 'text'
	} as const;
	const SVG_ATTRIBUTES = {
		id: 'id',
		patternUnits: 'patternUnits',
		patternTransform: 'patternTransform',
		width: 'width',
		height: 'height',
		fill: 'fill',
		fillOpacity: 'fill-opacity',
		fontSize: 'font-size',
		stroke: 'stroke',
		strokeDashArray: 'stroke-dasharray',
		strokeLinecap: 'stroke-linecap',
		strokeOpacity: 'stroke-opacity',
		strokeWidth: 'stroke-width',
		x: 'x',
		x1: 'x1',
		x2: 'x2',
		y: 'y',
		y1: 'y1',
		y2: 'y2',
		dominantBaseline: 'dominant-baseline',
		tabindex: 'tabindex',
		role: 'role',
		ariaLabel: 'aria-label'
	} as const;
	const SVG_ATTRIBUTE_VALUES = {
		userSpaceOnUse: 'userSpaceOnUse',
		middle: 'middle',
		transparent: 'transparent'
	} as const;
	const SVG_TRANSFORMS = {
		rotate: 'rotate'
	} as const;
	const CSS_URL_PREFIX = 'url(#';
	const CSS_URL_SUFFIX = ')';
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
		const svg = canvas.getElement();
		svg.classList.add(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.svg);
		svg.setAttribute(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.levelCount, String(layers.length));
		installFadedFacePattern(svg);

		const group = new isometricModule.IsometricGroup({
			right: layout.groupRightOffsetUnits,
			left: layout.groupLeftOffsetUnits,
			top: layout.groupTopOffsetUnits
		});
		canvas.addChild(group);
		for (const layer of layers) {
			renderLayer(group, layer);
		}
		renderLayerOutlines(group);
		renderLevelGuides(svg, buildTerraformsHypercastleOverviewLevelGuides(layers, layout));
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
		const fadedFace = isTerraformsHypercastleOverviewFadedFace(layer, faceKind);
		const strokeDashArray = resolveLayerFaceStrokeDashArray(layer, faceKind);
		const face = new isometricModule.IsometricRectangle({
			planeView,
			right: geometry.right,
			left: geometry.left,
			top: geometry.top,
			width: geometry.width,
			height: geometry.height,
			className: [
				TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.face,
				resolveTerraformsHypercastleOverviewFaceClassName(faceKind),
				...(fadedFace ? [TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.faceFaded] : [])
			].join(' '),
			fillColor: resolveLayerFaceFillColor(layer, faceKind),
			fillOpacity: resolveLayerFaceFillOpacity(faceKind),
			strokeColor: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color,
			strokeDashArray,
			strokeLinecap: resolveStrokeLineCap(strokeDashArray),
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
			strokeLinecap: resolveOutlineStrokeLineCap(segment),
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

	function renderLevelGuides(
		svg: SVGElement,
		guides: readonly TerraformsHypercastleOverviewLevelGuide[]
	): void {
		const guideGroup = document.createElementNS(SVG_NAMESPACE, SVG_TAGS.group);
		guideGroup.setAttribute(SVG_ATTRIBUTES.id, TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.ids.guideGroup);
		guideGroup.setAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.guideCutoffX,
			String(guides[0]?.lineEnd.x ?? 0)
		);
		for (const guide of guides) {
			guideGroup.appendChild(createLevelGuideElement(guide));
		}
		svg.appendChild(guideGroup);
	}

	function createLevelGuideElement(guide: TerraformsHypercastleOverviewLevelGuide): SVGGElement {
		const guideElement = document.createElementNS(SVG_NAMESPACE, SVG_TAGS.group);
		guideElement.classList.add(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guide);
		guideElement.setAttribute(
			SVG_ATTRIBUTES.id,
			resolveTerraformsHypercastleOverviewLevelGuideElementId(guide.levelNumber)
		);
		guideElement.setAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.levelNumber,
			String(guide.levelNumber)
		);
		guideElement.setAttribute(SVG_ATTRIBUTES.tabindex, DOM_ATTRIBUTE_VALUES.zero);
		guideElement.setAttribute(SVG_ATTRIBUTES.ariaLabel, guide.label);
		guideElement.appendChild(createLevelGuideHitTargetElement(guide));
		guideElement.appendChild(createLevelGuideLeaderElement(guide));
		guideElement.appendChild(createLevelGuideLabelElement(guide));
		guideElement.addEventListener(DOM_EVENTS.pointerEnter, () =>
			setLevelHoverState(guide.levelNumber, true)
		);
		guideElement.addEventListener(DOM_EVENTS.pointerLeave, () =>
			setLevelHoverState(guide.levelNumber, false)
		);
		guideElement.addEventListener(DOM_EVENTS.focus, () =>
			setLevelHoverState(guide.levelNumber, true)
		);
		guideElement.addEventListener(DOM_EVENTS.blur, () =>
			setLevelHoverState(guide.levelNumber, false)
		);
		return guideElement;
	}

	function createLevelGuideHitTargetElement(
		guide: TerraformsHypercastleOverviewLevelGuide
	): SVGRectElement {
		const target = document.createElementNS(SVG_NAMESPACE, SVG_TAGS.rect);
		const height = TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.levelGuideHitHeight;
		const width =
			guide.labelAnchor.x -
			guide.lineStart.x +
			TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.levelLabelHitWidth;
		target.classList.add(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideHitTarget);
		target.setAttribute(SVG_ATTRIBUTES.x, String(guide.lineStart.x));
		target.setAttribute(SVG_ATTRIBUTES.y, String(guide.labelAnchor.y - height / 2));
		target.setAttribute(SVG_ATTRIBUTES.width, String(width));
		target.setAttribute(SVG_ATTRIBUTES.height, String(height));
		target.setAttribute(SVG_ATTRIBUTES.fill, SVG_ATTRIBUTE_VALUES.transparent);
		return target;
	}

	function createLevelGuideLeaderElement(guide: TerraformsHypercastleOverviewLevelGuide): SVGLineElement {
		const leader = document.createElementNS(SVG_NAMESPACE, SVG_TAGS.line);
		leader.classList.add(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideLeader);
		leader.setAttribute(SVG_ATTRIBUTES.x1, String(guide.lineStart.x));
		leader.setAttribute(SVG_ATTRIBUTES.y1, String(guide.lineStart.y));
		leader.setAttribute(SVG_ATTRIBUTES.x2, String(guide.lineEnd.x));
		leader.setAttribute(SVG_ATTRIBUTES.y2, String(guide.lineEnd.y));
		leader.setAttribute(SVG_ATTRIBUTES.stroke, TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color);
		leader.setAttribute(
			SVG_ATTRIBUTES.strokeDashArray,
			TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeDashArray.dashed.join(' ')
		);
		leader.setAttribute(
			SVG_ATTRIBUTES.strokeOpacity,
			String(TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.levelGuideLineHiddenOpacity)
		);
		leader.setAttribute(
			SVG_ATTRIBUTES.strokeWidth,
			String(TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.levelGuideLineStrokeWidth)
		);
		return leader;
	}

	function createLevelGuideLabelElement(guide: TerraformsHypercastleOverviewLevelGuide): SVGTextElement {
		const label = document.createElementNS(SVG_NAMESPACE, SVG_TAGS.text);
		label.classList.add(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideLabel);
		label.setAttribute(SVG_ATTRIBUTES.x, String(guide.labelAnchor.x));
		label.setAttribute(SVG_ATTRIBUTES.y, String(guide.labelAnchor.y));
		label.setAttribute(SVG_ATTRIBUTES.fill, TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color);
		label.setAttribute(
			SVG_ATTRIBUTES.fillOpacity,
			String(TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.levelLabelTextOpacity)
		);
		label.setAttribute(
			SVG_ATTRIBUTES.fontSize,
			String(TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.levelLabelFontSize)
		);
		label.setAttribute(SVG_ATTRIBUTES.dominantBaseline, SVG_ATTRIBUTE_VALUES.middle);
		label.textContent = guide.label;
		return label;
	}

	function setLevelHoverState(levelNumber: number, hovered: boolean): void {
		resolveLevelGuideElement(levelNumber)?.classList.toggle(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideHovered,
			hovered
		);
		resolveLayerElement(levelNumber)?.classList.toggle(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layerHovered,
			hovered
		);
	}

	function resolveLevelGuideElement(levelNumber: number): HTMLElement | null {
		return document.getElementById(
			resolveTerraformsHypercastleOverviewLevelGuideElementId(levelNumber)
		);
	}

	function resolveLayerElement(levelNumber: number): HTMLElement | null {
		return document.getElementById(resolveTerraformsHypercastleOverviewLayerElementId(levelNumber));
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
		// Mirror slab hover onto the guide so hidden leaders appear from either hit target.
		element.addEventListener(DOM_EVENTS.pointerEnter, () =>
			setLevelHoverState(layer.levelNumber, true)
		);
		element.addEventListener(DOM_EVENTS.pointerLeave, () =>
			setLevelHoverState(layer.levelNumber, false)
		);
		element.addEventListener(DOM_EVENTS.focus, () => setLevelHoverState(layer.levelNumber, true));
		element.addEventListener(DOM_EVENTS.blur, () => setLevelHoverState(layer.levelNumber, false));
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

	function resolveLayerFaceFillColor(
		layer: TerraformsHypercastleOverviewLayer,
		faceKind: TerraformsHypercastleOverviewFaceKind
	): string {
		return isTerraformsHypercastleOverviewFadedFace(layer, faceKind)
			? `${CSS_URL_PREFIX}${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.ids.stripePattern}${CSS_URL_SUFFIX}`
			: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color;
	}

	function resolveLayerFaceFillOpacity(faceKind: TerraformsHypercastleOverviewFaceKind): number {
		return isTerraformsHypercastleOverviewVerticalFace(faceKind)
			? TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fillOpacity.vertical
			: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fillOpacity.top;
	}

	function resolveLayerFaceStrokeDashArray(
		layer: TerraformsHypercastleOverviewLayer,
		faceKind: TerraformsHypercastleOverviewFaceKind
	): number[] {
		if (isTerraformsHypercastleOverviewFadedFace(layer, faceKind)) {
			return [...TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeDashArray.dotted];
		}
		return [...TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeDashArray.solid];
	}

	function resolveLayerFaceStrokeOpacity(faceKind: TerraformsHypercastleOverviewFaceKind): number {
		return isTerraformsHypercastleOverviewVerticalFace(faceKind)
			? TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeOpacity.visible
			: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeOpacity.top;
	}

	function resolveOutlineStrokeDashArray(
		segment: TerraformsHypercastleOverviewOutlineSegment
	): number[] {
		return segment.style === TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES.Dotted
			? [...TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeDashArray.dotted]
			: [...TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeDashArray.solid];
	}

	function resolveOutlineStrokeLineCap(
		segment: TerraformsHypercastleOverviewOutlineSegment
	): IsometricModule['LineCap'][keyof IsometricModule['LineCap']] {
		return segment.style === TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES.Dotted
			? resolveRoundLineCap()
			: resolveButtLineCap();
	}

	function resolveStrokeLineCap(
		strokeDashArray: readonly number[]
	): IsometricModule['LineCap'][keyof IsometricModule['LineCap']] {
		return strokeDashArray.length > 0 ? resolveRoundLineCap() : resolveButtLineCap();
	}

	function resolveRoundLineCap(): IsometricModule['LineCap'][keyof IsometricModule['LineCap']] {
		return isometricModule!.LineCap.round;
	}

	function resolveButtLineCap(): IsometricModule['LineCap'][keyof IsometricModule['LineCap']] {
		return isometricModule!.LineCap.butt;
	}

	function installFadedFacePattern(svg: SVGElement): void {
		const defs = document.createElementNS(SVG_NAMESPACE, SVG_TAGS.defs);
		const pattern = document.createElementNS(SVG_NAMESPACE, SVG_TAGS.pattern);
		const stripe = document.createElementNS(SVG_NAMESPACE, SVG_TAGS.rect);
		pattern.setAttribute(SVG_ATTRIBUTES.id, TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.ids.stripePattern);
		pattern.setAttribute(SVG_ATTRIBUTES.patternUnits, SVG_ATTRIBUTE_VALUES.userSpaceOnUse);
		pattern.setAttribute(
			SVG_ATTRIBUTES.width,
			String(TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fadedLevelPatternSize)
		);
		pattern.setAttribute(
			SVG_ATTRIBUTES.height,
			String(TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fadedLevelPatternSize)
		);
		pattern.setAttribute(
			SVG_ATTRIBUTES.patternTransform,
			`${SVG_TRANSFORMS.rotate}(${TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fadedLevelPatternRotation})`
		);
		stripe.setAttribute(
			SVG_ATTRIBUTES.width,
			String(TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fadedLevelPatternStripeWidth)
		);
		stripe.setAttribute(
			SVG_ATTRIBUTES.height,
			String(TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fadedLevelPatternSize)
		);
		stripe.setAttribute(SVG_ATTRIBUTES.fill, TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color);
		stripe.setAttribute(
			SVG_ATTRIBUTES.fillOpacity,
			String(TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fadedLevelPatternFillOpacity)
		);
		pattern.appendChild(stripe);
		defs.appendChild(pattern);
		svg.insertBefore(defs, svg.firstChild);
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

	:global(.terraforms-hypercastle-overview-level-guide) {
		cursor: pointer;
		outline: none;
	}

	:global(.terraforms-hypercastle-overview-level-guide-hit-target) {
		pointer-events: all;
	}

	:global(.terraforms-hypercastle-overview-level-guide-leader) {
		vector-effect: non-scaling-stroke;
		transition: stroke-opacity 120ms ease;
	}

	:global(.terraforms-hypercastle-overview-level-guide-label) {
		font-family: var(--font-mono);
		letter-spacing: 0;
		pointer-events: none;
		transition:
			filter 120ms ease,
			fill-opacity 120ms ease;
	}

	:global(.terraforms-hypercastle-overview-layer:hover .terraforms-hypercastle-overview-layer-face),
	:global(
			.terraforms-hypercastle-overview-layer:focus-visible
				.terraforms-hypercastle-overview-layer-face
	),
	:global(
			.terraforms-hypercastle-overview-layer-hovered
				.terraforms-hypercastle-overview-layer-face
	) {
		filter: brightness(1.16);
		stroke-width: 2;
	}

	:global(
			.terraforms-hypercastle-overview-level-guide:hover
				.terraforms-hypercastle-overview-level-guide-label
	),
	:global(
			.terraforms-hypercastle-overview-level-guide:focus-visible
				.terraforms-hypercastle-overview-level-guide-label
	),
	:global(
			.terraforms-hypercastle-overview-level-guide-hovered
				.terraforms-hypercastle-overview-level-guide-label
	) {
		filter: brightness(1.35);
		fill-opacity: 1;
	}

	:global(
			.terraforms-hypercastle-overview-level-guide:hover
				.terraforms-hypercastle-overview-level-guide-leader
	),
	:global(
			.terraforms-hypercastle-overview-level-guide:focus-visible
				.terraforms-hypercastle-overview-level-guide-leader
	),
	:global(
			.terraforms-hypercastle-overview-level-guide-hovered
				.terraforms-hypercastle-overview-level-guide-leader
	) {
		stroke-opacity: 1;
	}
</style>
