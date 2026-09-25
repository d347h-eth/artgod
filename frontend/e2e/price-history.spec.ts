import { test, expect, type Page, type TestInfo } from 'playwright/test';
import {
	PRICE_HISTORY_QUERY,
	PRICE_HISTORY_BUCKET,
	PRICE_HISTORY_CURRENCY_SYMBOL,
	type PriceHistoryBucket
} from '@artgod/shared/types/price-history';
import { COLLECTION_CHART_TOKEN_QUERY } from '../src/lib/price-chart/routing';
import { PRICE_CHART_QUERY } from '../src/lib/price-chart/model';
import { PRICE_HISTORY_E2E, priceHistoryFixture } from './price-history-fixtures';
import { TEST_IDS } from '../src/lib/test-ids';
import { COLLECTION_API_ROUTE_TEMPLATE } from '@artgod/shared/http/collection-routes';

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
async function surface(page: Page, info: TestInfo, name: string) {
	const path = info.outputPath(name + '.png');
	await page.screenshot({ path, fullPage: true });
	await info.attach(name, { path, contentType: 'image/png' });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
const chart = (page: Page) => page.locator('.realized-price');
const rows = (page: Page) => page.locator('.sale-row[data-sale-id]');
async function loaded(page: Page) {
	await expect(page.locator('[data-chart-ready="true"]')).toBeVisible();
	await expect(page.getByText('loading sales…', { exact: true })).toHaveCount(0);
	await expect(page.locator('.price-canvas canvas').first()).toBeVisible();
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
						return {
							x: rect.x + (x * rect.width) / canvas.width,
							y: rect.y + (y * rect.height) / canvas.height
						};
					}
				}
			}
		}
		return null;
	}, fromRight);
}

