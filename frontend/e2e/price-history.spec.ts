import { test, expect, type Page, type TestInfo } from 'playwright/test';
import {
	PRICE_HISTORY_BUCKET,
	PRICE_HISTORY_RANGE,
	type PriceHistoryBucket
} from '@artgod/shared/types/price-history';
import { COLLECTION_CHART_TOKEN_QUERY } from '../src/lib/price-chart/routing';
import { PRICE_CHART_QUERY, saleActionColor } from '../src/lib/price-chart/model';
import {
	PRICE_HISTORY_E2E,
	priceHistoryFixture,
	priceHistoryPrecisionFixture,
	priceHistoryOutlierFixture,
	priceHistoryZeroFixture,
	priceHistoryBundleFixture
} from './price-history-fixtures';
import { TEST_IDS } from '../src/lib/test-ids';
import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_QUERY_PARAMS,
	COLLECTION_MEDIA_PREFERENCE_VALUES
} from '@artgod/shared/extensions';
import { TERRAFORMS_MEDIA_MODES } from '@artgod/shared/extensions/terraforms';
import { BIDDING_E2E_TOKEN_MEDIA } from '../src/lib/e2e/bidding-automation-fixtures';
import { TRAIT_FILTER_QUERY_PARAMS } from '@artgod/shared/types';
import {
	COLLECTION_API_ROUTE_TEMPLATE,
	PRICE_HISTORY_QUERY
} from '@artgod/shared/http/collection-routes';

const CARD_API = '**' + COLLECTION_API_ROUTE_TEMPLATE.TokenCard.replace(/:[a-z_]+/g, '*') + '?*';
const IMAGE =
	'data:image/svg+xml,' +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#93d1de"/><circle cx="32" cy="32" r="22" fill="#ec7e15"/></svg>'
	);
function cardResponse(url: string) {
	const tokenId = new URL(url).pathname.split('/').at(-2)!;
	return {
		token: {
			tokenId,
			image: IMAGE,
			animationUrl: null,
			name: 'Token ' + tokenId,
			traitSummary: 'Terrain / 7\nCustom template',
			attributes: [],
			marketplaceBiddingSupported: true,
			listingPrice: '1500000000000000000',
			listingCurrency: '0x0000000000000000000000000000000000000000',
			hasMetadata: true,
			metadataUpdatedAt: null
		}
	};
}
test.beforeEach(async ({ page }) => {
	await page.route(PRICE_HISTORY_E2E.apiPattern, async (route) => {
		const query = new URL(route.request().url()).searchParams;
		await route.fulfill({
			json: priceHistoryFixture(
				(query.get(PRICE_HISTORY_QUERY.Bucket) ?? PRICE_HISTORY_BUCKET.Day) as PriceHistoryBucket,
				query.get(PRICE_HISTORY_QUERY.TokenId) ?? undefined
			)
		});
	});
	await page.route(CARD_API, (route) =>
		route.fulfill({ json: cardResponse(route.request().url()) })
	);
});
async function surface(page: Page, info: TestInfo, name: string, fullPage = true) {
	const path = info.outputPath(name + '.png');
	await page.screenshot({ path, fullPage });
	await info.attach(name, { path, contentType: 'image/png' });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
const chart = (page: Page) => page.locator('.realized-price');
const rows = (page: Page) => page.locator('.sale-row[data-sale-id]');

test('bundle dots keep quantity-aware volume, exact averages and both selectable NFT items', async ({
	page
}, info) => {
	await recordCanvasText(page);
	await page.route(PRICE_HISTORY_E2E.apiPattern, (route) =>
		route.fulfill({ json: priceHistoryBundleFixture() })
	);
	await page.goto(PRICE_HISTORY_E2E.path);
	await loaded(page);
	await sharedChrome(page);
	await chartGutters(page);
	const prices = rows(page).filter({ has: page.locator('[title*="bundle average"]') });
	await expect(prices).toHaveCount(2);
	await expect(prices.locator('.sale-amount')).toHaveText(['1.5', '1.5']);
	await expect(prices.locator('.sale-price a').first()).toHaveAttribute(
		'title',
		'1.5 ETH/NFT · bundle average · 6 ETH / 4 NFTs'
	);
	await expect.poll(() => salePoint(page)).not.toBeNull();
	const point = (await salePoint(page))!;
	await page.mouse.move(point.x, point.y);
	await expect.poll(() => dotHighlighted(page, point)).toBe(true);
	await expect(rows(page)).toHaveCount(2);
	await expect(page.locator('.sale-card-preview .token-grid-media')).toBeVisible();
	await page.mouse.click(point.x, point.y);
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'true');
	await page.mouse.move(2, 2);
	await expect(rows(page)).toHaveCount(2);
	await surface(page, info, 'bundle-average-pinned');
	await page.locator('.sale-sidebar').getByRole('button', { name: 'unpin', exact: true }).click();
	await expect(rows(page)).toHaveCount(3);
});
async function loaded(page: Page) {
	await expect(page.locator('[data-chart-ready="true"]')).toBeVisible();
	await expect(page.getByText('loading sales…', { exact: true })).toHaveCount(0);
	await expect(page.locator('.price-canvas canvas').first()).toBeVisible();
}
async function sharedChrome(page: Page) {
	await expect(
		page.getByRole('textbox', { name: 'Jump to token, owner, or ENS name' })
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'keyboard shortcuts', exact: true })).toBeVisible();
	await expect(page.locator('.breadcrumbs-current')).toHaveText('chart');
}

async function chartGutters(page: Page) {
	const geometry = await page.locator('.realized-price').evaluate((element) => {
		const panel = element.closest('.panel')!;
		const header = panel.querySelector('.panel-header')!;
		const headerBox = header.getBoundingClientRect();
		const headerStyle = getComputedStyle(header);
		const toolbar = element.querySelector('.price-toolbar')!.getBoundingClientRect();
		const plot = element.querySelector('.price-canvas')!.getBoundingClientRect();
		const sidebar = element.querySelector('.sale-sidebar')!.getBoundingClientRect();
		return {
			left: headerBox.left + parseFloat(headerStyle.paddingLeft),
			right: headerBox.right - parseFloat(headerStyle.paddingRight),
			toolbar: toolbar.toJSON(),
			plot: plot.toJSON(),
			sidebar: sidebar.toJSON(),
			collapsed: element.parentElement!.classList.contains('sidebar-collapsed')
		};
	});
	expect(geometry.plot.x).toBeCloseTo(geometry.toolbar.x, 0);
	expect(geometry.sidebar.right).toBeCloseTo(geometry.right, 0);
	expect(geometry.plot.x).toBeGreaterThanOrEqual(geometry.left);
	if (geometry.collapsed) expect(geometry.plot.x).toBeCloseTo(geometry.left, 0);
}
async function recordCanvasText(page: Page) {
	await page.addInitScript((key) => {
		const labels = new WeakMap<HTMLCanvasElement, Map<string, number>>();
		(window as unknown as Record<string, unknown>)[key] = labels;
		const fillText = CanvasRenderingContext2D.prototype.fillText;
		const clearRect = CanvasRenderingContext2D.prototype.clearRect;
		CanvasRenderingContext2D.prototype.clearRect = function (...args) {
			labels.delete(this.canvas);
			clearRect.apply(this, args);
		};
		CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
			const values = labels.get(this.canvas) ?? new Map<string, number>();
			// KLineCharts draws ticks with top-baseline text centered on the tick.
			const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 0);
			const point = this.getTransform().transformPoint({ x, y: y + size / 2 });
			values.set(text, (point.y * this.canvas.getBoundingClientRect().height) / this.canvas.height);
			labels.set(this.canvas, values);
			fillText.call(this, text, x, y, maxWidth);
		};
	}, PRICE_HISTORY_E2E.canvasTextKey);
}

