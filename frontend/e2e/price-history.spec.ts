import { test, expect, type Page, type TestInfo } from 'playwright/test';
import { writeFile } from 'node:fs/promises';
import {
	PRICE_HISTORY_QUERY,
	PRICE_HISTORY_BUCKET,
	PRICE_HISTORY_CURRENCY_SYMBOL,
	type PriceHistoryBucket
} from '@artgod/shared/types/price-history';
import { PRICE_CHART_QUERY, PRICE_CHART_MODE } from '../src/lib/price-chart/model';
import { PRICE_HISTORY_E2E, priceHistoryFixture } from './price-history-fixtures';

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
});
async function surface(page: Page, info: TestInfo, name: string) {
	const path = info.outputPath(name + '.png');
	await page.screenshot({ path, fullPage: true });
	await info.attach(name, { path, contentType: 'image/png' });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
const chart = (page: Page) => page.getByRole('region', { name: 'Collection sale prices' });
async function loaded(page: Page) {
	await expect(page.locator('[data-chart-ready="true"]')).toBeVisible();
	await expect(page.getByText('loading sales…', { exact: true })).toHaveCount(0);
	await expect(page.locator('.price-canvas canvas').first()).toBeVisible();
}

test('collection candles, line, dots, pan, zoom and configurable indicator panes', async ({
	page
}, info) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(PRICE_HISTORY_E2E.path);
	await loaded(page);
	await surface(page, info, 'collection-candles');
	await chart(page).getByRole('button', { name: 'indicators', exact: true }).click();
	const sma = chart(page).getByRole('group', { name: 'SMA 20', exact: true });
	await sma.getByRole('button', { name: 'SMA', exact: true }).click();
	await sma.getByRole('spinbutton').fill('0');
	await sma.getByRole('spinbutton').press('Tab');
	await expect(chart(page).getByRole('alert')).toHaveText(
		'Use a whole-number length from 1 to 500.'
	);
	await expect(sma.getByRole('spinbutton')).toHaveValue('20');
	await surface(page, info, 'indicator-validation');
	await sma.getByRole('spinbutton').fill('10');
	await sma.getByRole('spinbutton').press('Tab');
	await expect(chart(page).getByRole('alert')).toHaveCount(0);
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
	await surface(page, info, 'collection-indicators');
	await chart(page).getByRole('button', { name: 'line', exact: true }).click();
	await expect(chart(page).locator('[aria-current="true"]')).toHaveText('line');
	await expect(page).toHaveURL(new RegExp(`${PRICE_CHART_QUERY.Mode}=${PRICE_CHART_MODE.Line}`));
	await surface(page, info, 'collection-line');
	await chart(page).getByRole('button', { name: 'dots', exact: true }).click();
	await expect(chart(page).locator('[aria-current="true"]')).toHaveText('dots');
	await surface(page, info, 'collection-dots');
	const canvas = page.locator('.price-canvas');
	const box = (await canvas.boundingBox())!;
	const before = await canvas.screenshot();
	await page.mouse.move(box.x + box.width / 2, box.y + 180);
	await page.mouse.wheel(0, -600);
	await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(false);
	const zoomed = await canvas.screenshot();
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 100, box.y + 180, { steps: 10 });
	await page.mouse.up();
	await expect.poll(async () => (await canvas.screenshot()).equals(zoomed)).toBe(false);
	await chart(page).getByRole('button', { name: 'fit', exact: true }).click();
	await chart(page)
		.getByRole('combobox', { name: 'Time bucket' })
		.selectOption(PRICE_HISTORY_BUCKET.FourHours);
	await loaded(page);
	await expect(page).toHaveURL(new RegExp(`${PRICE_CHART_QUERY.Bucket}=4h`));
	await surface(page, info, 'collection-four-hour-dots');
	expect(errors).toEqual([]);
});

test('loading, empty, failure and retry remain usable on the complete collection surface', async ({
	page
}, info) => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	let state: 'loading' | 'empty' | 'error' | 'success' = 'loading';
	await page.route(PRICE_HISTORY_E2E.apiPattern, async (route) => {
		if (state === 'loading') await gate;
		if (state === 'error')
			return route.fulfill({
				status: 400,
				json: { message: 'Choose a shorter price history range.' }
			});
		const history = priceHistoryFixture();
		await route.fulfill({
			json: state === 'empty' ? { ...history, sales: [], buckets: [], from: history.to } : history
		});
	});
	await page.goto(PRICE_HISTORY_E2E.path);
	await expect(page.getByText('loading sales…', { exact: true })).toBeVisible();
	await surface(page, info, 'collection-loading');
	state = 'empty';
	release();
	await expect(page.getByText('no single-token sales', { exact: true })).toBeVisible();
	await surface(page, info, 'collection-empty');
	state = 'error';
	await chart(page).getByRole('button', { name: 'refresh', exact: true }).click();
	await expect(page.getByRole('alert').filter({ hasText: 'Choose a shorter' })).toBeVisible();
	await surface(page, info, 'collection-error');
	state = 'success';
	await chart(page).getByRole('button', { name: 'retry', exact: true }).click();
	await loaded(page);
	await surface(page, info, 'collection-retry');
});

