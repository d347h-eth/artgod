import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from 'playwright/test';
import {
	TERRAFORMS_EXTENSION_KEY,
	TERRAFORMS_EXTENSION_PAGE_REFS,
	TERRAFORMS_HYPERCASTLE_LEVELS
} from '@artgod/shared/extensions/terraforms';
import {
	formatTerraformsHypercastleOverviewLevelGuideLabel,
	resolveTerraformsHypercastleOverviewFaceClassName,
	resolveTerraformsHypercastleOverviewLayerElementId,
	resolveTerraformsHypercastleOverviewLevelGuideElementId,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_POSITIONS,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES,
	TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION
} from '../src/lib/collection-extension-pages/terraforms/hypercastle-overview';
import {
	attachDiagnosticsForTestFailure,
	captureDiagnosticsForTest,
	type PageDiagnosticsRegistry
} from './attached-app';

type ReachableLayerPoint = {
	x: number;
	y: number;
	targetClass: string;
	layerId: string;
};

type HypercastleOverviewMetrics = {
	svg: {
		width: string | null;
		height: string | null;
		levelCount: string | null;
	} | null;
	layerCount: number;
	faceCount: number;
	verticalFaceCount: number;
	topFaceCount: number;
	verticalFillColor: string[];
	verticalStrokeColor: string[];
	verticalFillOpacity: string[];
	topFillOpacity: string[];
	topStrokeOpacity: string[];
	verticalStrokeDashArray: string[];
	verticalPointerEvents: string[];
	topPointerEvents: string[];
	outlineSegmentCount: number;
	outlineStrokeColor: string[];
	outlinePointerEvents: string[];
	outlineSolidCount: number;
	outlineDottedCount: number;
	topBackSolidCount: number;
	topBackDottedCount: number;
	bottomBackDottedCount: number;
	level12VerticalFillColor: string[];
	level12VerticalStrokeDashArray: string[];
	level12VerticalStrokeLinecap: string[];
	stripePatternFillOpacity: string | null;
	levelGuideCount: number;
	levelGuideLeaderCount: number;
	levelGuideLabelCount: number;
	levelGuideLeaderStrokeDashArray: string[];
	levelGuideLeaderStrokeOpacity: string[];
	levelGuideLeaderStrokeWidth: string[];
	levelGuideCutoffXs: string[];
	levelGuideLabels: string[];
	level12ReachableFrontPoint: ReachableLayerPoint | null;
	level12ReachableSidePoint: ReachableLayerPoint | null;
};

const ACCESSIBLE_ROLES = {
	link: 'link'
} as const;
const BROWSER_EVENTS = {
	console: 'console',
	pageError: 'pageerror'
} as const;
const CONSOLE_MESSAGE_TYPES = {
	error: 'error'
} as const;
const DOCUMENT_READY_STATES = {
	domContentLoaded: 'domcontentloaded'
} as const;
const HYDRATION_DATASET_KEY = 'artgodHydrated';
const HYDRATION_DATASET_READY_VALUE = '1';
const COLLECTION_NAV_CLASS_NAMES = {
	activeTab: 'runtime-tab-active'
} as const;
const SVG_ATTRIBUTE_NAMES = {
	class: 'class',
	fill: 'fill',
	height: 'height',
	stroke: 'stroke',
	strokeDashArray: 'stroke-dasharray',
	strokeLinecap: 'stroke-linecap',
	strokeOpacity: 'stroke-opacity',
	strokeWidth: 'stroke-width',
	width: 'width',
	fillOpacity: 'fill-opacity',
	x2: 'x2'
} as const;
const CSS_PROPERTY_NAMES = {
	pointerEvents: 'pointer-events'
} as const;
const TAG_NAMES = {
	svg: 'svg',
	rect: 'rect'
} as const;
const DATA_ATTRIBUTE_NAMES = {
	testId: 'testid'
} as const;
const SCROLL_INTO_VIEW_POSITIONS = {
	center: 'center'
} as const;
const TEST_ARTIFACTS = {
	pageScreenshot: {
		name: 'terraforms-hypercastle-page.png',
		contentType: 'image/png'
	},
	hoverScreenshot: {
		name: 'terraforms-hypercastle-hover-page.png',
		contentType: 'image/png'
	},
	probe: {
		name: 'terraforms-hypercastle-probe.json',
		contentType: 'application/json'
	}
} as const;
const EMPTY_ATTRIBUTE_VALUE = '';
const HYPERCASTLE_EXPECTED_LEVEL_COUNT = TERRAFORMS_HYPERCASTLE_LEVELS.length;
const HYPERCASTLE_EXPECTED_FACE_COUNT = HYPERCASTLE_EXPECTED_LEVEL_COUNT * 3;
const HYPERCASTLE_EXPECTED_VERTICAL_FACE_COUNT = HYPERCASTLE_EXPECTED_LEVEL_COUNT * 2;
const HYPERCASTLE_EXPECTED_BOTTOM_BACK_OUTLINE_COUNT = HYPERCASTLE_EXPECTED_LEVEL_COUNT * 2;
const HYPERCASTLE_MIN_OUTLINE_SEGMENT_COUNT = HYPERCASTLE_EXPECTED_LEVEL_COUNT * 4;
const HYPERCASTLE_REACHABILITY_LEVEL_NUMBER =
	TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fadedLevelNumber;