async function visiblePriceRange(page: Page) {
	return page.locator('.price-canvas').evaluate((element, key) => {
		const recorded = (window as unknown as Record<string, unknown>)[key] as WeakMap<
			HTMLCanvasElement,
			Map<string, number>
		>;
		for (const canvas of element.querySelectorAll('canvas')) {
			const bounds = canvas.getBoundingClientRect();
			if (bounds.height <= 150 || bounds.width >= 150) continue;
			const ticks = [...(recorded.get(canvas) ?? [])]
				.filter(([text]) => /^-?\d+\.\d+$/.test(text))
				.map(([text, y]) => ({ price: Number(text), y }))
				.sort((a, b) => a.y - b.y);
			if (ticks.length < 2) continue;
			const top = ticks[0],
				bottom = ticks.at(-1)!;
			const perPixel = (top.price - bottom.price) / (bottom.y - top.y);
			return {
				from: bottom.price - (bounds.height - bottom.y) * perPixel,
				span: bounds.height * perPixel
			};
		}
		throw new Error('Price ticks are not rendered');
	}, PRICE_HISTORY_E2E.canvasTextKey);
}
// Inspect the maintained harness's own canvas, never host windows or display APIs.
async function salePoint(page: Page, fromRight = true) {
	return page.locator('.price-canvas').evaluate((element, fromRight) => {
		const sample = document.createElement('canvas');
		sample.width = sample.height = 1;
		const sampleContext = sample.getContext('2d')!;
		sampleContext.fillStyle = getComputedStyle(element).getPropertyValue('--c-cyan');
		sampleContext.fillRect(0, 0, 1, 1);
		const color = sampleContext.getImageData(0, 0, 1, 1).data;
		for (const canvas of element.querySelectorAll('canvas')) {
			const rect = canvas.getBoundingClientRect();
			if (rect.height < 150 || rect.width < 40) continue;
			const context = canvas.getContext('2d');
			if (!context) continue;
			const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
			for (let k = 0; k < canvas.width; k++) {
				const x = fromRight ? canvas.width - 1 - k : k;
				for (let y = Math.round((40 * canvas.height) / rect.height); y < canvas.height - 20; y++) {
					const offset = (y * canvas.width + x) * 4;
					if (
						pixels[offset] === color[0] &&
						pixels[offset + 1] === color[1] &&
						pixels[offset + 2] === color[2] &&
						pixels[offset + 3] === 255
					) {
						const point = {
							x: rect.x + (x * rect.width) / canvas.width,
							y: rect.y + (y * rect.height) / canvas.height
						};
						// Full-size pinned cards can cover dots at narrow widths.
						if (element.contains(document.elementFromPoint(point.x, point.y))) return point;
					}
				}
			}
		}
		return null;
	}, fromRight);
}

async function dotHighlighted(page: Page, point: { x: number; y: number }) {
	return page.locator('.price-canvas').evaluate((element, point) => {
		const sample = document.createElement('canvas').getContext('2d')!;
		sample.fillStyle = getComputedStyle(element).getPropertyValue('--c-orange');
		sample.fillRect(0, 0, 1, 1);
		const orange = sample.getImageData(0, 0, 1, 1).data;
		return [...element.querySelectorAll('canvas')].some((canvas) => {
			const box = canvas.getBoundingClientRect();
			if (box.height < 150 || box.width < 40) return false;
			const x = Math.round(((point.x - box.x) * canvas.width) / box.width);
			const y = Math.round(((point.y - box.y) * canvas.height) / box.height);
			if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
			const pixel = canvas.getContext('2d')!.getImageData(x, y, 1, 1).data;
			return orange.every((channel, i) => pixel[i] === channel);
		});
	}, point);
}

async function pricePaneBounds(page: Page) {
	return page.locator('.price-canvas').evaluate((element) => {
		const panes = [...element.querySelectorAll('canvas')]
			.map((canvas) => canvas.getBoundingClientRect())
			.filter((box) => box.height > 150);
		const main = panes.reduce((largest, box) => (box.width > largest.width ? box : largest));
		const axis = panes.find((box) => box.x >= main.right && box.height === main.height)!;
		return { main: main.toJSON(), axis: axis.toJSON() };
	});
}

async function zoomPriceIn(page: Page) {
	const { axis } = await pricePaneBounds(page);
	const x = axis.x + axis.width / 2;
	const startY = axis.y + axis.height - 16;
	await page.mouse.move(x, startY);
	await page.mouse.down();
	await page.mouse.move(x, Math.max(axis.y + 25, startY / 2), { steps: 8 });
	await page.mouse.up();
	await page.mouse.move(2, 2);
}

test('dedicated dots page follows Transfers in Asset Events and fills the viewport with indicator controls hidden', async ({
	page
}, info) => {
	if (info.project.name.includes('768')) await page.setViewportSize({ width: 1920, height: 1080 });
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto('/e2e-harness/collection');
	await expect(chart(page)).toHaveCount(0);
	const gridMediaHeight = await page
		.getByTestId(TEST_IDS.TokenCard)
		.first()
		.locator('.token-grid-media')
		.evaluate((el) => el.getBoundingClientRect().height);
	expect(gridMediaHeight).toBe(400);
	const explore = page.locator('.runtime-tab-group').first().locator('.runtime-tab-group-items');
	await expect(explore.locator('a, .runtime-tab-active')).toHaveText(['asks', 'offers', 'tokens']);
	const assetEvents = page.locator('.runtime-tab-group').nth(1);
	await expect(assetEvents.locator('.runtime-tab-group-label')).toHaveText('asset events');
	await expect(assetEvents.locator('a, .runtime-tab-active')).toHaveText([
		'sales',
		'listings',
		'transfers',
		'chart'
	]);
	await assetEvents.getByRole('link', { name: 'chart', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(PRICE_HISTORY_E2E.path + '(\\?|$)'));
	await loaded(page);
	await expect(chart(page).getByRole('heading')).toHaveCount(0);
	await sharedChrome(page);
	await chartGutters(page);
	await expect(chart(page).locator('.sale-legend')).toHaveCount(0);
	await expect(page.locator('.runtime-tab-active').filter({ hasText: /^chart$/ })).toBeVisible();
	await expect(chart(page).getByRole('button', { name: /^(dots|line|candles)$/ })).toHaveCount(0);
	const bounds = (await chart(page).boundingBox())!;
	expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
	expect(bounds.height).toBeGreaterThan(page.viewportSize()!.height * 0.55);
	if (page.viewportSize()!.width > 1500) {
		const canvas = (await page.locator('.price-canvas').boundingBox())!;
		const workspace = (await page.locator('.price-workspace').boundingBox())!;
		expect(canvas.width / workspace.width).toBeGreaterThan(0.88);
		expect(canvas.width / workspace.width).toBeLessThan(0.91);
	}
	await surface(page, info, 'chart-page');
	await expect(chart(page).getByRole('button', { name: 'indicators', exact: true })).toHaveCount(0);
	await expect(chart(page).locator('.price-indicators')).toHaveCount(0);
	const canvas = page.locator('.price-canvas');
	const box = (await canvas.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + 50);
	const before = await canvas.screenshot();
	await page.mouse.wheel(0, -300);
	await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(false);
	const zoomed = await canvas.screenshot();
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 - 55, box.y + 50, { steps: 8 });
	await page.mouse.up();
	await expect.poll(async () => (await canvas.screenshot()).equals(zoomed)).toBe(false);
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'false');
	await chart(page).getByRole('button', { name: 'fit', exact: true }).click();
	await surface(page, info, 'chart-fit');
	await page
		.getByRole('combobox', { name: 'History range' })
		.selectOption(PRICE_HISTORY_RANGE.Year);
	await page
		.getByRole('combobox', { name: 'Time bucket' })
		.selectOption(PRICE_HISTORY_BUCKET.FourHours);
	await expect(page).toHaveURL(new RegExp(PRICE_CHART_QUERY.Bucket + '=4h'));
	await loaded(page);
	expect(errors).toEqual([]);
});

