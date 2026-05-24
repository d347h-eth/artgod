import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from 'playwright/test';
import {
	TERRAFORMS_EXTENSION_KEY,
	TERRAFORMS_EXTENSION_PAGE_REFS
} from '@artgod/shared/extensions/terraforms';
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
	verticalFillOpacity: string[];
	topFillOpacity: string[];
	verticalStrokeDashArray: string[];
	topStrokeDashArray: string[];
	verticalPointerEvents: string[];
	topPointerEvents: string[];
	level12ReachableFrontPoint: ReachableLayerPoint | null;
	level12ReachableSidePoint: ReachableLayerPoint | null;
};

const HYPERCASTLE_PATH = `/e2e-harness/collection/extensions/${TERRAFORMS_EXTENSION_KEY}/${TERRAFORMS_EXTENSION_PAGE_REFS.Hypercastle}`;
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

		await page.goto(HYPERCASTLE_PATH, { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');
		await expect(page.getByRole('link', { name: 'terraforms' })).toBeVisible();
		await expect(page.locator('.runtime-tab-active', { hasText: 'hypercastle' })).toBeVisible();

		const overview = page.locator('[data-testid="terraforms-hypercastle-overview"]');
		await expect(overview.locator('svg.terraforms-hypercastle-overview-svg')).toBeVisible();

		const metrics = await collectHypercastleOverviewMetrics(page);
		await attachPageScreenshot(page, testInfo);
		await attachProbeResult(testInfo, { metrics, browserErrors });

		expect(metrics.svg?.levelCount).toBe('20');
		expect(metrics.layerCount).toBe(20);
		expect(metrics.faceCount).toBe(60);
		expect(metrics.verticalFaceCount).toBe(40);
		expect(metrics.topFaceCount).toBe(20);
		expect(metrics.verticalFillOpacity).toEqual(['1']);
		expect(metrics.topFillOpacity).toEqual(['0']);
		expect(metrics.verticalStrokeDashArray).toEqual(['']);
		expect(metrics.topStrokeDashArray).toEqual(['4 3']);
		expect(metrics.verticalPointerEvents).toEqual(['all']);
		expect(metrics.topPointerEvents).toEqual(['visiblestroke']);
		expect(metrics.level12ReachableFrontPoint).not.toBeNull();
		expect(metrics.level12ReachableSidePoint).not.toBeNull();
		expect(browserErrors.consoleErrors).toEqual([]);
		expect(browserErrors.pageErrors).toEqual([]);
	});
});

function captureBrowserErrors(page: Page): { consoleErrors: string[]; pageErrors: string[] } {
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') {
			consoleErrors.push(message.text());
		}
	});
	page.on('pageerror', (error) => {
		pageErrors.push(error.stack || error.message);
	});
	return { consoleErrors, pageErrors };
}

async function attachPageScreenshot(page: Page, testInfo: TestInfo): Promise<void> {
	const screenshotPath = testInfo.outputPath('terraforms-hypercastle-page.png');
	await page.screenshot({ path: screenshotPath, fullPage: true });
	await testInfo.attach('terraforms-hypercastle-page.png', {
		path: screenshotPath,
		contentType: 'image/png'
	});
}

async function attachProbeResult(
	testInfo: TestInfo,
	result: { metrics: HypercastleOverviewMetrics; browserErrors: { consoleErrors: string[]; pageErrors: string[] } }
): Promise<void> {
	const probePath = testInfo.outputPath('terraforms-hypercastle-probe.json');
	await writeFile(probePath, JSON.stringify(result, null, 2));
	await testInfo.attach('terraforms-hypercastle-probe.json', {
		path: probePath,
		contentType: 'application/json'
	});
}

async function collectHypercastleOverviewMetrics(page: Page): Promise<HypercastleOverviewMetrics> {
	return page.evaluate(() => {
		const uniqueAttribute = (items: Element[], name: string): string[] =>
			Array.from(new Set(items.map((item) => item.getAttribute(name) ?? '')));
		const uniqueStyle = (items: Element[], name: string): string[] =>
			Array.from(
				new Set(items.map((item) => getComputedStyle(item).getPropertyValue(name)))
			);
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
					const layer = target?.closest?.('.terraforms-hypercastle-overview-layer');
					if (layer?.getAttribute('data-level-number') === levelNumber) {
						return {
							x,
							y,
							targetClass: target?.getAttribute('class') ?? '',
							layerId: layer.id
						};
					}
				}
			}
			return null;
		};
		const overview = document.querySelector('[data-testid="terraforms-hypercastle-overview"]');
		const svg = overview?.querySelector('svg');
		const layers = Array.from(
			document.querySelectorAll('.terraforms-hypercastle-overview-layer')
		);
		const faces = Array.from(
			document.querySelectorAll('.terraforms-hypercastle-overview-layer-face')
		);
		const verticalFaces = faces.filter(
			(face) =>
				face.classList.contains('terraforms-hypercastle-overview-layer-face-front') ||
				face.classList.contains('terraforms-hypercastle-overview-layer-face-side')
		);
		const topFaces = faces.filter((face) =>
			face.classList.contains('terraforms-hypercastle-overview-layer-face-top')
		);

		return {
			svg: svg
				? {
						width: svg.getAttribute('width'),
						height: svg.getAttribute('height'),
						levelCount: svg.getAttribute('data-level-count')
					}
				: null,
			layerCount: layers.length,
			faceCount: faces.length,
			verticalFaceCount: verticalFaces.length,
			topFaceCount: topFaces.length,
			verticalFillOpacity: uniqueAttribute(verticalFaces, 'fill-opacity'),
			topFillOpacity: uniqueAttribute(topFaces, 'fill-opacity'),
			verticalStrokeDashArray: uniqueAttribute(verticalFaces, 'stroke-dasharray'),
			topStrokeDashArray: uniqueAttribute(topFaces, 'stroke-dasharray'),
			verticalPointerEvents: uniqueStyle(verticalFaces, 'pointer-events'),
			topPointerEvents: uniqueStyle(topFaces, 'pointer-events'),
			level12ReachableFrontPoint: findReachableLayerPoint(
				'#terraforms-hypercastle-level-12 .terraforms-hypercastle-overview-layer-face-front',
				'12'
			),
			level12ReachableSidePoint: findReachableLayerPoint(
				'#terraforms-hypercastle-level-12 .terraforms-hypercastle-overview-layer-face-side',
				'12'
			)
		};
	});
}
