import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from 'playwright/test';
import {
	TERRAFORMS_EXTENSION_KEY,
	TERRAFORMS_EXTENSION_PAGE_REFS,
	TERRAFORMS_HYPERCASTLE_LEVELS
} from '@artgod/shared/extensions/terraforms';
import {
	resolveTerraformsHypercastleOverviewFaceClassName,
	resolveTerraformsHypercastleOverviewLayerElementId,
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
	outlineDashedCount: number;
	topBackSolidCount: number;
	topBackDashedCount: number;
	bottomBackDashedCount: number;
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
	strokeOpacity: 'stroke-opacity',
	width: 'width',
	fillOpacity: 'fill-opacity'
} as const;
const CSS_PROPERTY_NAMES = {
	pointerEvents: 'pointer-events'
} as const;
const TAG_NAMES = {
	svg: 'svg'
} as const;
const DATA_ATTRIBUTE_NAMES = {
	testId: 'testid'
} as const;
const TEST_ARTIFACTS = {
	pageScreenshot: {
		name: 'terraforms-hypercastle-page.png',
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
const HYPERCASTLE_REACHABILITY_LEVEL_NUMBER = 12;
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
		await attachPageScreenshot(page, testInfo);
		await attachProbeResult(testInfo, { metrics, browserErrors });

		expect(metrics.svg?.levelCount).toBe(String(HYPERCASTLE_EXPECTED_LEVEL_COUNT));
		expect(metrics.layerCount).toBe(HYPERCASTLE_EXPECTED_LEVEL_COUNT);
		expect(metrics.faceCount).toBe(HYPERCASTLE_EXPECTED_FACE_COUNT);
		expect(metrics.verticalFaceCount).toBe(HYPERCASTLE_EXPECTED_VERTICAL_FACE_COUNT);
		expect(metrics.topFaceCount).toBe(HYPERCASTLE_EXPECTED_LEVEL_COUNT);
		expect(metrics.verticalFillColor).toEqual([TERRAFORMS_HYPERCASTLE_OVERVIEW_PRESENTATION.color]);
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
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.strokeDashArraySolid
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
		expect(metrics.outlineDashedCount).toBeGreaterThan(0);
		expect(metrics.topBackSolidCount).toBeGreaterThan(0);
		expect(metrics.topBackDashedCount).toBeGreaterThan(0);
		expect(metrics.bottomBackDashedCount).toBe(HYPERCASTLE_EXPECTED_BOTTOM_BACK_OUTLINE_COUNT);
		expect(metrics.level12ReachableFrontPoint).not.toBeNull();
		expect(metrics.level12ReachableSidePoint).not.toBeNull();
		expect(browserErrors.consoleErrors).toEqual([]);
		expect(browserErrors.pageErrors).toEqual([]);
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

async function attachPageScreenshot(page: Page, testInfo: TestInfo): Promise<void> {
	const screenshotPath = testInfo.outputPath(TEST_ARTIFACTS.pageScreenshot.name);
	await page.screenshot({ path: screenshotPath, fullPage: true });
	await testInfo.attach(TEST_ARTIFACTS.pageScreenshot.name, {
		path: screenshotPath,
		contentType: TEST_ARTIFACTS.pageScreenshot.contentType
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
		const verticalFaces = faces.filter(
			(face) =>
				face.classList.contains(contract.faceClasses.front) ||
				face.classList.contains(contract.faceClasses.side)
		);
		const topFaces = faces.filter((face) => face.classList.contains(contract.faceClasses.top));

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
			outlineDashedCount: outlines.filter(
				(outline) =>
					outline.getAttribute(contract.dom.attributes.outlineStyle) ===
					contract.outlineStyles.Dashed
			).length,
			topBackSolidCount: outlines.filter(
				(outline) =>
					outline.getAttribute(contract.dom.attributes.outlinePosition) ===
						contract.outlinePositions.TopBack &&
					outline.getAttribute(contract.dom.attributes.outlineStyle) ===
						contract.outlineStyles.Solid
			).length,
			topBackDashedCount: outlines.filter(
				(outline) =>
					outline.getAttribute(contract.dom.attributes.outlinePosition) ===
						contract.outlinePositions.TopBack &&
					outline.getAttribute(contract.dom.attributes.outlineStyle) ===
						contract.outlineStyles.Dashed
			).length,
			bottomBackDashedCount: outlines.filter(
				(outline) =>
					outline.getAttribute(contract.dom.attributes.outlinePosition) ===
						contract.outlinePositions.BottomBack &&
					outline.getAttribute(contract.dom.attributes.outlineStyle) ===
						contract.outlineStyles.Dashed
			).length,
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

function classSelector(className: string): string {
	return `.${className}`;
}

function dataAttributeSelector(attributeName: string, value: string): string {
	return `[data-${attributeName}="${value}"]`;
}

function idSelector(id: string): string {
	return `#${id}`;
}