const HYPERCASTLE_PATH = `/e2e-harness/collection/extensions/${TERRAFORMS_EXTENSION_KEY}/${TERRAFORMS_EXTENSION_PAGE_REFS.Hypercastle}`;
const HYPERCASTLE_PROBE_CONTRACT = {
	browserValues: TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES,
	cssProperties: CSS_PROPERTY_NAMES,
	dom: TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM,
	emptyAttributeValue: EMPTY_ATTRIBUTE_VALUE,
	faceKinds: TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS,
	outlinePositions: TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_POSITIONS,
	outlineStyles: TERRAFORMS_HYPERCASTLE_OVERVIEW_OUTLINE_STYLES,
	reachabilityLevelNumber: String(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER),
	scrollIntoViewPosition: SCROLL_INTO_VIEW_POSITIONS.center,
	faceClasses: {
		front: resolveTerraformsHypercastleOverviewFaceClassName(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Front
		),
		side: resolveTerraformsHypercastleOverviewFaceClassName(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Side
		),
		top: resolveTerraformsHypercastleOverviewFaceClassName(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Top
		)
	},
	selectors: {
		overview: dataAttributeSelector(
			DATA_ATTRIBUTE_NAMES.testId,
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.testId
		),
		svg: `${TAG_NAMES.svg}${classSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.svg)}`,
		layer: classSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layer),
		face: classSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.face),
		outline: classSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.outlineSegment),
		guide: classSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guide),
		guideLeader: classSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideLeader),
		guideLabel: classSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideLabel),
		fadedLevelLayer: idSelector(
			resolveTerraformsHypercastleOverviewLayerElementId(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER)
		),
		fadedLevelGuide: idSelector(
			resolveTerraformsHypercastleOverviewLevelGuideElementId(
				HYPERCASTLE_REACHABILITY_LEVEL_NUMBER
			)
		),
		stripePattern: idSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.ids.stripePattern),
		reachableFrontFace: `${idSelector(
			resolveTerraformsHypercastleOverviewLayerElementId(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER)
		)} ${classSelector(
			resolveTerraformsHypercastleOverviewFaceClassName(
				TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Front
			)
		)}`,
		reachableSideFace: `${idSelector(
			resolveTerraformsHypercastleOverviewLayerElementId(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER)
		)} ${classSelector(
			resolveTerraformsHypercastleOverviewFaceClassName(
				TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Side
			)
		)}`
	},
	svgTags: TAG_NAMES,
	svgAttributes: SVG_ATTRIBUTE_NAMES
} as const;
const diagnosticsByTest: PageDiagnosticsRegistry = new Map();

test.beforeEach(({ page }, testInfo) => {
	captureDiagnosticsForTest(diagnosticsByTest, page, testInfo);
});

test.afterEach(async ({}, testInfo) => {
	await attachDiagnosticsForTestFailure(diagnosticsByTest, testInfo);
});

