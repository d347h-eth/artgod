import { writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type TestInfo } from 'playwright/test';
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
	TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS
} from '../src/lib/collection-extension-pages/terraforms/hypercastle-overview';
import {
	buildTerraformsAllLevelZoneRows,
	buildTerraformsLevelZoneRows,
	defaultTerraformsLevelZoneSortColumn,
	defaultTerraformsLevelZoneSortDirection,
	defaultTerraformsSelectedLevelZoneSortColumn,
	defaultTerraformsSelectedLevelZoneSortDirection,
	formatTerraformsLevelZoneSortLabel,
	formatTerraformsZoneTopographyHeights,
	formatTerraformsZoneTopographyRangeLabel,
	sortTerraformsLevelZoneRows,
	TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS,
	TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS,
	TERRAFORMS_LEVEL_ZONE_TABLE_DOM,
	type TerraformsLevelZoneRow
} from '../src/lib/collection-extension-pages/terraforms/level-zones';
import {
	formatTerraformsLevelTitle,
	TERRAFORMS_HYPERCASTLE_SELECTION_LABELS
} from '../src/lib/collection-extension-pages/terraforms/hypercastle-selection';
import {
	resolveTerraformsHypercastleSurfaceTexturePatternId,
	resolveTerraformsHypercastleSurfaceTexturePatternFill,
	TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM,
	TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE,
	TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_LABELS
} from '../src/lib/collection-extension-pages/terraforms/hypercastle-surface-texture';
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
	layerOrder: string[];
	topFillOpacity: string[];
	topStrokeOpacity: string[];
	sampleLevelTopFillColor: string[];
	sampleLevelSurfaceZoneIndex: string | null;
	sampleLevelSurfaceSeed: string | null;
	sampleLevelSurfaceBackgroundColor: string | null;
	surfacePatternCount: number;
	surfacePatternCellCount: number;
	surfaceKey: string | null;
	topPointerEvents: string[];
	level12SurfaceBackgroundColor: string | null;
	levelGuideCount: number;
	levelGuideLeaderCount: number;
	levelGuideLabelCount: number;
	levelGuideLeaderStrokeDashArray: string[];
	levelGuideLeaderStrokeOpacity: string[];
	levelGuideLeaderStrokeWidth: string[];
	levelGuideCutoffXs: string[];
	levelGuideLabels: string[];
	allLevelsGuideCount: number;
	allLevelsGuideLabel: string | null;
	level12ReachableTopPoint: ReachableLayerPoint | null;
};

type HypercastleLevelDetailMetrics = {
	selectedLayerAriaPressed: string | null;
	selectedGuideAriaPressed: string | null;
	selectedLayerClass: string | null;
	selectedGuideClass: string | null;
	heading: string | null;
	rowCount: number;
	rowNames: string[];
	rowTopographyValues: string[];
	paletteSwatchCount: number;
};

