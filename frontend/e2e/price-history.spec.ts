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

const PREVIEW_API = '**/api/*/*/*/preview?*';
const IMAGE =
	'data:image/svg+xml,' +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#93d1de"/><circle cx="32" cy="32" r="22" fill="#ec7e15"/></svg>'
	);
function mediaResponse(url: string) {
	const tokenId = new URL(url).pathname.split('/').at(-2)!;
	return { token: { tokenId, image: IMAGE, animationUrl: null } };
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
	await page.route(PREVIEW_API, (route) =>
		route.fulfill({ json: mediaResponse(route.request().url()) })
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
	await expect(page.locator('.runtime-tab-active').filter({ hasText: /^chart$/ })).toBeVisible();
	await expect(chart(page).getByRole('button', { name: /^(dots|line|candles)$/ })).toHaveCount(0);
	const bounds = (await chart(page).boundingBox())!;
	expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
	expect(bounds.height).toBeGreaterThan(page.viewportSize()!.height * 0.55);
	if (page.viewportSize()!.width > 1500) {
		const canvas = (await page.locator('.price-canvas').boundingBox())!;
		expect(canvas.width / bounds.width).toBeGreaterThan(0.89);
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
	await expect.poll(() => salePoint(page)).not.toBeNull();
	const point = (await salePoint(page))!;
	await page.mouse.move(point.x, point.y);
	await expect(page.getByRole('tooltip')).toBeVisible();
	await expect(page.getByRole('tooltip').locator('iframe')).toHaveAttribute(
		'sandbox',
		'allow-scripts'
	);
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
	await page.mouse.click(point.x, point.y);
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'false');
	await page.mouse.click(point.x, point.y);
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'true');
	const pinnedIds = await rows(page).evaluateAll((items) =>
		items.map((el) => el.getAttribute('data-sale-id'))
	);
	await page.mouse.move(2, 2);
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	expect(
		await rows(page).evaluateAll((items) => items.map((el) => el.getAttribute('data-sale-id')))
	).toEqual(pinnedIds);
	const other = (await salePoint(page, false))!;
	await page.mouse.move(other.x, other.y);
	await expect(page.getByRole('tooltip')).toBeVisible();
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
	await thumb.hover();
	const iframe = page.getByRole('tooltip').locator('iframe');
	await expect(iframe).toBeVisible();
	await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
	await surface(page, info, 'pinned-row-preview');
	await page.mouse.move(2, 2);
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	await page.getByRole('button', { name: 'unpin', exact: true }).click();
	await expect(page.locator('.sale-sidebar')).toHaveAttribute('data-pinned', 'false');
	await expect(rows(page)).toHaveCount(50);
	await expect(thumb).toHaveAttribute('href', /\/\d+$/);
	// Native link activation stays intact for the tiny token thumbnail.
	const tokenHref = await rows(page).first().locator('.sale-thumbnail').getAttribute('href');
	await rows(page).first().locator('.sale-thumbnail').click();
	await expect(page).toHaveURL(new RegExp(tokenHref! + '$'));
});

test('slow and failed media cannot leave a stale popup after pointer exit', async ({
	page
}, info) => {
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => (release = resolve));
	await page.route(PREVIEW_API, async (route) => {
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
	await page.mouse.move(2, 2);
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	await page.route(PREVIEW_API, (route) =>
		route.fulfill({ json: mediaResponse(route.request().url()) })
	);
	await page.mouse.move(point.x, point.y);
	await expect(page.getByRole('tooltip').locator('iframe')).toBeVisible();
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
	await expect(page.getByRole('link', { name: 'sale chart', exact: true })).toHaveAttribute(
		'href',
		/chart\?token_id=101$/
	);
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