test.describe('Terraforms Hypercastle overview', () => {
	test('renders the page shell and selectable overview slabs', async ({ page }, testInfo) => {
		const browserErrors = captureBrowserErrors(page);

		await page.goto(HYPERCASTLE_PATH, { waitUntil: DOCUMENT_READY_STATES.domContentLoaded });
		await page.waitForFunction(
			({ datasetKey, readyValue }) => document.documentElement.dataset[datasetKey] === readyValue,
			{
				datasetKey: HYDRATION_DATASET_KEY,
				readyValue: HYDRATION_DATASET_READY_VALUE
			}
		);
		await expect(
			page.getByRole(ACCESSIBLE_ROLES.link, { name: TERRAFORMS_EXTENSION_KEY })
		).toBeVisible();
		await expect(
			page.locator(classSelector(COLLECTION_NAV_CLASS_NAMES.activeTab), {
				hasText: TERRAFORMS_EXTENSION_PAGE_REFS.Hypercastle
			})
		).toBeVisible();

		const overview = page.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.overview);
		await expect(overview.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.svg)).toBeVisible();

		const metrics = await collectHypercastleOverviewMetrics(page);
		await attachPageScreenshot(page, testInfo, TEST_ARTIFACTS.pageScreenshot);
		await attachProbeResult(testInfo, { metrics, browserErrors });

		expect(metrics.svg?.levelCount).toBe(String(HYPERCASTLE_EXPECTED_LEVEL_COUNT));
		expect(metrics.layerCount).toBe(HYPERCASTLE_EXPECTED_LEVEL_COUNT);
		expect(metrics.faceCount).toBe(HYPERCASTLE_EXPECTED_FACE_COUNT);
		expect(metrics.verticalFaceCount).toBe(HYPERCASTLE_EXPECTED_VERTICAL_FACE_COUNT);
		expect(metrics.topFaceCount).toBe(HYPERCASTLE_EXPECTED_LEVEL_COUNT);
		expect(metrics.verticalFillColor).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color,
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.stripePatternFill
		]);
		expect(metrics.verticalStrokeColor).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color
		]);
		expect(metrics.verticalFillOpacity).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.fillOpaque
		]);
		expect(metrics.topFillOpacity).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.fillTransparent
		]);
		expect(metrics.topStrokeOpacity).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.fillTransparent
		]);
		expect(metrics.verticalStrokeDashArray).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.strokeDashArraySolid,
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.strokeDashArrayDotted
		]);
		expect(metrics.verticalPointerEvents).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.pointerEventsAll
		]);
		expect(metrics.topPointerEvents).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.pointerEventsNone
		]);
		expect(metrics.outlineSegmentCount).toBeGreaterThanOrEqual(
			HYPERCASTLE_MIN_OUTLINE_SEGMENT_COUNT
		);
		expect(metrics.outlineStrokeColor).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color
		]);
		expect(metrics.outlinePointerEvents).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.pointerEventsNone
		]);
		expect(metrics.outlineSolidCount).toBeGreaterThan(0);
		expect(metrics.outlineDottedCount).toBeGreaterThan(0);
		expect(metrics.topBackSolidCount).toBeGreaterThan(0);
		expect(metrics.topBackDottedCount).toBeGreaterThan(0);
		expect(metrics.bottomBackDottedCount).toBe(HYPERCASTLE_EXPECTED_BOTTOM_BACK_OUTLINE_COUNT);
		expect(metrics.level12VerticalFillColor).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.stripePatternFill
		]);
		expect(metrics.level12VerticalStrokeDashArray).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.strokeDashArrayDotted
		]);
		expect(metrics.level12VerticalStrokeLinecap).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.strokeLinecapRound
		]);
		expect(metrics.stripePatternFillOpacity).toBe(
			String(TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.fadedLevelPatternFillOpacity)
		);
		expect(metrics.levelGuideCount).toBe(HYPERCASTLE_EXPECTED_LEVEL_COUNT);
		expect(metrics.levelGuideLeaderCount).toBe(HYPERCASTLE_EXPECTED_LEVEL_COUNT);
		expect(metrics.levelGuideLabelCount).toBe(HYPERCASTLE_EXPECTED_LEVEL_COUNT);
		expect(metrics.levelGuideLeaderStrokeDashArray).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.strokeDashArrayDashed
		]);
		expect(metrics.levelGuideLeaderStrokeOpacity).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.strokeOpacityHidden
		]);
		expect(metrics.levelGuideLeaderStrokeWidth).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.strokeWidthSingle
		]);
		expect(metrics.levelGuideCutoffXs).toHaveLength(1);
		expect(metrics.levelGuideLabels).toContain(
			formatTerraformsHypercastleOverviewLevelGuideLabel(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER)
		);
		expect(metrics.level12ReachableFrontPoint).not.toBeNull();
		expect(metrics.level12ReachableSidePoint).not.toBeNull();
		expect(browserErrors.consoleErrors).toEqual([]);
		expect(browserErrors.pageErrors).toEqual([]);

		const hoveredClassPattern = new RegExp(
			`\\b${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layerHovered}\\b`
		);
		const guideHoveredClassPattern = new RegExp(
			`\\b${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideHovered}\\b`
		);
		const fadedLevelGuide = page.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.fadedLevelGuide);
		const fadedLevelLayer = page.locator(
			idSelector(
				resolveTerraformsHypercastleOverviewLayerElementId(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER)
			)
		);

		await fadedLevelGuide.hover();
		await expect(
			fadedLevelLayer
		).toHaveClass(hoveredClassPattern);
		await expect(fadedLevelGuide).toHaveClass(guideHoveredClassPattern);

		await moveMouseToReachableLayerPoint(
			page,
			HYPERCASTLE_PROBE_CONTRACT.selectors.reachableFrontFace,
			HYPERCASTLE_PROBE_CONTRACT.reachabilityLevelNumber
		);
		await expect(fadedLevelGuide).toHaveClass(guideHoveredClassPattern);
		await attachPageScreenshot(page, testInfo, TEST_ARTIFACTS.hoverScreenshot);
	});
});