const ACCESSIBLE_ROLES = {
	button: 'button',
	heading: 'heading',
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
	title: 'title',
	width: 'width',
	fillOpacity: 'fill-opacity',
	x2: 'x2'
} as const;
const ARIA_ATTRIBUTE_NAMES = {
	pressed: 'aria-pressed'
} as const;
const ARIA_ATTRIBUTE_VALUES = {
	true: 'true'
} as const;
const CSS_PROPERTY_NAMES = {
	pointerEvents: 'pointer-events'
} as const;
const TABLE_SELECTORS = {
	bodyRows: 'tbody tr',
	cells: 'td'
} as const;
const TAG_NAMES = {
	svg: 'svg',
	pattern: 'pattern',
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
	selectedScreenshot: {
		name: 'terraforms-hypercastle-selected-level-page.png',
		contentType: 'image/png'
	},
	allLevelsScreenshot: {
		name: 'terraforms-hypercastle-all-levels-page.png',
		contentType: 'image/png'
	},
	surfaceScreenshot: {
		name: 'terraforms-hypercastle-surface-page.png',
		contentType: 'image/png'
	},
	probe: {
		name: 'terraforms-hypercastle-probe.json',
		contentType: 'application/json'
	}
} as const;
const EMPTY_ATTRIBUTE_VALUE = '';
const HYPERCASTLE_EXPECTED_LEVEL_COUNT = TERRAFORMS_HYPERCASTLE_LEVELS.length;
const HYPERCASTLE_EXPECTED_FACE_COUNT = HYPERCASTLE_EXPECTED_LEVEL_COUNT;
const HYPERCASTLE_EXPECTED_VERTICAL_FACE_COUNT = 0;
const HYPERCASTLE_REACHABILITY_LEVEL_NUMBER = 12;
const HYPERCASTLE_DETAIL_LEVEL = TERRAFORMS_HYPERCASTLE_LEVELS.find(
	(level) => level.levelNumber === HYPERCASTLE_REACHABILITY_LEVEL_NUMBER
)!;
const HYPERCASTLE_TEXTURE_LEVEL_NUMBER = 14;
const HYPERCASTLE_TEXTURE_LEVEL = TERRAFORMS_HYPERCASTLE_LEVELS.find(
	(level) => level.levelNumber === HYPERCASTLE_TEXTURE_LEVEL_NUMBER
)!;
const HYPERCASTLE_PATH = `/e2e-harness/collection/extensions/${TERRAFORMS_EXTENSION_KEY}/${TERRAFORMS_EXTENSION_PAGE_REFS.Hypercastle}`;
const HYPERCASTLE_PROBE_CONTRACT = {
	browserValues: TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES,
	cssProperties: CSS_PROPERTY_NAMES,
	dom: TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM,
	emptyAttributeValue: EMPTY_ATTRIBUTE_VALUE,
	faceKinds: TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS,
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
		guide: classSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guide),
		guideLeader: classSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideLeader),
		guideLabel: classSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideLabel),
		allLevelsGuide: idSelector(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.ids.allLevelsGuide),
		allLevelsGuideLabel: classSelector(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.allLevelsGuideLabel
		),
		levelDetail: dataAttributeSelector(
			DATA_ATTRIBUTE_NAMES.testId,
			TERRAFORMS_LEVEL_ZONE_TABLE_DOM.testIds.detailPanel
		),
		levelZoneTable: dataAttributeSelector(
			DATA_ATTRIBUTE_NAMES.testId,
			TERRAFORMS_LEVEL_ZONE_TABLE_DOM.testIds.zoneTable
		),
		paletteSwatch: dataAttributeSelector(
			DATA_ATTRIBUTE_NAMES.testId,
			TERRAFORMS_LEVEL_ZONE_TABLE_DOM.testIds.paletteSwatch
		),
		reachableLevelLayer: idSelector(
			resolveTerraformsHypercastleOverviewLayerElementId(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER)
		),
		reachableLevelGuide: idSelector(
			resolveTerraformsHypercastleOverviewLevelGuideElementId(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER)
		),
		surfacePatterns: `${TAG_NAMES.pattern}${prefixedIdSelector(
			TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM.ids.patternPrefix
		)}`,
		surfaceRerollButton: dataAttributeSelector(
			DATA_ATTRIBUTE_NAMES.testId,
			TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_DOM.testIds.rerollButton
		),
		texturedLevelLayer: idSelector(
			resolveTerraformsHypercastleOverviewLayerElementId(HYPERCASTLE_TEXTURE_LEVEL_NUMBER)
		),
		texturedLevelGuide: idSelector(
			resolveTerraformsHypercastleOverviewLevelGuideElementId(HYPERCASTLE_TEXTURE_LEVEL_NUMBER)
		),
		texturedTopFace: `${idSelector(
			resolveTerraformsHypercastleOverviewLayerElementId(HYPERCASTLE_TEXTURE_LEVEL_NUMBER)
		)} ${classSelector(
			resolveTerraformsHypercastleOverviewFaceClassName(
				TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Top
			)
		)}`,
		reachableTopFace: `${idSelector(
			resolveTerraformsHypercastleOverviewLayerElementId(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER)
		)} ${classSelector(
			resolveTerraformsHypercastleOverviewFaceClassName(
				TERRAFORMS_HYPERCASTLE_OVERVIEW_FACE_KINDS.Top
			)
		)}`
	},
	levelZoneTableDom: TERRAFORMS_LEVEL_ZONE_TABLE_DOM,
	ariaAttributes: ARIA_ATTRIBUTE_NAMES,
	ariaAttributeValues: ARIA_ATTRIBUTE_VALUES,
	tableSelectors: TABLE_SELECTORS,
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

		expect(metrics.svg?.levelCount).toBe(String(HYPERCASTLE_EXPECTED_LEVEL_COUNT));
		expect(metrics.layerCount).toBe(HYPERCASTLE_EXPECTED_LEVEL_COUNT);
		expect(metrics.faceCount).toBe(HYPERCASTLE_EXPECTED_FACE_COUNT);
		expect(metrics.verticalFaceCount).toBe(HYPERCASTLE_EXPECTED_VERTICAL_FACE_COUNT);
		expect(metrics.topFaceCount).toBe(HYPERCASTLE_EXPECTED_LEVEL_COUNT);
		expect(metrics.layerOrder).toEqual(
			TERRAFORMS_HYPERCASTLE_LEVELS.map((level) => String(level.levelNumber))
		);
		expect(metrics.topFillOpacity).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.fillOpaque
		]);
		expect(metrics.topStrokeOpacity).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.fillTransparent
		]);
		expect(metrics.sampleLevelTopFillColor).toEqual([
			resolveTerraformsHypercastleSurfaceTexturePatternFill(HYPERCASTLE_TEXTURE_LEVEL_NUMBER)
		]);
		expect(metrics.sampleLevelSurfaceZoneIndex).not.toBeNull();
		expect(metrics.sampleLevelSurfaceSeed).not.toBeNull();
		expect(metrics.sampleLevelSurfaceBackgroundColor).not.toBeNull();
		expect(metrics.surfacePatternCount).toBe(HYPERCASTLE_EXPECTED_LEVEL_COUNT);
		expect(metrics.surfacePatternCellCount).toBe(
			HYPERCASTLE_EXPECTED_LEVEL_COUNT *
				TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE *
				TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_GRID_SIZE
		);
		expect(metrics.surfaceKey).toContain(String(HYPERCASTLE_TEXTURE_LEVEL_NUMBER));
		expect(metrics.topPointerEvents).toEqual([
			TERRAFORMS_HYPERCASTLE_OVERVIEW_BROWSER_VALUES.pointerEventsAll
		]);
		expect(metrics.level12SurfaceBackgroundColor).not.toBeNull();
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
		expect(metrics.allLevelsGuideCount).toBe(1);
		expect(metrics.allLevelsGuideLabel).toBe(TERRAFORMS_HYPERCASTLE_SELECTION_LABELS.AllLevels);
		expect(browserErrors.consoleErrors).toEqual([]);
		expect(browserErrors.pageErrors).toEqual([]);

		const hoveredClassPattern = new RegExp(
			`\\b${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layerHovered}\\b`
		);
		const guideHoveredClassPattern = new RegExp(
			`\\b${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideHovered}\\b`
		);
		const reachableLevelGuide = page.locator(
			HYPERCASTLE_PROBE_CONTRACT.selectors.reachableLevelGuide
		);
		const allLevelsGuide = page.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.allLevelsGuide);
		const reachableLevelLayer = page.locator(
			idSelector(
				resolveTerraformsHypercastleOverviewLayerElementId(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER)
			)
		);
		const detailPanel = page.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.levelDetail);
		const zoneTable = detailPanel.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.levelZoneTable);

		await expect(detailPanel).toBeEmpty();
		await allLevelsGuide.click();
		await expect(
			detailPanel.getByRole(ACCESSIBLE_ROLES.heading, {
				name: TERRAFORMS_HYPERCASTLE_SELECTION_LABELS.AllLevels
			})
		).toBeVisible();
		await assertZoneTableRows(zoneTable, expectedAllLevelZoneRows());
		const allLevelsRerollButton = page.locator(
			HYPERCASTLE_PROBE_CONTRACT.selectors.surfaceRerollButton
		);
		const surfaceKeyBeforeAllLevelsReroll = await page
			.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.svg)
			.getAttribute(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceKey);
		await expect(allLevelsRerollButton).toHaveAttribute(
			SVG_ATTRIBUTE_NAMES.title,
			TERRAFORMS_HYPERCASTLE_SURFACE_TEXTURE_LABELS.RerollSurfaces
		);
		await expect(allLevelsRerollButton).toBeVisible();
		await allLevelsRerollButton.click();
		await expect(page.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.svg)).not.toHaveAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceKey,
			surfaceKeyBeforeAllLevelsReroll ?? EMPTY_ATTRIBUTE_VALUE
		);
		await expectCanonicalLayerOrder(page);
		await attachPageScreenshot(page, testInfo, TEST_ARTIFACTS.allLevelsScreenshot);

		await reachableLevelGuide.hover();
		await expect(reachableLevelLayer).toHaveClass(hoveredClassPattern);
		await expect(reachableLevelGuide).toHaveClass(guideHoveredClassPattern);
		await expectTopRenderedLayer(page, HYPERCASTLE_REACHABILITY_LEVEL_NUMBER);

		await moveMouseToReachableLayerPoint(
			page,
			HYPERCASTLE_PROBE_CONTRACT.selectors.reachableTopFace,
			HYPERCASTLE_PROBE_CONTRACT.reachabilityLevelNumber
		);
		await expect(reachableLevelGuide).toHaveClass(guideHoveredClassPattern);
		await expectTopRenderedLayer(page, HYPERCASTLE_REACHABILITY_LEVEL_NUMBER);
		await attachPageScreenshot(page, testInfo, TEST_ARTIFACTS.hoverScreenshot);

		await reachableLevelGuide.click();
		await expect(reachableLevelLayer).toHaveClass(
			new RegExp(`\\b${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layerSelected}\\b`)
		);
		await expect(reachableLevelGuide).toHaveClass(
			new RegExp(`\\b${TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideSelected}\\b`)
		);
		await expect(
			detailPanel.getByRole(ACCESSIBLE_ROLES.heading, {
				name: formatTerraformsLevelTitle(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER)
			})
		).toBeVisible();
		await expect(zoneTable).toBeVisible();
		await assertZoneTableRows(zoneTable, expectedDefaultLevelZoneRows());
		await expect(page.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.surfaceRerollButton)).toHaveCount(
			0
		);
		await attachPageScreenshot(page, testInfo, TEST_ARTIFACTS.selectedScreenshot);

		const topographySort = zoneTable.getByRole(ACCESSIBLE_ROLES.button, {
			name: formatTerraformsLevelZoneSortLabel(TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Topography)
		});
		await topographySort.click();
		await assertZoneTableRows(
			zoneTable,
			sortTerraformsLevelZoneRows(
				buildTerraformsLevelZoneRows(HYPERCASTLE_DETAIL_LEVEL),
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Topography,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending
			)
		);
		await zoneTable
			.getByRole(ACCESSIBLE_ROLES.button, {
				name: formatTerraformsLevelZoneSortLabel(TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name)
			})
			.click();
		await assertZoneTableRows(
			zoneTable,
			sortTerraformsLevelZoneRows(
				buildTerraformsLevelZoneRows(HYPERCASTLE_DETAIL_LEVEL),
				TERRAFORMS_LEVEL_ZONE_TABLE_COLUMNS.Name,
				TERRAFORMS_LEVEL_ZONE_SORT_DIRECTIONS.Ascending
			)
		);
		await reachableLevelGuide.click();
		await assertZoneTableRows(zoneTable, expectedDefaultLevelZoneRows());

		const detailMetrics = await collectHypercastleLevelDetailMetrics(page);
		const defaultRows = expectedDefaultLevelZoneRows();
		expect(detailMetrics.selectedLayerAriaPressed).toBe(ARIA_ATTRIBUTE_VALUES.true);
		expect(detailMetrics.selectedGuideAriaPressed).toBe(ARIA_ATTRIBUTE_VALUES.true);
		expect(detailMetrics.selectedLayerClass).toContain(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.layerSelected
		);
		expect(detailMetrics.selectedGuideClass).toContain(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.classes.guideSelected
		);
		expect(detailMetrics.heading).toBe(
			formatTerraformsLevelTitle(HYPERCASTLE_REACHABILITY_LEVEL_NUMBER)
		);
		expect(detailMetrics.rowCount).toBe(defaultRows.length);
		expect(detailMetrics.rowNames).toEqual(defaultRows.map((row) => row.name));
		expect(detailMetrics.rowTopographyValues).toEqual(
			defaultRows.map((row) => formatTerraformsZoneTopographyHeights(row))
		);
		expect(detailMetrics.paletteSwatchCount).toBe(
			defaultRows.reduce((sum, row) => sum + row.palette.length, 0)
		);

		const texturedLevelGuide = page.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.texturedLevelGuide);
		await texturedLevelGuide.click();
		await expectTopRenderedLayer(page, HYPERCASTLE_TEXTURE_LEVEL_NUMBER);
		await expect(
			detailPanel.getByRole(ACCESSIBLE_ROLES.heading, {
				name: formatTerraformsLevelTitle(HYPERCASTLE_TEXTURE_LEVEL_NUMBER)
			})
		).toBeVisible();
		await assertZoneTableRows(
			zoneTable,
			sortTerraformsLevelZoneRows(
				buildTerraformsLevelZoneRows(HYPERCASTLE_TEXTURE_LEVEL),
				defaultTerraformsSelectedLevelZoneSortColumn(),
				defaultTerraformsSelectedLevelZoneSortDirection()
			)
		);
		await expect(page.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.surfaceRerollButton)).toHaveCount(
			0
		);
		const texturedLevelLayer = page.locator(
			HYPERCASTLE_PROBE_CONTRACT.selectors.texturedLevelLayer
		);
		const surfaceKeyBeforePaletteClick = await page
			.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.svg)
			.getAttribute(TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceKey);
		const currentZoneIndex = await texturedLevelLayer.getAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceZoneIndex
		);
		const textureLevelRows = sortTerraformsLevelZoneRows(
			buildTerraformsLevelZoneRows(HYPERCASTLE_TEXTURE_LEVEL),
			defaultTerraformsSelectedLevelZoneSortColumn(),
			defaultTerraformsSelectedLevelZoneSortDirection()
		);
		const targetRowIndex = Math.max(
			textureLevelRows.findIndex((row) => String(row.zoneIndex) !== currentZoneIndex),
			0
		);
		const targetRow = textureLevelRows[targetRowIndex]!;
		await zoneTable
			.locator(TABLE_SELECTORS.bodyRows)
			.nth(targetRowIndex)
			.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.paletteSwatch)
			.first()
			.click();
		await expect(texturedLevelLayer).toHaveAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceZoneIndex,
			String(targetRow.zoneIndex)
		);
		await expect(texturedLevelLayer).toHaveAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceBackgroundColor,
			targetRow.palette[targetRow.palette.length - 1]!
		);
		await expect(page.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.svg)).not.toHaveAttribute(
			TERRAFORMS_HYPERCASTLE_OVERVIEW_DOM.attributes.surfaceKey,
			surfaceKeyBeforePaletteClick ?? EMPTY_ATTRIBUTE_VALUE
		);
		await expect(
			page.locator(HYPERCASTLE_PROBE_CONTRACT.selectors.texturedTopFace)
		).toHaveAttribute(
			SVG_ATTRIBUTE_NAMES.fill,
			resolveTerraformsHypercastleSurfaceTexturePatternFill(HYPERCASTLE_TEXTURE_LEVEL_NUMBER)
		);
		await expect(
			page.locator(
				idSelector(
					resolveTerraformsHypercastleSurfaceTexturePatternId(HYPERCASTLE_TEXTURE_LEVEL_NUMBER)
				)
			)
		).toBeAttached();
		await attachPageScreenshot(page, testInfo, TEST_ARTIFACTS.surfaceScreenshot);
		expect(browserErrors.consoleErrors).toEqual([]);
		expect(browserErrors.pageErrors).toEqual([]);
		await attachProbeResult(testInfo, { metrics, detailMetrics, browserErrors });
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
		detailMetrics: HypercastleLevelDetailMetrics;
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
		const guides = Array.from(document.querySelectorAll(contract.selectors.guide));
		const guideLeaders = Array.from(document.querySelectorAll(contract.selectors.guideLeader));
		const guideLabels = Array.from(document.querySelectorAll(contract.selectors.guideLabel));
		const allLevelsGuide = document.querySelector(contract.selectors.allLevelsGuide);
		const allLevelsGuideLabel = document.querySelector(contract.selectors.allLevelsGuideLabel);
		const surfacePatterns = Array.from(document.querySelectorAll(contract.selectors.surfacePatterns));
		const verticalFaces = faces.filter(
			(face) =>
				face.classList.contains(contract.faceClasses.front) ||
				face.classList.contains(contract.faceClasses.side)
		);
		const topFaces = faces.filter((face) => face.classList.contains(contract.faceClasses.top));
		const levelTwelveLayer = document.querySelector(contract.selectors.reachableLevelLayer);
		const sampleLevelLayer = document.querySelector(contract.selectors.texturedLevelLayer);
		const levelFourteenTopFaces = Array.from(
			document.querySelectorAll(contract.selectors.texturedTopFace)
		);

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
			layerOrder: layers.map(
				(layer) =>
					layer.getAttribute(contract.dom.attributes.levelNumber) ?? contract.emptyAttributeValue
			),
			topFillOpacity: uniqueAttribute(topFaces, contract.svgAttributes.fillOpacity),
			topStrokeOpacity: uniqueAttribute(topFaces, contract.svgAttributes.strokeOpacity),
			sampleLevelTopFillColor: uniqueAttribute(levelFourteenTopFaces, contract.svgAttributes.fill),
			sampleLevelSurfaceZoneIndex:
				sampleLevelLayer?.getAttribute(contract.dom.attributes.surfaceZoneIndex) ?? null,
			sampleLevelSurfaceSeed:
				sampleLevelLayer?.getAttribute(contract.dom.attributes.surfaceSeed) ?? null,
			sampleLevelSurfaceBackgroundColor:
				sampleLevelLayer?.getAttribute(contract.dom.attributes.surfaceBackgroundColor) ?? null,
			surfacePatternCount: surfacePatterns.length,
			surfacePatternCellCount: surfacePatterns.reduce(
				(sum, pattern) => sum + pattern.querySelectorAll(contract.svgTags.rect).length,
				0
			),
			surfaceKey: svg?.getAttribute(contract.dom.attributes.surfaceKey) ?? null,
			topPointerEvents: uniqueStyle(topFaces, contract.cssProperties.pointerEvents),
			level12SurfaceBackgroundColor:
				levelTwelveLayer?.getAttribute(contract.dom.attributes.surfaceBackgroundColor) ?? null,
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
			levelGuideLabels: guideLabels.map(
				(label) => label.textContent ?? contract.emptyAttributeValue
			),
			allLevelsGuideCount: allLevelsGuide ? 1 : 0,
			allLevelsGuideLabel: allLevelsGuideLabel?.textContent ?? null,
			level12ReachableTopPoint: findReachableLayerPoint(
				contract.selectors.reachableTopFace,
				contract.reachabilityLevelNumber
			)
		};
	}, HYPERCASTLE_PROBE_CONTRACT);
}