test('shared header actions preserve media state and help owns shortcuts before chart controls', async ({
	page
}, info) => {
	if (info.project.name.includes('768')) await page.setViewportSize({ width: 1920, height: 1080 });
	const query = new URLSearchParams({
		[COLLECTION_MEDIA_QUERY_PARAMS.MediaMode]: TERRAFORMS_MEDIA_MODES.Live,
		[COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference]: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled,
		[TRAIT_FILTER_QUERY_PARAMS.Traits]: 'Zone:Tetsu'
	});
	await page.goto(PRICE_HISTORY_E2E.path + '?' + query);
	await loaded(page);
	await sharedChrome(page);
	await chartGutters(page);
	const currentUrl = page.url();
	const tokensHref = (await page
		.getByRole('link', { name: 'tokens', exact: true })
		.getAttribute('href'))!;
	await page.getByRole('button', { name: 'keyboard shortcuts', exact: true }).click();
	const help = page.getByRole('dialog', { name: 'ABOUT', exact: true });
	await expect(help).toBeVisible();
	await page.keyboard.press('f');
	await expect(page.locator('.facet-panel')).toHaveCount(0);
	await page.keyboard.press('r');
	await expect(page.getByRole('button', { name: 'remove Zone=Tetsu', exact: true })).toBeVisible();
	await page.keyboard.press('3');
	await expect(page).toHaveURL(currentUrl);
	await surface(page, info, 'chart-shared-help', false);
	await page.keyboard.press('F1');
	await expect(help).toHaveCount(0);
	await page.keyboard.press('F1');
	await expect(help).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(help).toHaveCount(0);
	const jump = page.getByRole('textbox', { name: 'Jump to token, owner, or ENS name' });
	await jump.fill('10');
	await jump.press('3');
	await expect(jump).toHaveValue('103');
	await expect(page).toHaveURL(currentUrl);
	await jump.press('Enter');
	await expect(page).toHaveURL(new RegExp('/103\\?'));
	expect(new URL(page.url()).searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
		TERRAFORMS_MEDIA_MODES.Live
	);
	expect(new URL(page.url()).searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference)).toBe(
		COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
	);
	await page.goBack();
	await loaded(page);
	await page.locator('.breadcrumbs-current').click();
	await page.keyboard.press('3');
	await expect(page).toHaveURL(new URL(tokensHref, currentUrl).href);
});

test('chart links and fullscreen preview reuse media preferences and modal shortcuts', async ({
	page
}, info) => {
	if (info.project.name.includes('768')) await page.setViewportSize({ width: 1440, height: 1024 });
	const mediaQuery = new URLSearchParams({
		[COLLECTION_MEDIA_QUERY_PARAMS.MediaMode]: TERRAFORMS_MEDIA_MODES.Live,
		[COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference]: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
	});
	const cardRequests: URLSearchParams[] = [];
	await page.route(CARD_API, (route) => {
		cardRequests.push(new URL(route.request().url()).searchParams);
		return route.fulfill({ json: cardResponse(route.request().url()) });
	});
	const previewRequests: URLSearchParams[] = [];
	await page.route('**/api/*/*/*/preview?*', (route) => {
		const url = new URL(route.request().url());
		previewRequests.push(url.searchParams);
		return route.fulfill({
			json: {
				media: {
					...BIDDING_E2E_TOKEN_MEDIA,
					selectedMode: TERRAFORMS_MEDIA_MODES.Live,
					preference: { ...BIDDING_E2E_TOKEN_MEDIA.preference!, enabled: false }
				},
				token: { tokenId: url.pathname.split('/').at(-2)!, image: IMAGE, animationUrl: null }
			}
		});
	});
	await page.goto(PRICE_HISTORY_E2E.path + '?' + mediaQuery);
	await loaded(page);
	await expect.poll(() => salePoint(page)).not.toBeNull();
	const point = (await salePoint(page))!;
	await page.mouse.click(point.x, point.y);
	const card = page.locator('.sale-card-preview.pinned');
	await expect(card.getByTestId(TEST_IDS.TokenCard)).toBeVisible();
	for (const link of [
		card.locator('.token-grid-id'),
		rows(page).first().locator('.sale-thumbnail'),
		rows(page).first().locator('.sale-seller'),
		rows(page).first().locator('.sale-buyer')
	]) {
		const url = new URL((await link.getAttribute('href'))!, page.url());
		for (const [key, value] of mediaQuery) expect(url.searchParams.get(key)).toBe(value);
	}
	expect(cardRequests.length).toBeGreaterThan(0);
	expect(
		cardRequests.every(
			(query) =>
				query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode) === COLLECTION_MEDIA_MODES.Snapshot
		)
	).toBe(true);
	await card.getByRole('button', { name: /^preview token / }).click();
	const preview = page.getByRole('dialog', { name: 'Token Preview', exact: true });
	await expect(preview.locator('iframe')).toBeVisible();
	for (const [key, value] of mediaQuery) expect(previewRequests.at(-1)!.get(key)).toBe(value);
	const before = (await preview.locator('.token-preview-box').boundingBox())!;
	await page.keyboard.press('-');
	await expect
		.poll(async () => (await preview.locator('.token-preview-box').boundingBox())!.width)
		.toBeLessThan(before.width);
	const currentUrl = page.url();
	await page.keyboard.press('f');
	await page.keyboard.press('3');
	await expect(page.locator('.facet-panel')).toHaveCount(0);
	await expect(page).toHaveURL(currentUrl);
	await surface(page, info, 'chart-fullscreen-preview', false);
	await page.keyboard.press('Escape');
	await expect(preview).toHaveCount(0);
	await expect(card).toBeVisible();
});