function captureBrowserErrors(page: Page): { consoleErrors: string[]; pageErrors: string[] } {
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	page.on(BROWSER_EVENTS.console, (message) => {
		if (message.type() === CONSOLE_MESSAGE_TYPES.error) {
			consoleErrors.push(message.text());
		}
	});
	page.on(BROWSER_EVENTS.pageError, (error) => {
		pageErrors.push(error.stack || error.message);
	});
	return { consoleErrors, pageErrors };
}

async function attachPageScreenshot(
	page: Page,
	testInfo: TestInfo,
	artifact: { name: string; contentType: string }
): Promise<void> {
	const screenshotPath = testInfo.outputPath(artifact.name);
	await page.screenshot({ path: screenshotPath, fullPage: true });
	await testInfo.attach(artifact.name, {
		path: screenshotPath,
		contentType: artifact.contentType
	});
}

async function attachProbeResult(
	testInfo: TestInfo,
	result: {
		metrics: HypercastleOverviewMetrics;
		browserErrors: { consoleErrors: string[]; pageErrors: string[] };
	}
): Promise<void> {
	const probePath = testInfo.outputPath(TEST_ARTIFACTS.probe.name);
	await writeFile(probePath, JSON.stringify(result, null, 2));
	await testInfo.attach(TEST_ARTIFACTS.probe.name, {
		path: probePath,
		contentType: TEST_ARTIFACTS.probe.contentType
	});
}