async function collectHypercastleLevelDetailMetrics(
	page: Page
): Promise<HypercastleLevelDetailMetrics> {
	return page.evaluate((contract) => {
		const classSelector = (className: string): string => `.${className}`;
		const selectedLayer = document.querySelector(contract.selectors.reachableLevelLayer);
		const selectedGuide = document.querySelector(contract.selectors.reachableLevelGuide);
		const panel = document.querySelector(contract.selectors.levelDetail);
		const table = panel?.querySelector(contract.selectors.levelZoneTable);
		const heading = panel?.querySelector(
			classSelector(contract.levelZoneTableDom.classes.detailHeading)
		);
		const rows = Array.from(table?.querySelectorAll(contract.tableSelectors.bodyRows) ?? []);
		const rowCells = rows.map((row) =>
			Array.from(row.querySelectorAll(contract.tableSelectors.cells))
		);

		return {
			selectedLayerAriaPressed:
				selectedLayer?.getAttribute(contract.ariaAttributes.pressed) ?? null,
			selectedGuideAriaPressed:
				selectedGuide?.getAttribute(contract.ariaAttributes.pressed) ?? null,
			selectedLayerClass: selectedLayer?.getAttribute(contract.svgAttributes.class) ?? null,
			selectedGuideClass: selectedGuide?.getAttribute(contract.svgAttributes.class) ?? null,
			heading: heading?.textContent ?? null,
			rowCount: rows.length,
			rowNames: rowCells.map((cells) => cells[0]?.textContent ?? contract.emptyAttributeValue),
			rowTopographyValues: rowCells.map(
				(cells) => cells[2]?.textContent?.trim() ?? contract.emptyAttributeValue
			),
			paletteSwatchCount: table?.querySelectorAll(contract.selectors.paletteSwatch).length ?? 0
		};
	}, HYPERCASTLE_PROBE_CONTRACT);
}

