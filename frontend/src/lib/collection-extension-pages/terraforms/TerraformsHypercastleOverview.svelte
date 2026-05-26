<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		buildTerraformsHypercastleOverviewLevelGuides,
		buildTerraformsHypercastleOverviewLayers,
		buildTerraformsHypercastleOverviewRenderKey,
		formatTerraformsHypercastleOverviewLayerLabel,
		isTerraformsHypercastleOverviewVerticalFace,
		resolveTerraformsHypercastleOverviewFaceClassName,
		resolveTerraformsHypercastleOverviewFaceGeometry,
		resolveTerraformsHypercastleOverviewLayerElementId,
		resolveTerraformsHypercastleOverviewLevelGuideElementId,
		resolveTerraformsHypercastleOverviewLayout,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS,
		TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION,
		type TerraformsHypercastleOverviewFaceKind,
		type TerraformsHypercastleOverviewFaceGeometry,
		type TerraformsHypercastleOverviewLevelGuide,
		type TerraformsHypercastleOverviewLayer
	} from '$lib/collection-extension-pages/terraforms/hypercastle-overview';
	import { TERRAFORMS_HYPERCASTLE_SELECTION_LABELS } from '$lib/collection-extension-pages/terraforms/hypercastle-selection';
	import {
		buildTerraformsHypercastleSurfaceTextureRenderKey,
		buildTerraformsHypercastleSurfaceTextureCells,
		resolveTerraformsHypercastleSurfaceForLevel,
		resolveTerraformsHypercastleSurfaceTextureBackgroundColor,
		resolveTerraformsHypercastleSurfaceZone,
		TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_CELL,
		type TerraformsHypercastleLevelSurface,
		type TerraformsHypercastleSurfaceTextureCell
	} from '$lib/collection-extension-pages/terraforms/hypercastle-surface-texture';

	type IsometricModule = typeof import('@elchininet/isometric');
	type TerraformsHypercastleOverviewProps = {
		selectedLevelNumber?: number | null;
		allLevelsSelected?: boolean;
		levelSurfaces?: readonly TerraformsHypercastleLevelSurface[];
		onLevelSelect?: (levelNumber: number) => void;
		onAllLevelsSelect?: () => void;
	};

	let {
		selectedLevelNumber = null,
		allLevelsSelected = false,
		levelSurfaces = [],
		onLevelSelect = () => undefined,
		onAllLevelsSelect = () => undefined
	}: TerraformsHypercastleOverviewProps = $props();

	const DOM_EVENTS = {
		resize: 'resize',
		pointerEnter: 'pointerenter',
		pointerLeave: 'pointerleave',
		pointerMove: 'pointermove',
		focus: 'focus',
		blur: 'blur',
		pointerDown: 'pointerdown',
		click: 'click',
		keyDown: 'keydown'
	} as const;
	const DOM_ATTRIBUTES = {
		ariaHidden: 'aria-hidden',
		ariaLabel: 'aria-label',
		ariaPressed: 'aria-pressed',
		role: 'role',
		tabindex: 'tabindex',
		title: 'title'
	} as const;
	const DOM_ATTRIBUTE_VALUES = {
		button: 'button',
		false: 'false',
		true: 'true',
		zero: '0'
	} as const;
	const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
	const SVG_TAGS = {
		rect: 'rect',
		group: 'g',
		line: 'line',
		text: 'text'
	} as const;
	const SVG_ATTRIBUTES = {
		id: 'id',
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
		shapeRendering: 'shape-rendering',
		tabindex: 'tabindex',
		role: 'role',
		title: 'title',
		ariaLabel: 'aria-label',
		ariaPressed: 'aria-pressed'
	} as const;
	const SVG_ATTRIBUTE_VALUES = {
		middle: 'middle',
		transparent: 'transparent',
		crispEdges: 'crispEdges'
	} as const;
	const POINTER_TYPE_MOUSE = 'mouse';
	const KEYBOARD_SELECT_KEYS = new Set(['Enter', ' ']);

	const layers = buildTerraformsHypercastleOverviewLayers();
	const renderKey = buildTerraformsHypercastleOverviewRenderKey(layers);
	let surfaceRenderKey = $derived(buildTerraformsHypercastleSurfaceTextureRenderKey(levelSurfaces));

	let container: HTMLDivElement;
	let isometricModule = $state<IsometricModule | null>(null);
	let viewportWidth = $state(0);
	let renderError = $state<string | null>(null);
	let pinnedLevelNumber = $state<number | null>(null);
	let hoveredLevelNumber: number | null = null;
	let removeResizeListener: (() => void) | null = null;
	let removePointerHoverListener: (() => void) | null = null;

	onMount(() => {
		const updateViewportWidth = () => {
			viewportWidth = window.innerWidth;
		};
		updateViewportWidth();
		window.addEventListener(DOM_EVENTS.resize, updateViewportWidth);
		removeResizeListener = () => window.removeEventListener(DOM_EVENTS.resize, updateViewportWidth);
		window.addEventListener(DOM_EVENTS.pointerMove, syncPointerHoverState);
		window.addEventListener(DOM_EVENTS.pointerLeave, clearActiveLevelHoverState);
		removePointerHoverListener = () => {
			window.removeEventListener(DOM_EVENTS.pointerMove, syncPointerHoverState);
			window.removeEventListener(DOM_EVENTS.pointerLeave, clearActiveLevelHoverState);
		};
		void loadIsometricModule();
	});

	onDestroy(() => {
		removeResizeListener?.();
		removePointerHoverListener?.();
		container?.replaceChildren();
	});

	$effect(() => {
		if (!container || !isometricModule) return;
		viewportWidth;
		renderKey;
		surfaceRenderKey;
		renderOverview();
	});

	$effect(() => {
		selectedLevelNumber;
		allLevelsSelected;
		pinnedLevelNumber;
		syncSelectedLevelState();
		syncPinnedLevelOrder();
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
		svg.setAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceKey,
			surfaceRenderKey
		);

		const group = new isometricModule.IsometricGroup({
			right: layout.groupRightOffsetUnits,
			left: layout.groupLeftOffsetUnits,
			top: layout.groupTopOffsetUnits
		});
		canvas.addChild(group);
		for (const layer of layers) {
			renderLayer(group, layer);
		}
		renderLevelGuides(svg, buildTerraformsHypercastleOverviewLevelGuides(layers, layout), layout);
		syncSelectedLevelState();
		syncPinnedLevelOrder();
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
			TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Front,
			isometricModule.PlaneView.FRONT
		);
		renderLayerFace(
			layerGroup,
			layer,
			TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Side,
			isometricModule.PlaneView.SIDE
		);
		renderLayerSurfaceTexture(layerGroup, layer);
		renderLayerFace(
			layerGroup,
			layer,
			TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Top,
			isometricModule.PlaneView.TOP
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
		const strokeDashArray = resolveLayerFaceStrokeDashArray();
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
			fillColor: resolveLayerFaceFillColor(layer, faceKind),
			fillOpacity: resolveLayerFaceFillOpacity(layer, faceKind),
			strokeColor: resolveLayerFaceStrokeColor(layer, faceKind),
			strokeDashArray,
			strokeLinecap: resolveStrokeLineCap(strokeDashArray),
			strokeOpacity: resolveLayerFaceStrokeOpacity(faceKind),
			strokeWidth: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeWidth
		});
		const faceElement = face.getElement();
		faceElement.setAttribute(DOM_ATTRIBUTES.ariaHidden, DOM_ATTRIBUTE_VALUES.true);
		faceElement.addEventListener(DOM_EVENTS.pointerEnter, () =>
			setLevelHoverState(layer.levelNumber, true)
		);
		faceElement.addEventListener(DOM_EVENTS.pointerLeave, (event) =>
			clearLevelHoverStateIfOutside(layer.levelNumber, event)
		);
		layerGroup.addChild(face);
	}

	function renderLayerSurfaceTexture(
		layerGroup: InstanceType<IsometricModule['IsometricGroup']>,
		layer: TerraformsHypercastleOverviewLayer
	): void {
		const surface = resolveLayerSurface(layer);
		if (!surface) return;
		const geometry = resolveTerraformsHypercastleOverviewFaceGeometry(
			layer,
			TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Top
		);
		const zone = resolveTerraformsHypercastleSurfaceZone(surface);
		for (const cell of buildTerraformsHypercastleSurfaceTextureCells({
			zone,
			seed: surface.seed,
			levelDimension: layer.dimension
		})) {
			renderLayerSurfaceTextureCell(layerGroup, geometry, cell);
		}
	}

	function renderLayerSurfaceTextureCell(
		layerGroup: InstanceType<IsometricModule['IsometricGroup']>,
		geometry: TerraformsHypercastleOverviewFaceGeometry,
		cell: TerraformsHypercastleSurfaceTextureCell
	): void {
		if (!isometricModule) return;
		const textureCell = new isometricModule.IsometricRectangle({
			planeView: isometricModule.PlaneView.TOP,
			right: geometry.right + cell.x * geometry.width,
			left: geometry.left + cell.y * geometry.height,
			top: geometry.top,
			width: cell.size * geometry.width,
			height: cell.size * geometry.height,
			className: TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.textureCell,
			fillColor: cell.color,
			fillOpacity: TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_CELL.cellOpacity,
			strokeColor: cell.color,
			strokeOpacity: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeOpacity.textureCell,
			strokeWidth: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.textureCellStrokeWidth
		});
		const textureCellElement = textureCell.getElement();
		textureCellElement.setAttribute(DOM_ATTRIBUTES.ariaHidden, DOM_ATTRIBUTE_VALUES.true);
		textureCellElement.setAttribute(SVG_ATTRIBUTES.shapeRendering, SVG_ATTRIBUTE_VALUES.crispEdges);
		textureCellElement.setAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceTextureHeightmapIndex,
			String(cell.heightmapIndex)
		);
		layerGroup.addChild(textureCell);
	}

	function renderLevelGuides(
		svg: SVGElement,
		guides: readonly TerraformsHypercastleOverviewLevelGuide[],
		layout: ReturnType<typeof resolveTerraformsHypercastleOverviewLayout>
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
		const topGuide = guides[guides.length - 1] ?? null;
		if (topGuide) {
			guideGroup.appendChild(createAllLevelsGuideElement(topGuide, layout));
		}
		svg.appendChild(guideGroup);
	}

	function createAllLevelsGuideElement(
		topGuide: TerraformsHypercastleOverviewLevelGuide,
		layout: ReturnType<typeof resolveTerraformsHypercastleOverviewLayout>
	): SVGGElement {
		const guideElement = document.createElementNS(SVG_NAMESPACE, SVG_TAGS.group);
		const labelAnchor = resolveAllLevelsLabelAnchor(topGuide, layout);
		guideElement.classList.add(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.allLevelsGuide);
		guideElement.setAttribute(SVG_ATTRIBUTES.id, TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.ids.allLevelsGuide);
		guideElement.setAttribute(SVG_ATTRIBUTES.role, DOM_ATTRIBUTE_VALUES.button);
		guideElement.setAttribute(SVG_ATTRIBUTES.tabindex, DOM_ATTRIBUTE_VALUES.zero);
		guideElement.setAttribute(
			SVG_ATTRIBUTES.ariaLabel,
			TERRAFORMS_HYPERCASTLE_SELECTION_LABELS.AllLevels
		);
		guideElement.setAttribute(
			SVG_ATTRIBUTES.title,
			TERRAFORMS_HYPERCASTLE_SELECTION_LABELS.AllLevels
		);
		guideElement.setAttribute(SVG_ATTRIBUTES.ariaPressed, DOM_ATTRIBUTE_VALUES.false);
		guideElement.appendChild(createAllLevelsGuideHitTargetElement(labelAnchor));
		guideElement.appendChild(createAllLevelsGuideLabelElement(labelAnchor));
		guideElement.addEventListener(DOM_EVENTS.pointerEnter, () => setAllLevelsHoverState(true));
		guideElement.addEventListener(DOM_EVENTS.pointerLeave, () => setAllLevelsHoverState(false));
		guideElement.addEventListener(DOM_EVENTS.focus, () => setAllLevelsHoverState(true));
		guideElement.addEventListener(DOM_EVENTS.blur, () => setAllLevelsHoverState(false));
		guideElement.addEventListener(DOM_EVENTS.pointerDown, (event) => {
			if (event.pointerType === POINTER_TYPE_MOUSE) {
				event.preventDefault();
			}
		});
		guideElement.addEventListener(DOM_EVENTS.click, () => {
			selectAllLevels();
		});
		guideElement.addEventListener(DOM_EVENTS.keyDown, (event) => {
			if (!(event instanceof KeyboardEvent)) return;
			if (!KEYBOARD_SELECT_KEYS.has(event.key)) return;
			event.preventDefault();
			selectAllLevels();
		});
		return guideElement;
	}

	function resolveAllLevelsLabelAnchor(
		topGuide: TerraformsHypercastleOverviewLevelGuide,
		layout: ReturnType<typeof resolveTerraformsHypercastleOverviewLayout>
	): { x: number; y: number } {
		return {
			x: topGuide.labelAnchor.x,
			y: topGuide.labelAnchor.y - layout.allLevelsLabelRowGap
		};
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
		guideElement.setAttribute(SVG_ATTRIBUTES.role, DOM_ATTRIBUTE_VALUES.button);
		guideElement.setAttribute(SVG_ATTRIBUTES.tabindex, DOM_ATTRIBUTE_VALUES.zero);
		guideElement.setAttribute(SVG_ATTRIBUTES.ariaLabel, guide.label);
		guideElement.setAttribute(SVG_ATTRIBUTES.title, guide.label);
		guideElement.setAttribute(SVG_ATTRIBUTES.ariaPressed, DOM_ATTRIBUTE_VALUES.false);
		guideElement.appendChild(createLevelGuideHitTargetElement(guide));
		guideElement.appendChild(createLevelGuideLeaderElement(guide));
		guideElement.appendChild(createLevelGuideLabelElement(guide));
		guideElement.addEventListener(DOM_EVENTS.pointerEnter, () =>
			setLevelHoverState(guide.levelNumber, true)
		);
		guideElement.addEventListener(DOM_EVENTS.pointerLeave, (event) =>
			clearLevelHoverStateIfOutside(guide.levelNumber, event)
		);
		guideElement.addEventListener(DOM_EVENTS.focus, () =>
			setLevelHoverState(guide.levelNumber, true)
		);
		guideElement.addEventListener(DOM_EVENTS.blur, (event) =>
			clearLevelHoverStateIfOutside(guide.levelNumber, event)
		);
		guideElement.addEventListener(DOM_EVENTS.pointerDown, (event) => {
			if (event.pointerType === POINTER_TYPE_MOUSE) {
				event.preventDefault();
			}
		});
		guideElement.addEventListener(DOM_EVENTS.click, () => {
			selectLevelNumber(guide.levelNumber);
		});
		guideElement.addEventListener(DOM_EVENTS.keyDown, (event) => {
			if (!(event instanceof KeyboardEvent)) return;
			if (!KEYBOARD_SELECT_KEYS.has(event.key)) return;
			event.preventDefault();
			selectLevelNumber(guide.levelNumber);
		});
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

	function createAllLevelsGuideHitTargetElement(labelAnchor: {
		x: number;
		y: number;
	}): SVGRectElement {
		const target = document.createElementNS(SVG_NAMESPACE, SVG_TAGS.rect);
		const height = TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.levelGuideHitHeight;
		target.classList.add(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.allLevelsGuideHitTarget);
		target.setAttribute(SVG_ATTRIBUTES.x, String(labelAnchor.x));
		target.setAttribute(SVG_ATTRIBUTES.y, String(labelAnchor.y - height / 2));
		target.setAttribute(
			SVG_ATTRIBUTES.width,
			String(TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.allLevelsLabelHitWidth)
		);
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

	function createAllLevelsGuideLabelElement(labelAnchor: { x: number; y: number }): SVGTextElement {
		const label = document.createElementNS(SVG_NAMESPACE, SVG_TAGS.text);
		label.classList.add(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.allLevelsGuideLabel);
		label.setAttribute(SVG_ATTRIBUTES.x, String(labelAnchor.x));
		label.setAttribute(SVG_ATTRIBUTES.y, String(labelAnchor.y));
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
		label.textContent = TERRAFORMS_HYPERCASTLE_SELECTION_LABELS.AllLevels;
		return label;
	}

	function setLevelHoverState(levelNumber: number, hovered: boolean): void {
		if (hovered) {
			if (hoveredLevelNumber !== null && hoveredLevelNumber !== levelNumber) {
				syncLevelHoverClassState(hoveredLevelNumber, false);
			}
			hoveredLevelNumber = levelNumber;
			syncLevelHoverClassState(levelNumber, true);
			return;
		}
		if (hoveredLevelNumber === levelNumber) {
			hoveredLevelNumber = null;
		}
		syncLevelHoverClassState(levelNumber, false);
	}

	function syncLevelHoverClassState(levelNumber: number, hovered: boolean): void {
		resolveLevelGuideElement(levelNumber)?.classList.toggle(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideHovered,
			hovered
		);
		resolveLayerElement(levelNumber)?.classList.toggle(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layerHovered,
			hovered
		);
	}

	function syncPointerHoverState(event: PointerEvent): void {
		const target = document.elementFromPoint(event.clientX, event.clientY);
		if (!(target instanceof Element)) {
			clearActiveLevelHoverState();
			return;
		}
		const levelTarget =
			target.closest(levelHoverTargetSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layer)) ??
			target.closest(levelHoverTargetSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guide));
		const rawLevelNumber = levelTarget?.getAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.levelNumber
		);
		const levelNumber = rawLevelNumber ? Number(rawLevelNumber) : null;
		if (levelNumber === null || !Number.isFinite(levelNumber)) {
			clearActiveLevelHoverState();
			return;
		}
		setLevelHoverState(levelNumber, true);
	}

	function clearActiveLevelHoverState(): void {
		if (hoveredLevelNumber === null) return;
		setLevelHoverState(hoveredLevelNumber, false);
	}

	function levelHoverTargetSelector(className: string): string {
		return `.${className}`;
	}

	function clearLevelHoverStateIfOutside(
		levelNumber: number,
		event: PointerEvent | FocusEvent
	): void {
		const relatedTarget = event.relatedTarget;
		if (relatedTarget instanceof Node && isWithinLevelHoverTarget(levelNumber, relatedTarget)) {
			return;
		}
		if (event instanceof PointerEvent) {
			const { clientX, clientY } = event;
			requestAnimationFrame(() => {
				const currentTarget = document.elementFromPoint(clientX, clientY);
				if (currentTarget instanceof Node && isWithinLevelHoverTarget(levelNumber, currentTarget)) {
					return;
				}
				setLevelHoverState(levelNumber, false);
			});
			return;
		}
		setLevelHoverState(levelNumber, false);
	}

	function isWithinLevelHoverTarget(levelNumber: number, target: Node): boolean {
		return (
			Boolean(resolveLevelGuideElement(levelNumber)?.contains(target)) ||
			Boolean(resolveLayerElement(levelNumber)?.contains(target))
		);
	}

	function setAllLevelsHoverState(hovered: boolean): void {
		resolveAllLevelsGuideElement()?.classList.toggle(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.allLevelsGuideHovered,
			hovered
		);
	}

	function resolveLevelGuideElement(levelNumber: number): HTMLElement | null {
		return document.getElementById(
			resolveTerraformsHypercastleOverviewLevelGuideElementId(levelNumber)
		);
	}

	function resolveAllLevelsGuideElement(): HTMLElement | null {
		return document.getElementById(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.ids.allLevelsGuide);
	}

	function resolveLayerElement(levelNumber: number): HTMLElement | null {
		return document.getElementById(resolveTerraformsHypercastleOverviewLayerElementId(levelNumber));
	}

	function configureLayerElement(element: SVGElement, layer: TerraformsHypercastleOverviewLayer): void {
		const label = formatTerraformsHypercastleOverviewLayerLabel(layer.levelNumber);
		const surface = resolveLayerSurface(layer);
		element.classList.add(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layer);
		element.setAttribute(DOM_ATTRIBUTES.role, DOM_ATTRIBUTE_VALUES.button);
		element.setAttribute(DOM_ATTRIBUTES.tabindex, DOM_ATTRIBUTE_VALUES.zero);
		element.setAttribute(DOM_ATTRIBUTES.ariaLabel, label);
		element.setAttribute(DOM_ATTRIBUTES.ariaPressed, DOM_ATTRIBUTE_VALUES.false);
		element.setAttribute(DOM_ATTRIBUTES.title, label);
		element.setAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.levelNumber,
			String(layer.levelNumber)
		);
		element.setAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.levelDimension,
			String(layer.dimension)
		);
		if (surface) {
			element.setAttribute(
				TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceSeed,
				String(surface.seed)
			);
			element.setAttribute(
				TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceZoneIndex,
				String(surface.zoneIndex)
			);
			element.setAttribute(
				TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceBackgroundColor,
				resolveTerraformsHypercastleSurfaceTextureBackgroundColor(surface)
			);
		}
		// Mirror slab hover onto the guide so hidden leaders appear from either hit target.
		element.addEventListener(DOM_EVENTS.pointerEnter, () =>
			setLevelHoverState(layer.levelNumber, true)
		);
		element.addEventListener(DOM_EVENTS.pointerLeave, (event) =>
			clearLevelHoverStateIfOutside(layer.levelNumber, event)
		);
		element.addEventListener(DOM_EVENTS.focus, () => setLevelHoverState(layer.levelNumber, true));
		element.addEventListener(DOM_EVENTS.blur, (event) =>
			clearLevelHoverStateIfOutside(layer.levelNumber, event)
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
		selectLevelNumber(layer.levelNumber);
	}

	function selectLevelNumber(levelNumber: number): void {
		pinLevel(levelNumber);
		onLevelSelect(levelNumber);
	}

	function selectAllLevels(): void {
		pinnedLevelNumber = null;
		restoreCanonicalLayerOrder();
		onAllLevelsSelect();
	}

	function syncSelectedLevelState(): void {
		for (const layer of layers) {
			const selected = layer.levelNumber === selectedLevelNumber;
			syncLevelSelectionState(resolveLayerElement(layer.levelNumber), selected);
			syncLevelSelectionState(resolveLevelGuideElement(layer.levelNumber), selected);
		}
		syncAllLevelsSelectionState();
	}

	function syncLevelSelectionState(element: HTMLElement | null, selected: boolean): void {
		if (!element) return;
		element.classList.toggle(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layerSelected,
			selected &&
				element.classList.contains(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layer)
		);
		element.classList.toggle(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideSelected,
			selected &&
				element.classList.contains(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guide)
		);
		element.setAttribute(
			DOM_ATTRIBUTES.ariaPressed,
			selected ? DOM_ATTRIBUTE_VALUES.true : DOM_ATTRIBUTE_VALUES.false
		);
	}

	function syncAllLevelsSelectionState(): void {
		const element = resolveAllLevelsGuideElement();
		if (!element) return;
		element.classList.toggle(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.allLevelsGuideSelected,
			allLevelsSelected
		);
		element.setAttribute(
			DOM_ATTRIBUTES.ariaPressed,
			allLevelsSelected ? DOM_ATTRIBUTE_VALUES.true : DOM_ATTRIBUTE_VALUES.false
		);
	}

	function pinLevel(levelNumber: number): void {
		pinnedLevelNumber = levelNumber;
		syncPinnedLevelOrder();
	}

	function syncPinnedLevelOrder(): void {
		if (pinnedLevelNumber === null) {
			restoreCanonicalLayerOrder();
			return;
		}
		const element = resolveLayerElement(pinnedLevelNumber);
		element?.parentNode?.appendChild(element);
	}

	function restoreCanonicalLayerOrder(): void {
		for (const layer of layers) {
			const element = resolveLayerElement(layer.levelNumber);
			element?.parentNode?.appendChild(element);
		}
	}

	function resolveLayerFaceFillColor(
		layer: TerraformsHypercastleOverviewLayer,
		faceKind: TerraformsHypercastleOverviewFaceKind
	): string {
		if (isSurfaceTextureTopFace(layer, faceKind)) {
			return SVG_ATTRIBUTE_VALUES.transparent;
		}
		return resolveLayerSurfaceBackgroundColor(layer);
	}

	function resolveLayerFaceFillOpacity(
		layer: TerraformsHypercastleOverviewLayer,
		faceKind: TerraformsHypercastleOverviewFaceKind
	): number {
		if (isSurfaceTextureTopFace(layer, faceKind)) {
			return TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fillOpacity.top;
		}
		return TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fillOpacity.vertical;
	}

	function resolveLayerFaceStrokeColor(
		layer: TerraformsHypercastleOverviewLayer,
		faceKind: TerraformsHypercastleOverviewFaceKind
	): string {
		return isSurfaceTextureTopFace(layer, faceKind)
			? resolveLayerSurfaceBackgroundColor(layer)
			: resolveLayerSurfaceBackgroundColor(layer);
	}

	function resolveLayerFaceStrokeDashArray(): number[] {
		return [...TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeDashArray.solid];
	}

	function resolveLayerFaceStrokeOpacity(faceKind: TerraformsHypercastleOverviewFaceKind): number {
		return isTerraformsHypercastleOverviewVerticalFace(faceKind)
			? TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeOpacity.vertical
			: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.strokeOpacity.top;
	}

	function resolveStrokeLineCap(
		strokeDashArray: readonly number[]
	): IsometricModule['LineCap'][keyof IsometricModule['LineCap']] {
		return strokeDashArray.length > 0 ? isometricModule!.LineCap.round : resolveButtLineCap();
	}

	function resolveButtLineCap(): IsometricModule['LineCap'][keyof IsometricModule['LineCap']] {
		return isometricModule!.LineCap.butt;
	}

	function isSurfaceTextureTopFace(
		layer: TerraformsHypercastleOverviewLayer,
		faceKind: TerraformsHypercastleOverviewFaceKind
	): boolean {
		return (
			resolveLayerSurface(layer) !== null &&
			faceKind === TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Top
		);
	}

	function resolveLayerSurface(
		layer: TerraformsHypercastleOverviewLayer
	): TerraformsHypercastleLevelSurface | null {
		return resolveTerraformsHypercastleSurfaceForLevel(levelSurfaces, layer.levelNumber);
	}

	function resolveLayerSurfaceBackgroundColor(layer: TerraformsHypercastleOverviewLayer): string {
		const surface = resolveLayerSurface(layer);
		return surface
			? resolveTerraformsHypercastleSurfaceTextureBackgroundColor(surface)
			: TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color;
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
		justify-items: start;
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
		pointer-events: all;
		vector-effect: non-scaling-stroke;
		transition:
			filter 120ms ease,
			stroke 120ms ease,
			stroke-width 120ms ease;
	}

	:global(.terraforms-hypercastle-overview-layer-face-top) {
		pointer-events: all;
	}

	:global(.terraforms-hypercastle-overview-layer-texture-cell) {
		pointer-events: none;
		vector-effect: non-scaling-stroke;
		transition: filter 120ms ease;
	}

	:global(.terraforms-hypercastle-overview-level-guide) {
		cursor: pointer;
		outline: none;
	}

	:global(.terraforms-hypercastle-overview-all-levels-guide) {
		cursor: pointer;
		outline: none;
	}

	:global(.terraforms-hypercastle-overview-level-guide-hit-target) {
		pointer-events: all;
	}

	:global(.terraforms-hypercastle-overview-all-levels-guide-hit-target) {
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

	:global(.terraforms-hypercastle-overview-all-levels-guide-label) {
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
	),
	:global(
			.terraforms-hypercastle-overview-layer-selected
				.terraforms-hypercastle-overview-layer-face
	),
	:global(
			.terraforms-hypercastle-overview-layer:hover
				.terraforms-hypercastle-overview-layer-texture-cell
	),
	:global(
			.terraforms-hypercastle-overview-layer:focus-visible
				.terraforms-hypercastle-overview-layer-texture-cell
	),
	:global(
			.terraforms-hypercastle-overview-layer-hovered
				.terraforms-hypercastle-overview-layer-texture-cell
	),
	:global(
			.terraforms-hypercastle-overview-layer-selected
				.terraforms-hypercastle-overview-layer-texture-cell
	) {
		filter: brightness(1.16);
	}

	:global(.terraforms-hypercastle-overview-layer:hover .terraforms-hypercastle-overview-layer-face),
	:global(
			.terraforms-hypercastle-overview-layer:focus-visible
				.terraforms-hypercastle-overview-layer-face
	),
	:global(
			.terraforms-hypercastle-overview-layer-hovered
				.terraforms-hypercastle-overview-layer-face
	),
	:global(
			.terraforms-hypercastle-overview-layer-selected
				.terraforms-hypercastle-overview-layer-face
	) {
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
	),
	:global(
			.terraforms-hypercastle-overview-level-guide-selected
				.terraforms-hypercastle-overview-level-guide-label
	) {
		filter: brightness(1.35);
		fill-opacity: 1;
	}

	:global(
			.terraforms-hypercastle-overview-all-levels-guide:hover
				.terraforms-hypercastle-overview-all-levels-guide-label
	),
	:global(
			.terraforms-hypercastle-overview-all-levels-guide:focus-visible
				.terraforms-hypercastle-overview-all-levels-guide-label
	),
	:global(
			.terraforms-hypercastle-overview-all-levels-guide-hovered
				.terraforms-hypercastle-overview-all-levels-guide-label
	),
	:global(
			.terraforms-hypercastle-overview-all-levels-guide-selected
				.terraforms-hypercastle-overview-all-levels-guide-label
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
	),
	:global(
			.terraforms-hypercastle-overview-level-guide-selected
				.terraforms-hypercastle-overview-level-guide-leader
	) {
		stroke-opacity: 1;
	}
</style>