test('token view requests only that token and retains chart settings through back navigation', async ({
	page
}, info) => {
	const requested: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/price-history?')) requested.push(request.url());
	});
	await page.goto(PRICE_HISTORY_E2E.tokenPath);
	await loaded(page);
	expect(
		requested.some((url) => new URL(url).searchParams.get(PRICE_HISTORY_QUERY.TokenId) === '101')
	).toBe(true);
	await surface(page, info, 'token-candles');
	const tokenChart = page.getByRole('region', { name: 'Token sale prices' });
	await tokenChart.getByRole('button', { name: 'line', exact: true }).click();
	await tokenChart.getByRole('button', { name: 'dots', exact: true }).click();
	await page.goBack();
	await expect(tokenChart.locator('[aria-current="true"]')).toHaveText('line');
	await surface(page, info, 'token-line');
});

// Inspect the maintained harness's own canvas, never host windows or display APIs.
async function rightmostSalePoint(page: Page) {
	return page.locator('.price-canvas').evaluate((element) => {
		const sample = document.createElement('canvas');
		sample.width = sample.height = 1;
		const sampleContext = sample.getContext('2d')!;
		sampleContext.fillStyle = getComputedStyle(element).getPropertyValue('--c-cyan');
		sampleContext.fillRect(0, 0, 1, 1);
		const color = sampleContext.getImageData(0, 0, 1, 1).data;
		for (const canvas of element.querySelectorAll('canvas')) {
			const rect = canvas.getBoundingClientRect();
			if (rect.height < 200 || rect.width < 200) continue;
			const context = canvas.getContext('2d');
			if (!context) continue;
			const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
			for (let x = canvas.width - 1; x >= 0; x--) {
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
	});
}

test('individual dots retain coincident fills and show token, exact original-currency price and transaction on hover', async ({
	page
}, info) => {
	if (info.project.name.includes('768')) await page.setViewportSize({ width: 1280, height: 1024 });
	await page.goto(`${PRICE_HISTORY_E2E.path}?${PRICE_CHART_QUERY.Mode}=${PRICE_CHART_MODE.Dots}`);
	await loaded(page);
	await page.locator('.price-canvas').scrollIntoViewIfNeeded();
	await expect.poll(() => rightmostSalePoint(page)).not.toBeNull();
	const point = (await rightmostSalePoint(page))!;
	await page.mouse.move(point.x, point.y);
	await expect(chart(page).getByText('token #103', { exact: true })).toBeVisible();
	await expect(chart(page).getByText('token #99', { exact: true })).toBeVisible();
	await expect(chart(page).getByText('token #98', { exact: true })).toBeVisible();
	for (const [tokenId, currency] of [
		['103', PRICE_HISTORY_CURRENCY_SYMBOL.Beth],
		['99', PRICE_HISTORY_CURRENCY_SYMBOL.Weth],
		['98', PRICE_HISTORY_CURRENCY_SYMBOL.Eth]
	]) {
		await expect(
			chart(page).locator('.sale-row').filter({ hasText: `token #${tokenId}` })
		).toContainText(`1.452 ${currency}`);
	}
	await expect(chart(page).locator('.sale-row [title]').first()).toHaveAttribute(
		'title',
		/^0x[0-9a-f]{64}$/
	);
	await surface(page, info, 'sale-dot-hover');
});

test('50,000 sales remain interactive and coincident-sale inspection stays paginated', async ({
	page
}, info) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const history = priceHistoryFixture(PRICE_HISTORY_BUCKET.Day, undefined, 50_000);
	await page.route(PRICE_HISTORY_E2E.apiPattern, (route) => route.fulfill({ json: history }));
	const start = Date.now();
	await page.goto(`${PRICE_HISTORY_E2E.path}?${PRICE_CHART_QUERY.Mode}=${PRICE_CHART_MODE.Dots}`);
	await loaded(page);
	await page.locator('.price-canvas').scrollIntoViewIfNeeded();
	await expect.poll(() => rightmostSalePoint(page)).not.toBeNull();
	const renderedMs = Date.now() - start;
	const point = (await rightmostSalePoint(page))!;
	await page.mouse.move(point.x, point.y);
	await expect(chart(page).locator('.sale-row')).toHaveCount(10);
	const firstTx = await chart(page).locator('.sale-row [title]').first().getAttribute('title');
	await chart(page).getByRole('button', { name: 'next sales' }).click();
	await expect(chart(page).locator('.sale-row [title]').first()).not.toHaveAttribute(
		'title',
		firstTx!
	);
	const canvas = page.locator('.price-canvas');
	await canvas.scrollIntoViewIfNeeded();
	const bounds = (await canvas.boundingBox())!;
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
	const before = await canvas.screenshot();
	await page.mouse.wheel(0, -300);
	await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(false);
	const metricsPath = info.outputPath('synthetic-chart-render.json');
	await writeFile(
		metricsPath,
		JSON.stringify(
			{
				sales: history.sales.length,
				populatedBuckets: history.buckets.length,
				renderedMs
			},
			null,
			2
		)
	);
	await info.attach('synthetic-chart-render', {
		path: metricsPath,
		contentType: 'application/json'
	});
	await surface(page, info, 'dense-sale-dots');
	expect(errors).toEqual([]);
});