async function assertZoneTableRows(
	zoneTable: Locator,
	expectedRows: readonly TerraformsLevelZoneRow[]
): Promise<void> {
	const rows = zoneTable.locator(TABLE_SELECTORS.bodyRows);
	await expect(rows).toHaveCount(expectedRows.length);
	for (const [index, row] of expectedRows.entries()) {
		const cells = rows.nth(index).locator(TABLE_SELECTORS.cells);
		await expect(cells.nth(0)).toHaveText(row.name);
		await expect(
			cells.nth(1).locator(HYPERCASTLE_PROBE_CONTRACT.selectors.paletteSwatch)
		).toHaveCount(row.palette.length);
		if (row.topographyBucketCount === null) {
			await expect(cells).toHaveCount(2);
		} else {
			await expect(cells.nth(2)).toHaveText(formatTerraformsZoneTopographyHeights(row));
			await expect(cells.nth(2)).toHaveAttribute(
				SVG_ATTRIBUTE_NAMES.title,
				formatTerraformsZoneTopographyRangeLabel(row)
			);
		}
	}
}

async function expectCanonicalLayerOrder(page: Page): Promise<void> {
	const order = await collectLayerOrder(page);
	expect(order).toEqual(TERRAFORMS_HYPERCASTLE_LEVELS.map((level) => String(level.levelNumber)));
}