async function collectHypercastleOverviewMetrics(page: Page): Promise<HypercastleOverviewMetrics> {
	return page.evaluate((contract) => {
		const uniqueAttribute = (items: Element[], name: string): string[] =>
			Array.from(
				new Set(items.map((item) => item.getAttribute(name) ?? contract.emptyAttributeValue))
			);
		const uniqueStyle = (items: Element[], name: string): string[] =>
			Array.from(new Set(items.map((item) => getComputedStyle(item).getPropertyValue(name))));
		const findReachableLayerPoint = (
			selector: string,
			levelNumber: string
		): ReachableLayerPoint | null => {
			const face = document.querySelector(selector);
			if (!(face instanceof SVGGraphicsElement)) return null;
			face.scrollIntoView({
				block: contract.scrollIntoViewPosition,
				inline: contract.scrollIntoViewPosition
			});
			const box = face.getBoundingClientRect();
			const columns = 9;
			const rows = 5;
			for (let row = 1; row < rows; row += 1) {
				for (let column = 1; column < columns; column += 1) {
					const x = box.left + (box.width * column) / columns;
					const y = box.top + (box.height * row) / rows;
					const target = document.elementFromPoint(x, y);
					const layer = target?.closest?.(contract.selectors.layer);
					if (layer?.getAttribute(contract.dom.attributes.levelNumber) === levelNumber) {
						return {
							x,
							y,
							targetClass:
								target?.getAttribute(contract.svgAttributes.class) ?? contract.emptyAttributeValue,
							layerId: layer.id
						};
					}
				}
			}
			return null;
		};
		const overview = document.querySelector(contract.selectors.overview);
		const svg = overview?.querySelector(contract.selectors.svg);
		const layers = Array.from(document.querySelectorAll(contract.selectors.layer));
		const faces = Array.from(document.querySelectorAll(contract.selectors.face));
		const outlines = Array.from(document.querySelectorAll(contract.selectors.outline));
		const guides = Array.from(document.querySelectorAll(contract.selectors.guide));
		const guideLeaders = Array.from(document.querySelectorAll(contract.selectors.guideLeader));
		const guideLabels = Array.from(document.querySelectorAll(contract.selectors.guideLabel));
		const stripePattern = document.querySelector(contract.selectors.stripePattern);
		const stripePatternRect = stripePattern?.querySelector(contract.svgTags.rect) ?? null;
		const verticalFaces = faces.filter(
			(face) =>
				face.classList.contains(contract.faceClasses.front) ||
				face.classList.contains(contract.faceClasses.side)
		);
		const topFaces = faces.filter((face) => face.classList.contains(contract.faceClasses.top));
		const levelTwelveLayer = document.querySelector(contract.selectors.fadedLevelLayer);
		const levelTwelveVerticalFaces = levelTwelveLayer
			? Array.from(levelTwelveLayer.querySelectorAll(contract.selectors.face)).filter(
					(face) =>
						face.classList.contains(contract.faceClasses.front) ||
						face.classList.contains(contract.faceClasses.side)
				)
			: [];

		return {
			svg: svg
				? {
						width: svg.getAttribute(contract.svgAttributes.width),
						height: svg.getAttribute(contract.svgAttributes.height),
						levelCount: svg.getAttribute(contract.dom.attributes.levelCount)
					}
				: null,
			layerCount: layers.length,
			faceCount: faces.length,
			verticalFaceCount: verticalFaces.length,
			topFaceCount: topFaces.length,
			verticalFillColor: uniqueAttribute(verticalFaces, contract.svgAttributes.fill),
			verticalStrokeColor: uniqueAttribute(verticalFaces, contract.svgAttributes.stroke),
			verticalFillOpacity: uniqueAttribute(verticalFaces, contract.svgAttributes.fillOpacity),
			topFillOpacity: uniqueAttribute(topFaces, contract.svgAttributes.fillOpacity),
			topStrokeOpacity: uniqueAttribute(topFaces, contract.svgAttributes.strokeOpacity),
			verticalStrokeDashArray: uniqueAttribute(
				verticalFaces,
				contract.svgAttributes.strokeDashArray
			),
			verticalPointerEvents: uniqueStyle(verticalFaces, contract.cssProperties.pointerEvents),
			topPointerEvents: uniqueStyle(topFaces, contract.cssProperties.pointerEvents),
			outlineSegmentCount: outlines.length,
			outlineStrokeColor: uniqueAttribute(outlines, contract.svgAttributes.stroke),
			outlinePointerEvents: uniqueStyle(outlines, contract.cssProperties.pointerEvents),
			outlineSolidCount: outlines.filter(
				(outline) =>
					outline.getAttribute(contract.dom.attributes.outlineStyle) ===
					contract.outlineStyles.Solid
			).length,
			outlineDottedCount: outlines.filter(
				(outline) =>
					outline.getAttribute(contract.dom.attributes.outlineStyle) ===
					contract.outlineStyles.Dotted
			).length,
			topBackSolidCount: outlines.filter(
				(outline) =>
					outline.getAttribute(contract.dom.attributes.outlinePosition) ===
						contract.outlinePositions.TopBack &&
					outline.getAttribute(contract.dom.attributes.outlineStyle) ===
						contract.outlineStyles.Solid
			).length,
			topBackDottedCount: outlines.filter(
				(outline) =>
					outline.getAttribute(contract.dom.attributes.outlinePosition) ===
						contract.outlinePositions.TopBack &&
					outline.getAttribute(contract.dom.attributes.outlineStyle) ===
						contract.outlineStyles.Dotted
			).length,
			bottomBackDottedCount: outlines.filter(
				(outline) =>
					outline.getAttribute(contract.dom.attributes.outlinePosition) ===
						contract.outlinePositions.BottomBack &&
					outline.getAttribute(contract.dom.attributes.outlineStyle) ===
						contract.outlineStyles.Dotted
			).length,
			level12VerticalFillColor: uniqueAttribute(levelTwelveVerticalFaces, contract.svgAttributes.fill),
			level12VerticalStrokeDashArray: uniqueAttribute(
				levelTwelveVerticalFaces,
				contract.svgAttributes.strokeDashArray
			),
			level12VerticalStrokeLinecap: uniqueAttribute(
				levelTwelveVerticalFaces,
				contract.svgAttributes.strokeLinecap
			),
			stripePatternFillOpacity: stripePatternRect?.getAttribute(
				contract.svgAttributes.fillOpacity
			) ?? null,
			levelGuideCount: guides.length,
			levelGuideLeaderCount: guideLeaders.length,
			levelGuideLabelCount: guideLabels.length,
			levelGuideLeaderStrokeDashArray: uniqueAttribute(
				guideLeaders,
				contract.svgAttributes.strokeDashArray
			),
			levelGuideLeaderStrokeOpacity: uniqueAttribute(
				guideLeaders,
				contract.svgAttributes.strokeOpacity
			),
			levelGuideLeaderStrokeWidth: uniqueAttribute(
				guideLeaders,
				contract.svgAttributes.strokeWidth
			),
			levelGuideCutoffXs: Array.from(
				new Set(
					guideLeaders.map(
						(leader) =>
							leader.getAttribute(contract.svgAttributes.x2) ?? contract.emptyAttributeValue
					)
				)
			),
			levelGuideLabels: guideLabels.map((label) => label.textContent ?? contract.emptyAttributeValue),
			level12ReachableFrontPoint: findReachableLayerPoint(
				contract.selectors.reachableFrontFace,
				contract.reachabilityLevelNumber
			),
			level12ReachableSidePoint: findReachableLayerPoint(
				contract.selectors.reachableSideFace,
				contract.reachabilityLevelNumber
			)
		};
	}, HYPERCASTLE_PROBE_CONTRACT);
}