test('dot hover is ephemeral, click pins overlapping sales, and row previews and links preserve identities', async ({
	page
}, info) => {
	if (info.project.name.includes('768')) await page.setViewportSize({ width: 1920, height: 1080 });
	await page.goto(PRICE_HISTORY_E2E.path);
	await loaded(page);
	const preciseRow = page.locator('.sale-row[data-sale-id="199-0"]');
	await expect(preciseRow.locator('.sale-amount')).toHaveText('1.373');
	await expect(preciseRow.locator('.sale-price a')).toHaveAttribute('title', '1.37256 ETH');
	await expect.poll(() => salePoint(page)).not.toBeNull();
	const point = (await salePoint(page))!;
	await page.mouse.move(point.x, point.y);
	await expect.poll(() => dotHighlighted(page, point)).toBe(true);
	await expect(page.getByRole('tooltip')).toBeVisible();
	await page.mouse.move(2, 2);
	await expect.poll(() => dotHighlighted(page, point)).toBe(false);
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	await page.mouse.move(point.x, point.y);
	await expect.poll(() => dotHighlighted(page, point)).toBe(true);
	const floatingCard = page.locator('.sale-card-preview');
	await expect(floatingCard.getByTestId(TEST_IDS.TokenCard)).toBeVisible();
	await expect(floatingCard.locator('.token-grid-traits')).toHaveText(
		'Terrain / 7\nCustom template'
	);
	expect(
		await floatingCard
			.locator('.token-grid-media')
			.evaluate((el) => el.getBoundingClientRect().height)
	).toBe(400);
	expect(await floatingCard.evaluate((el) => getComputedStyle(el).borderWidth)).toBe('0px');
	await expect(floatingCard.locator('iframe')).toHaveCount(0);
	for (const sale of priceHistoryFixture().sales.slice(-3)) {
		const row = rows(page).filter({
			has: page.getByRole('link', { name: 'Token #' + sale.tokenId, exact: true })
		});
		await expect(row.locator('.sale-price a')).toHaveAttribute(
			'title',
			'1.452 ' + sale.currencySymbol
		);
		await expect(row.locator('.sale-price small')).toHaveText(sale.currencySymbol[0]);
		const color = await row.evaluate((element, name) => {
			const sample = document.createElement('canvas').getContext('2d')!;
			sample.fillStyle = getComputedStyle(element).getPropertyValue('--c-' + name);
			sample.fillRect(0, 0, 1, 1);
			const [r, g, b] = sample.getImageData(0, 0, 1, 1).data;
			return `rgb(${r}, ${g}, ${b})`;
		}, saleActionColor(sale.action));
		await expect(row.locator('.sale-price a')).toHaveCSS('color', color);
	}
	const amountEdges = await page
		.locator('.sale-amount')
		.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().right));
	expect(Math.max(...amountEdges) - Math.min(...amountEdges)).toBeLessThan(1);
	// Keep the hover-to-click gesture uninterrupted by screenshot capture, and
	// hold pointer-down long enough to expose a transient unmount/loading state.
	const cardNode = await floatingCard.elementHandle();
	const mediaNode = await floatingCard.locator('.token-grid-media img').elementHandle();
	const hoverPosition = await floatingCard.boundingBox();
	await page.mouse.down();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	expect(await cardNode!.evaluate((el) => el.isConnected)).toBe(true);
	expect(await mediaNode!.evaluate((el) => el.isConnected)).toBe(true);
	await expect(floatingCard.locator('.sale-card-pending')).toHaveCount(0);
	await page.mouse.up();
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'true');
	await expect(floatingCard).toHaveAttribute('role', 'region');
	expect(await cardNode!.evaluate((el) => el.isConnected)).toBe(true);
	expect(await mediaNode!.evaluate((el) => el.isConnected)).toBe(true);
	const pinnedPosition = await floatingCard.boundingBox();
	expect(pinnedPosition).toEqual(hoverPosition);
	const pinnedIds = await rows(page).evaluateAll((items) =>
		items.map((el) => el.getAttribute('data-sale-id'))
	);
	await page.mouse.move(2, 2);
	await expect.poll(() => dotHighlighted(page, point)).toBe(true);
	await expect(floatingCard).toBeVisible();
	expect(
		await rows(page).evaluateAll((items) => items.map((el) => el.getAttribute('data-sale-id')))
	).toEqual(pinnedIds);
	const other = (await salePoint(page, false))!;
	await page.mouse.move(other.x, other.y);
	await expect.poll(() => dotHighlighted(page, other)).toBe(true);
	await expect.poll(() => dotHighlighted(page, point)).toBe(true);
	await expect(floatingCard.getByTestId(TEST_IDS.TokenCard)).toHaveAttribute(
		'data-token-id',
		'103'
	);
	expect(await floatingCard.boundingBox()).toEqual(pinnedPosition);
	expect(
		await rows(page).evaluateAll((items) => items.map((el) => el.getAttribute('data-sale-id')))
	).toEqual(pinnedIds);
	await page.mouse.move(2, 2);
	await expect.poll(() => dotHighlighted(page, other)).toBe(false);
	await expect.poll(() => dotHighlighted(page, point)).toBe(true);
	const row = rows(page).first();
	await expect(row.locator('.sale-time')).toHaveAttribute('title', /^\d{4}-\d{2}-\d{2}T/);
	await expect(row.locator('.sale-time')).toHaveText(/^\d+(s|m|h|d|mo|y)$/);
	const tx = await row.locator('.sale-time').getAttribute('href');
	await expect(row.locator('.sale-price a')).toHaveAttribute('href', tx!);
	await expect(row.locator('.sale-seller')).toHaveAttribute('href', /\/holders\/0x2929/);
	await expect(row.locator('.sale-buyer')).toHaveAttribute('href', /\/holders\/0xabab/);
	const thumb = row.locator('.sale-thumbnail');
	await expect(thumb.locator('img')).toBeVisible();
	expect((await thumb.boundingBox())!.width).toBe(16);
	expect(await thumb.evaluate((el) => getComputedStyle(el).borderWidth)).toBe('0px');
	expect(
		await row
			.locator(':scope > span')
			.evaluateAll((els) => els.every((el) => getComputedStyle(el).textAlign === 'right'))
	).toBe(true);
	const layout = await row.evaluate((element) => {
		const price = element.querySelector('.sale-price a')!.getBoundingClientRect();
		const seller = element.querySelector('.sale-seller')!.getBoundingClientRect();
		const time = element.querySelector('.sale-time')!.getBoundingClientRect();
		const thumbnail = element.querySelector('.sale-thumbnail')!.getBoundingClientRect();
		const row = element.getBoundingClientRect();
		return {
			timeNftGap: thumbnail.left - time.right,
			nftPriceGap: price.left - thumbnail.right,
			priceSellerGap: seller.left - price.right,
			centerOffsets: [...element.children].map((cell) => {
				const content = cell.firstElementChild!.getBoundingClientRect();
				return Math.abs(content.y + content.height / 2 - (row.y + row.height / 2));
			}),
			priceClipped: [...element.querySelectorAll('.sale-amount, .sale-price small')].some(
				(el) => el.scrollWidth > el.clientWidth
			)
		};
	});
	expect(layout.priceSellerGap).toBeGreaterThanOrEqual(14);
	expect(Math.abs(layout.timeNftGap - layout.nftPriceGap)).toBeLessThan(1);
	expect(Math.max(...layout.centerOffsets)).toBeLessThanOrEqual(1);
	expect(layout.priceClipped).toBe(false);
	// Sidebar hover is independent of the chart pin and cannot replace or move it.
	const pinnedCard = page.getByRole('region', { name: 'Token 103 card', exact: true });
	const rowThumb = page.getByRole('link', { name: 'Token #99', exact: true });
	// At phone width the intentionally full-size pinned card covers this icon.
	// Exercise keyboard access there; desktop covers real pointer hover and click.
	const coveredByCard = info.project.name.includes('480');
	if (coveredByCard) await rowThumb.focus();
	else await rowThumb.hover();
	const rowCard = page.getByRole('tooltip', { name: 'Token 99 card', exact: true });
	await expect(rowCard.getByTestId(TEST_IDS.TokenCard)).toBeVisible();
	await expect(rowCard.getByTestId(TEST_IDS.TokenCard)).toHaveAttribute('data-token-id', '99');
	await expect(floatingCard).toHaveCount(2);
	expect(await pinnedCard.boundingBox()).toEqual(pinnedPosition);
	expect(
		await rows(page).evaluateAll((items) => items.map((el) => el.getAttribute('data-sale-id')))
	).toEqual(pinnedIds);
	await surface(page, info, 'pinned-card-with-sidebar-preview');
	if (coveredByCard) await rowThumb.press('Tab');
	await page.mouse.move(2, 2);
	await expect(rowCard).toHaveCount(0);
	await expect(pinnedCard).toBeVisible();
	const market = floatingCard.locator('.token-price-link');
	await expect(market).toHaveAttribute('href', /opensea.io\/item\/ethereum\/.+\/103$/);
	await expect(market).toHaveAttribute('target', '_blank');
	await market.hover();
	await surface(page, info, 'pinned-card');
	await page
		.context()
		.route('https://opensea.io/**', (route) => route.fulfill({ body: 'Marketplace fixture' }));
	const opened = page.waitForEvent('popup');
	await market.click();
	const marketPage = await opened;
	await expect(marketPage).toHaveURL(/opensea.io\/item\/ethereum\/.+\/103$/);
	await marketPage.close();
	// Empty chart space dismisses both the pinned group and its interactive card.
	const canvasBox = (await page.locator('.price-canvas').boundingBox())!;
	await page.mouse.click(canvasBox.x + 8, canvasBox.y + canvasBox.height - 8);
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'false');
	await expect(floatingCard).toHaveCount(0);
	await expect(rows(page)).toHaveCount(50);
	await thumb.hover();
	await expect(floatingCard.getByTestId(TEST_IDS.TokenCard)).toBeVisible();
	await surface(page, info, 'row-card-preview');
	await page.mouse.move(2, 2);
	await expect(floatingCard).toHaveCount(0);
	expect(new URL((await thumb.getAttribute('href'))!, page.url()).pathname).toMatch(/\/\d+$/);
	// Native thumbnail navigation also works while another token's card is pinned.
	// Re-read the canvas after full-page screenshots have resized it.
	const repin = (await salePoint(page))!;
	await page.mouse.click(repin.x, repin.y);
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'true');
	const tokenHref = await rowThumb.getAttribute('href');
	if (coveredByCard) await rowThumb.focus();
	else await rowThumb.hover();
	await expect(rowCard).toBeVisible();
	if (coveredByCard) await rowThumb.press('Enter');
	else await rowThumb.click();
	await expect(page).toHaveURL(new URL(tokenHref!, page.url()).href);
});