async function expectTopRenderedLayer(page: Page, levelNumber: number): Promise<void> {
	const order = await collectLayerOrder(page);
	expect(order.at(-1)).toBe(String(levelNumber));
}

async function collectLayerOrder(page: Page): Promise<string[]> {
	return page.evaluate((contract) => {
		return Array.from(document.querySelectorAll(contract.selectors.layer)).map(
			(layer) =>
				layer.getAttribute(contract.dom.attributes.levelNumber) ?? contract.emptyAttributeValue
		);
	}, HYPERCASTLE_PROBE_CONTRACT);
}

function expectedAllLevelZoneRows(): TerraformsLevelZoneRow[] {
	return sortTerraformsLevelZoneRows(
		buildTerraformsAllLevelZoneRows(),
		defaultTerraformsLevelZoneSortColumn(),
		defaultTerraformsLevelZoneSortDirection()
	);
}

function expectedDefaultLevelZoneRows(): TerraformsLevelZoneRow[] {
	return sortTerraformsLevelZoneRows(
		buildTerraformsLevelZoneRows(HYPERCASTLE_DETAIL_LEVEL),
		defaultTerraformsSelectedLevelZoneSortColumn(),
		defaultTerraformsSelectedLevelZoneSortDirection()
	);
}

async function moveMouseToReachableLayerPoint(
	page: Page,
	selector: string,
	_levelNumber: string
): Promise<void> {
	await page.locator(selector).hover();
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

function prefixedIdSelector(prefix: string): string {
	return `[id^="${prefix}"]`;
}