async function moveMouseToReachableLayerPoint(
	page: Page,
	selector: string,
	levelNumber: string
): Promise<void> {
	const point = await page.evaluate(
		({ contract, selector, levelNumber }) => {
			const face = document.querySelector(selector);
			if (!(face instanceof SVGGraphicsElement)) return null;
			face.scrollIntoView({
				block: contract.scrollIntoViewPosition,
				inline: contract.scrollIntoViewPosition
			});
			const box = face.getBoundingClientRect();
			const columns = 9;
			const rows = 5;
			for (let row = 1; row < rows; row += 1) {
				for (let column = 1; column < columns; column += 1) {
					const x = box.left + (box.width * column) / columns;
					const y = box.top + (box.height * row) / rows;
					const target = document.elementFromPoint(x, y);
					const layer = target?.closest?.(contract.selectors.layer);
					if (layer?.getAttribute(contract.dom.attributes.levelNumber) === levelNumber) {
						return { x, y };
					}
				}
			}
			return null;
		},
		{ contract: HYPERCASTLE_PROBE_CONTRACT, selector, levelNumber }
	);

	expect(point).not.toBeNull();
	await page.mouse.move(point!.x, point!.y);
}

function classSelector(className: string): string {
	return `.${className}`;
}

function dataAttributeSelector(attributeName: string, value: string): string {
	return `[data-${attributeName}="${value}"]`;
}

function idSelector(id: string): string {
	return `#${id}`;
}