test('price labels use four decimals while close sale prices retain distinct positions and side colors', async ({
	page
}, info) => {
	await page.setViewportSize({ width: 1280, height: 1024 });
	await recordCanvasText(page);
	await page.route(PRICE_HISTORY_E2E.apiPattern, (route) =>
		route.fulfill({ json: priceHistoryPrecisionFixture() })
	);
	await page.goto(PRICE_HISTORY_E2E.path);
	await loaded(page);
	await expect.poll(() => salePoint(page)).not.toBeNull();
	const labels = await page.locator('.price-canvas').evaluate((element, key) => {
		const recorded = (window as unknown as Record<string, unknown>)[key] as WeakMap<
			HTMLCanvasElement,
			Map<string, number>
		>;
		return [...element.querySelectorAll('canvas')].flatMap((canvas) => {
			const bounds = canvas.getBoundingClientRect();
			return bounds.height > 150 && bounds.width < 150
				? [...(recorded.get(canvas)?.keys() ?? [])].filter((text) => /^\d+\.\d+$/.test(text))
				: [];
		});
	}, PRICE_HISTORY_E2E.canvasTextKey);
	expect(labels.length).toBeGreaterThan(0);
	expect(labels.every((text) => /^\d+\.\d{4}$/.test(text))).toBe(true);
	const positions = await page.locator('.price-canvas').evaluate((element) => {
		const css = getComputedStyle(element);
		const sample = document.createElement('canvas').getContext('2d')!;
		const colors = ['cyan', 'pink', 'sand'].map((name) => {
			sample.fillStyle = css.getPropertyValue('--c-' + name);
			sample.fillRect(0, 0, 1, 1);
			return [...sample.getImageData(0, 0, 1, 1).data];
		});
		const rows: number[][] = colors.map(() => []);
		for (const canvas of element.querySelectorAll('canvas')) {
			const box = canvas.getBoundingClientRect();
			if (box.width < 150 || box.height < 150) continue;
			const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
			for (let i = 0; i < pixels.length; i += 4) {
				const color = colors.findIndex((rgba) =>
					rgba.every((value, channel) => pixels[i + channel] === value)
				);
				if (color >= 0)
					rows[color].push(box.y + (Math.floor(i / 4 / canvas.width) * box.height) / canvas.height);
			}
		}
		return rows.map((values) => ({
			count: values.length,
			y: values.reduce((a, b) => a + b, 0) / values.length
		}));
	});
	expect(positions.every((point) => point.count > 0)).toBe(true);
	// The prices differ by one millionth of ETH, well below displayed precision.
	expect(Math.abs(positions[0].y - positions[1].y)).toBeGreaterThan(50);
	expect(Math.abs(positions[0].y - positions[2].y)).toBeLessThan(2);
	await surface(page, info, 'precise-sale-types');
});