test('dedicated dots page is fourth in Explore and fills the viewport with configurable indicators', async ({
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
	await expect(explore.locator('a, .runtime-tab-active')).toHaveText([
		'asks',
		'offers',
		'tokens',
		'chart'
	]);
	await explore.getByRole('link', { name: 'chart', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(PRICE_HISTORY_E2E.path + '(\\?|$)'));
	await loaded(page);
	await expect(chart(page).getByRole('heading')).toHaveCount(0);
	await expect(page.locator('.runtime-tab-active').filter({ hasText: /^chart$/ })).toBeVisible();
	await expect(chart(page).getByRole('button', { name: /^(dots|line|candles)$/ })).toHaveCount(0);
	const bounds = (await chart(page).boundingBox())!;
	expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
	expect(bounds.height).toBeGreaterThan(page.viewportSize()!.height * 0.55);
	if (page.viewportSize()!.width > 1500) {
		const canvas = (await page.locator('.price-canvas').boundingBox())!;
		expect(canvas.width / bounds.width).toBeGreaterThan(0.88);
		expect(canvas.width / bounds.width).toBeLessThan(0.91);
	}
	await surface(page, info, 'chart-page');
	await chart(page).getByRole('button', { name: 'indicators', exact: true }).click();
	const sma = chart(page).getByRole('group', { name: 'SMA 20', exact: true });
	await sma.getByRole('button', { name: 'SMA', exact: true }).click();
	expect(await sma.getByRole('spinbutton').evaluate((el) => getComputedStyle(el).appearance)).toBe(
		'textfield'
	);
	await sma.getByRole('spinbutton').fill('0');
	await sma.getByRole('spinbutton').press('Tab');
	await expect(chart(page).getByRole('alert')).toHaveText(
		'Use a whole-number length from 1 to 500.'
	);
	await surface(page, info, 'indicator-validation');
	await sma.getByRole('spinbutton').fill('10');
	await sma.getByRole('spinbutton').press('Tab');
	await chart(page)
		.getByRole('group', { name: 'MACD 12/26/9' })
		.getByRole('button', { name: 'MACD', exact: true })
		.click();
	await chart(page)
		.getByRole('group', { name: 'RSI 14' })
		.getByRole('button', { name: 'RSI', exact: true })
		.click();
	await chart(page).getByRole('combobox', { name: 'Moving average type' }).selectOption('EMA');
	await chart(page).getByRole('button', { name: 'add moving average' }).click();
	await surface(page, info, 'indicator-controls');
	await chart(page).getByRole('button', { name: 'indicators', exact: true }).click();
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
	await surface(page, info, 'chart-indicators');
	await page
		.getByRole('combobox', { name: 'Time bucket' })
		.selectOption(PRICE_HISTORY_BUCKET.FourHours);
	await expect(page).toHaveURL(new RegExp(PRICE_CHART_QUERY.Bucket + '=4h'));
	await loaded(page);
	expect(errors).toEqual([]);
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
	await expect(page.getByRole('tooltip')).toBeVisible();
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
	for (const [id, currency] of [
		['103', PRICE_HISTORY_CURRENCY_SYMBOL.Beth],
		['99', PRICE_HISTORY_CURRENCY_SYMBOL.Weth],
		['98', PRICE_HISTORY_CURRENCY_SYMBOL.Eth]
	]) {
		const row = rows(page).filter({
			has: page.getByRole('link', { name: 'Token #' + id, exact: true })
		});
		await expect(row.locator('.sale-price a')).toHaveAttribute('title', '1.452 ' + currency);
	}
	await surface(page, info, 'dot-preview');
	await page.mouse.click(point.x, point.y);
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'true');
	await expect(floatingCard).toHaveAttribute('role', 'region');
	const pinnedPosition = await floatingCard.boundingBox();
	const pinnedIds = await rows(page).evaluateAll((items) =>
		items.map((el) => el.getAttribute('data-sale-id'))
	);
	await page.mouse.move(2, 2);
	await expect(floatingCard).toBeVisible();
	expect(
		await rows(page).evaluateAll((items) => items.map((el) => el.getAttribute('data-sale-id')))
	).toEqual(pinnedIds);
	const other = (await salePoint(page, false))!;
	await page.mouse.move(other.x, other.y);
	await expect(floatingCard.getByTestId(TEST_IDS.TokenCard)).toHaveAttribute(
		'data-token-id',
		'103'
	);
	expect(await floatingCard.boundingBox()).toEqual(pinnedPosition);
	expect(
		await rows(page).evaluateAll((items) => items.map((el) => el.getAttribute('data-sale-id')))
	).toEqual(pinnedIds);
	await page.mouse.move(2, 2);
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
		const row = element.getBoundingClientRect();
		return {
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
	await expect(thumb).toHaveAttribute('href', /\/\d+$/);
	// Native thumbnail navigation also works while another token's card is pinned.
	await page.mouse.click(point.x, point.y);
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'true');
	const tokenHref = await rowThumb.getAttribute('href');
	if (coveredByCard) await rowThumb.focus();
	else await rowThumb.hover();
	await expect(rowCard).toBeVisible();
	if (coveredByCard) await rowThumb.press('Enter');
	else await rowThumb.click();
	await expect(page).toHaveURL(new RegExp(tokenHref! + '$'));
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
	await expect(page).toHaveURL(new RegExp(href! + '$'));
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
	await surface(page, info, 'chart-loading');
	release();
	await expect(page.getByText('no single-token sales', { exact: true })).toBeVisible();
	await surface(page, info, 'chart-empty');
	await page.route(PRICE_HISTORY_E2E.apiPattern, (route) =>
		route.fulfill({ status: 400, json: { message: 'Choose a shorter price history range.' } })
	);
	await chart(page).getByRole('button', { name: 'refresh', exact: true }).click();
	await expect(chart(page).getByRole('alert')).toContainText(
		'Choose a shorter price history range.'
	);
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

test('50,000 sales stay bounded in the sidebar and overlapping pins paginate', async ({
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
	await page.getByRole('button', { name: 'Next sales', exact: true }).click();
	await expect(rows(page).first()).not.toHaveAttribute('data-sale-id', firstId!);
	await surface(page, info, 'dense-sale-dots');
	expect(errors).toEqual([]);
});