test('price-axis wheel zoom stays inverted and native panning continues through zero', async ({
	page
}, info) => {
	await recordCanvasText(page);
	await page.route(PRICE_HISTORY_E2E.apiPattern, (route) =>
		route.fulfill({ json: priceHistoryZeroFixture() })
	);
	await page.goto(PRICE_HISTORY_E2E.path);
	await loaded(page);
	await expect.poll(() => salePoint(page)).not.toBeNull();
	const automatic = await visiblePriceRange(page);
	// The native axis keeps padding below a zero-priced sale.
	expect(automatic.from).toBeLessThan(-0.1);
	const { axis } = await pricePaneBounds(page);
	await page.mouse.move(axis.x + axis.width / 2, axis.y + axis.height / 2);
	await page.mouse.wheel(0, -100);
	await expect
		.poll(async () => (await visiblePriceRange(page)).span)
		.toBeLessThan(automatic.span * 0.98);
	const contracted = await visiblePriceRange(page);
	await page.mouse.wheel(0, 100);
	await expect
		.poll(async () => (await visiblePriceRange(page)).span)
		.toBeGreaterThan(contracted.span * 1.02);
	for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 100);
	await expect
		.poll(async () => (await visiblePriceRange(page)).span)
		.toBeGreaterThan(automatic.span * 1.5);
	const expanded = await visiblePriceRange(page);
	expect(expanded.from).toBeLessThan(automatic.from);
	// Pan both ways through zero without changing the zoom or hitting a floor.
	const { main } = await pricePaneBounds(page);
	const x = main.x + main.width / 2;
	await page.mouse.move(x, main.y + main.height * 0.2);
	await page.mouse.down();
	await page.mouse.move(x, main.y + main.height * 0.5, { steps: 8 });
	await page.mouse.up();
	await expect
		.poll(async () => (await visiblePriceRange(page)).from)
		.toBeGreaterThan(expanded.from + expanded.span * 0.2);
	await page.mouse.move(x, main.y + main.height * 0.8);
	await page.mouse.down();
	await page.mouse.move(x, main.y + main.height * 0.2, { steps: 8 });
	await page.mouse.up();
	await page.mouse.move(2, 2);
	const panned = await visiblePriceRange(page);
	expect(panned.from).toBeLessThan(expanded.from - expanded.span * 0.2);
	expect(Math.abs(panned.span - expanded.span)).toBeLessThan(expanded.span * 0.005);
	await surface(page, info, 'unrestricted-price-axis', false);
	await page.mouse.dblclick(axis.x + axis.width / 2, axis.y + axis.height / 2);
	await expect
		.poll(async () => Math.abs((await visiblePriceRange(page)).span - automatic.span))
		.toBeLessThan(automatic.span * 0.005);
});

test('one small arrow reveals higher sales using the same scale reset as the price axis', async ({
	page
}, info) => {
	const desktop = info.project.name.includes('768');
	if (desktop) await page.setViewportSize({ width: 1920, height: 1080 });
	let historyRequests = 0;
	await page.route(PRICE_HISTORY_E2E.apiPattern, (route) => {
		historyRequests++;
		return route.fulfill({ json: priceHistoryOutlierFixture() });
	});
	await page.goto(PRICE_HISTORY_E2E.path);
	await loaded(page);
	await expect.poll(() => salePoint(page)).not.toBeNull();
	const arrow = page.getByRole('button', { name: 'Show higher sales', exact: true });
	await expect(arrow).toHaveCount(0);
	await zoomPriceIn(page);
	await expect(arrow).toBeVisible();
	await expect(arrow).toHaveCount(1);
	const arrowBox = (await arrow.boundingBox())!;
	const { main } = await pricePaneBounds(page);
	expect(arrowBox.width).toBeLessThanOrEqual(20);
	expect(arrowBox.height).toBeLessThanOrEqual(20);
	expect((await arrow.locator('svg').boundingBox())!.width).toBe(12);
	expect(Math.abs(arrowBox.x + arrowBox.width / 2 - (main.x + main.width / 2))).toBeLessThan(1);
	expect(arrowBox.y - main.y).toBeLessThanOrEqual(4);
	// Full-page capture temporarily resizes the responsive canvas and can move
	// the outlier outside a narrow time window before the reversible pan below.
	await surface(page, info, 'sales-above-arrow', false);
	// A sale outside the time window must not keep the vertical hint visible.
	const pan = async (direction: number) => {
		const { main } = await pricePaneBounds(page);
		const distance = Math.min(100, main.width * 0.6);
		const left = main.x + main.width * 0.2;
		const y = main.y + main.height / 2;
		const start = direction > 0 ? left : left + distance;
		await page.mouse.move(start, y);
		await page.mouse.down();
		await page.mouse.move(start + direction * distance, y, { steps: 8 });
		await page.mouse.up();
		await page.mouse.move(2, 2);
	};
	await pan(1);
	await expect(arrow).toHaveCount(0);
	await pan(-1);
	await expect(arrow).toBeVisible();
	const { axis } = await pricePaneBounds(page);
	await page.mouse.dblclick(axis.x + axis.width / 2, axis.y + axis.height / 2);
	await page.mouse.move(2, 2);
	await expect(arrow).toHaveCount(0);
	const canvas = page.locator('.price-canvas');
	const nativeReset = await canvas.screenshot();
	await zoomPriceIn(page);
	await expect(arrow).toBeVisible();
	await arrow.click();
	await page.mouse.move(2, 2);
	await expect(arrow).toHaveCount(0);
	// Comparing the whole chart checks price scale, time zoom/scroll, and the
	// independent Volume pane against the native double-click result.
	await expect.poll(async () => (await canvas.screenshot()).equals(nativeReset)).toBe(true);
	await surface(page, info, 'sales-above-reset', false);
	// Keyboard activation also works; resetting the scale keeps a desktop pin.
	let pinnedIds: Array<string | null> = [];
	if (desktop) {
		const point = (await salePoint(page))!;
		await page.mouse.click(point.x, point.y);
		await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'true');
		pinnedIds = await rows(page).evaluateAll((items) =>
			items.map((el) => el.getAttribute('data-sale-id'))
		);
	}
	await zoomPriceIn(page);
	await expect(arrow).toBeVisible();
	await arrow.focus();
	await arrow.press('Enter');
	await expect(arrow).toHaveCount(0);
	if (desktop) {
		await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'true');
		expect(
			await rows(page).evaluateAll((items) => items.map((el) => el.getAttribute('data-sale-id')))
		).toEqual(pinnedIds);
		await expect(page.locator('.sale-card-preview')).toBeVisible();
	}
	expect(historyRequests).toBe(1);
});

test('the pinned grid card keeps token navigation usable', async ({ page }) => {
	await page.goto(PRICE_HISTORY_E2E.path);
	await loaded(page);
	await expect.poll(() => salePoint(page)).not.toBeNull();
	const point = (await salePoint(page))!;
	await page.mouse.click(point.x, point.y);
	const link = page.locator('.sale-card-preview .token-grid-id');
	await expect(link).toBeVisible();
	const href = await link.getAttribute('href');
	await page.mouse.move(2, 2);
	await link.click();
	await expect(page).toHaveURL(new URL(href!, page.url()).href);
});

test('slow and failed media cannot leave a stale popup after pointer exit', async ({
	page
}, info) => {
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => (release = resolve));
	await page.route(CARD_API, async (route) => {
		await barrier;
		await route.fulfill({ status: 404, json: { message: 'No preview' } });
	});
	await page.goto(PRICE_HISTORY_E2E.path);
	await loaded(page);
	await expect.poll(() => salePoint(page)).not.toBeNull();
	const point = (await salePoint(page))!;
	await page.mouse.move(point.x, point.y);
	await expect(page.getByRole('tooltip').getByText('loading…')).toBeVisible();
	await surface(page, info, 'preview-loading');
	await page.mouse.move(2, 2);
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	release();
	await page.mouse.move(point.x, point.y);
	await expect(page.getByRole('tooltip').getByText('hover again to retry')).toBeVisible();
	await surface(page, info, 'preview-error');
	await page.mouse.click(point.x, point.y);
	await page.mouse.move(2, 2);
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	const pinned = page.locator('.sale-card-preview');
	await expect(pinned.getByRole('button', { name: 'retry', exact: true })).toBeVisible();
	await surface(page, info, 'pinned-card-error');
	await page.route(CARD_API, (route) =>
		route.fulfill({ json: cardResponse(route.request().url()) })
	);
	await pinned.getByRole('button', { name: 'retry', exact: true }).click();
	await expect(pinned.getByTestId(TEST_IDS.TokenCard)).toBeVisible();
});

test('loading, empty, failure and retry preserve the chart page controls', async ({
	page
}, info) => {
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => (release = resolve));
	await page.route(PRICE_HISTORY_E2E.apiPattern, async (route) => {
		await barrier;
		await route.fulfill({ json: { ...priceHistoryFixture(), sales: [], buckets: [] } });
	});
	await page.goto(PRICE_HISTORY_E2E.path);
	await expect(page.getByText('loading sales…', { exact: true })).toBeVisible();
	await sharedChrome(page);
	await surface(page, info, 'chart-loading');
	release();
	await expect(page.getByText('no sale prices', { exact: true })).toBeVisible();
	await sharedChrome(page);
	await surface(page, info, 'chart-empty');
	await page.route(PRICE_HISTORY_E2E.apiPattern, (route) =>
		route.fulfill({ status: 400, json: { message: 'Choose a shorter price history range.' } })
	);
	await chart(page).getByRole('button', { name: 'refresh', exact: true }).click();
	await expect(chart(page).getByRole('alert')).toContainText(
		'Choose a shorter price history range.'
	);
	await sharedChrome(page);
	await surface(page, info, 'chart-error');
	await page.route(PRICE_HISTORY_E2E.apiPattern, (route) =>
		route.fulfill({ json: priceHistoryFixture() })
	);
	await chart(page).getByRole('button', { name: 'retry', exact: true }).click();
	await loaded(page);
});

test('token history uses the dedicated page and bucket navigation survives browser back', async ({
	page
}, info) => {
	await page.goto(PRICE_HISTORY_E2E.tokenPath);
	await expect(chart(page)).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'sale chart', exact: true })).toHaveCount(0);
	const requested: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/price-history?')) requested.push(request.url());
	});
	await page.goto(PRICE_HISTORY_E2E.path + '?' + COLLECTION_CHART_TOKEN_QUERY + '=101');
	await loaded(page);
	expect(requested.at(-1)).toContain('token_id=101');
	await page
		.getByRole('combobox', { name: 'History range' })
		.selectOption(PRICE_HISTORY_RANGE.Year);
	await page
		.getByRole('combobox', { name: 'Time bucket' })
		.selectOption(PRICE_HISTORY_BUCKET.FourHours);
	await loaded(page);
	await page.goBack();
	await expect(page.getByRole('combobox', { name: 'Time bucket' })).toHaveValue(
		PRICE_HISTORY_BUCKET.Day
	);
	await loaded(page);
	await surface(page, info, 'token-chart');
	await page.getByRole('button', { name: 'all tokens', exact: true }).click();
	await loaded(page);
	expect(requested.at(-1)).not.toContain('token_id');
});

test('all history normalizes the URL and request to daily buckets, including browser back', async ({
	page
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const requests: URL[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/price-history?')) requests.push(new URL(request.url()));
	});
	const query = new URLSearchParams({
		[PRICE_CHART_QUERY.Range]: PRICE_HISTORY_RANGE.All,
		[PRICE_CHART_QUERY.Bucket]: PRICE_HISTORY_BUCKET.Hour
	});
	await page.goto(PRICE_HISTORY_E2E.path + '?' + query);
	await loaded(page);
	const bucket = page.getByRole('combobox', { name: 'Time bucket' });
	const range = page.getByRole('combobox', { name: 'History range' });
	await expect(bucket).toBeDisabled();
	await expect(bucket).toHaveValue(PRICE_HISTORY_BUCKET.Day);
	expect(new URL(page.url()).searchParams.get(PRICE_CHART_QUERY.Bucket)).toBe(
		PRICE_HISTORY_BUCKET.Day
	);
	expect(
		requests.every(
			(url) => url.searchParams.get(PRICE_HISTORY_QUERY.Bucket) === PRICE_HISTORY_BUCKET.Day
		)
	).toBe(true);
	await range.selectOption(PRICE_HISTORY_RANGE.Year);
	await expect(bucket).toBeEnabled();
	await bucket.selectOption(PRICE_HISTORY_BUCKET.FourHours);
	await loaded(page);
	await range.selectOption(PRICE_HISTORY_RANGE.All);
	await loaded(page);
	await expect(bucket).toBeDisabled();
	await expect(bucket).toHaveValue(PRICE_HISTORY_BUCKET.Day);
	await page.goBack();
	await expect(range).toHaveValue(PRICE_HISTORY_RANGE.Year);
	await expect(bucket).toBeEnabled();
	await expect(bucket).toHaveValue(PRICE_HISTORY_BUCKET.FourHours);
	await loaded(page);
	expect(errors).toEqual([]);
});

test('five years of 50,000 sales stay bounded in the sidebar and overlapping pins paginate', async ({
	page
}, info) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.route(PRICE_HISTORY_E2E.apiPattern, (route) =>
		route.fulfill({ json: priceHistoryFixture(PRICE_HISTORY_BUCKET.Day, undefined, 50_000) })
	);
	await page.goto(PRICE_HISTORY_E2E.path);
	await loaded(page);
	await expect(rows(page)).toHaveCount(50);
	await expect.poll(() => salePoint(page)).not.toBeNull();
	const point = (await salePoint(page))!;
	await page.mouse.click(point.x, point.y);
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'true');
	await expect(rows(page)).toHaveCount(50);
	const firstId = await rows(page).first().getAttribute('data-sale-id');
	const next = page.getByRole('button', { name: 'Next sales', exact: true });
	// The deliberately full-size pinned card can cover controls at phone width.
	if (info.project.name.includes('480')) {
		await next.focus();
		await next.press('Enter');
	} else await next.click();
	await expect(rows(page).first()).not.toHaveAttribute('data-sale-id', firstId!);
	await surface(page, info, 'dense-sale-dots');
	expect(errors).toEqual([]);
});

test('shared trait controls filter sales, clear pins, preserve navigation and reset through pills or hotkeys', async ({
	page
}, info) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	if (info.project.name.includes('768')) await page.setViewportSize({ width: 1920, height: 1080 });
	const requests: URLSearchParams[] = [];
	await page.route(PRICE_HISTORY_E2E.apiPattern, (route) => {
		const query = new URL(route.request().url()).searchParams;
		requests.push(query);
		// The DB suite verifies trait matching; this response exercises UI state replacement.
		return route.fulfill({
			json: priceHistoryFixture(
				query.get(PRICE_HISTORY_QUERY.Bucket) as PriceHistoryBucket,
				query.has(TRAIT_FILTER_QUERY_PARAMS.Traits) ? '103' : undefined
			)
		});
	});
	await page.goto(
		PRICE_HISTORY_E2E.path +
			'?' +
			new URLSearchParams({
				[PRICE_CHART_QUERY.Range]: PRICE_HISTORY_RANGE.Year,
				[PRICE_CHART_QUERY.Bucket]: PRICE_HISTORY_BUCKET.FourHours
			})
	);
	await loaded(page);
	await expect.poll(() => salePoint(page)).not.toBeNull();
	const point = (await salePoint(page))!;
	await page.mouse.click(point.x, point.y);
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'true');
	await page.keyboard.press('f');
	const panel = page.locator('.facet-panel');
	await expect(panel).toBeVisible();
	const zone = panel
		.locator('.trait-group')
		.filter({ has: page.locator('.trait-group-title', { hasText: 'Zone' }) });
	// A pinned full-size card can cover pointer targets on narrow screens; keyboard remains available.
	await zone.locator('summary').focus();
	await zone.locator('summary').press('Enter');
	const tetsu = zone.getByRole('checkbox', { name: /Tetsu/ });
	await tetsu.focus();
	await tetsu.press('Space');
	await expect(page.getByRole('button', { name: 'remove Zone=Tetsu', exact: true })).toBeVisible();
	await loaded(page);
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'false');
	await expect(page.locator('.sale-card-preview.pinned')).toHaveCount(0);
	await expect(page.locator('.sale-sidebar-heading')).toHaveText('sales · 190');
	expect(requests.at(-1)!.getAll(TRAIT_FILTER_QUERY_PARAMS.Traits)).toEqual(['Zone:Tetsu']);
	expect(requests.at(-1)!.get(PRICE_HISTORY_QUERY.Bucket)).toBe(PRICE_HISTORY_BUCKET.FourHours);
	expect(requests.at(-1)!.get(PRICE_HISTORY_QUERY.Range)).toBe(PRICE_HISTORY_RANGE.Year);
	await expect(rows(page).locator('a.sale-thumbnail')).toHaveCount(50);
	for (const href of await rows(page)
		.locator('a.sale-thumbnail')
		.evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
		expect(new URL(href!, page.url()).pathname).toMatch(/\/103$/);
	await chartGutters(page);
	await surface(page, info, 'chart-trait-filter-expanded');
	await page.getByRole('button', { name: 'collapse traits panel' }).click();
	await expect(panel).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'tokens', exact: true }).first()).toHaveAttribute(
		'href',
		/traits=Zone%3ATetsu/
	);
	await surface(page, info, 'chart-trait-filter-collapsed');
	await chartGutters(page);
	await page.getByRole('button', { name: 'remove Zone=Tetsu', exact: true }).click();
	await loaded(page);
	await expect(page.locator('.sale-sidebar-heading')).toHaveText('sales · 572');
	await page.goBack();
	await expect(page.getByRole('button', { name: 'remove Zone=Tetsu', exact: true })).toBeVisible();
	await loaded(page);
	await expect(page.locator('.sale-sidebar-heading')).toHaveText('sales · 190');
	await page.keyboard.press('r');
	await expect(page.getByRole('button', { name: 'reset', exact: true })).toHaveCount(0);
	await loaded(page);
	expect(new URL(page.url()).searchParams.get(PRICE_CHART_QUERY.Bucket)).toBe(
		PRICE_HISTORY_BUCKET.FourHours
	);
	expect(errors).toEqual([]);
});

test('customized numeric facets filter the chart and recover from empty results with the shared reset', async ({
	page
}, info) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	if (info.project.name.includes('768')) await page.setViewportSize({ width: 1440, height: 1000 });
	const requests: URLSearchParams[] = [];
	await page.route(PRICE_HISTORY_E2E.apiPattern, (route) => {
		const query = new URL(route.request().url()).searchParams;
		requests.push(query);
		const selection = query.get(TRAIT_FILTER_QUERY_PARAMS.TraitRanges);
		return route.fulfill({
			json: priceHistoryFixture(
				PRICE_HISTORY_BUCKET.Day,
				selection === 'Biome:43..' ? 'no-match' : selection ? '102' : undefined
			)
		});
	});
	await page.goto(PRICE_HISTORY_E2E.path);
	await loaded(page);
	await page.getByRole('button', { name: 'expand traits panel' }).click();
	const biome = page
		.locator('.trait-group')
		.filter({ has: page.locator('.trait-group-title', { hasText: 'Biome' }) });
	await biome.locator('summary').click();
	await biome.getByLabel('from', { exact: true }).fill('7');
	await biome.getByLabel('to', { exact: true }).fill('7');
	await biome.getByRole('button', { name: 'apply', exact: true }).click();
	await expect(page.getByRole('button', { name: 'remove Biome=7..7', exact: true })).toBeVisible();
	await loaded(page);
	await expect(page.locator('.sale-sidebar-heading')).toHaveText('sales · 190');
	expect(requests.at(-1)!.getAll(TRAIT_FILTER_QUERY_PARAMS.TraitRanges)).toEqual(['Biome:7..7']);
	await surface(page, info, 'chart-trait-range');
	await biome.getByLabel('from', { exact: true }).fill('43');
	await biome.getByLabel('to', { exact: true }).fill('');
	await biome.getByRole('button', { name: 'apply', exact: true }).click();
	await expect(page.getByText('no sale prices', { exact: true })).toBeVisible();
	await surface(page, info, 'chart-trait-empty');
	await page.getByRole('button', { name: 'reset', exact: true }).click();
	await loaded(page);
	await expect(page.locator('.sale-sidebar-heading')).toHaveText('sales · 572');
	expect(requests.at(-1)!.has(TRAIT_FILTER_QUERY_PARAMS.TraitRanges)).toBe(false);
	expect(errors).toEqual([]);
});

test('reset cancels an in-flight trait selection and a late response cannot replace the restored chart', async ({
	page
}) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started!: () => void;
	const requested = new Promise<void>((resolve) => {
		started = resolve;
	});
	let finished!: () => void;
	const responded = new Promise<void>((resolve) => {
		finished = resolve;
	});
	await page.route(PRICE_HISTORY_E2E.apiPattern, async (route) => {
		const filtered = new URL(route.request().url()).searchParams.has(
			TRAIT_FILTER_QUERY_PARAMS.Traits
		);
		if (filtered) {
			started();
			await pending;
		}
		await route.fulfill({
			json: priceHistoryFixture(PRICE_HISTORY_BUCKET.Day, filtered ? '103' : undefined)
		});
		if (filtered) finished();
	});
	await page.goto(
		PRICE_HISTORY_E2E.path +
			'?' +
			new URLSearchParams({ [TRAIT_FILTER_QUERY_PARAMS.Traits]: 'Zone:Tetsu' })
	);
	await requested;
	await expect(page.getByText('loading sales…', { exact: true })).toBeVisible();
	const cancelled = page.waitForEvent(
		'requestfailed',
		(request) =>
			request.url().includes('/price-history?') &&
			new URL(request.url()).searchParams.has(TRAIT_FILTER_QUERY_PARAMS.Traits)
	);
	await page.getByRole('button', { name: 'reset', exact: true }).click();
	await cancelled;
	await loaded(page);
	await expect(page.locator('.sale-sidebar-heading')).toHaveText('sales · 572');
	release();
	await responded;
	await expect(page.locator('.sale-sidebar-heading')).toHaveText('sales · 572');
	await expect(page.getByRole('button', { name: 'remove Zone=Tetsu', exact: true })).toHaveCount(0);
});
