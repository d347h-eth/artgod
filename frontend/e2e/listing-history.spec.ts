import { test, expect, type Page, type TestInfo } from 'playwright/test';
import { LISTING_HISTORY_HARNESS } from '../src/lib/e2e/listing-history-contract';
import { openseaItemHref } from '../src/lib/marketplace-links';
import {
	BIDDING_AUTOMATION_E2E_COLLECTION_BASE_PATH,
	BIDDING_E2E_CHAIN,
	BIDDING_E2E_COLLECTION
} from '../src/lib/e2e/bidding-automation-fixtures';
import {
	captureDiagnosticsForTest,
	attachDiagnosticsForTestFailure,
	type PageDiagnosticsRegistry
} from './attached-app';
import { installBiddingAutomationApiMock } from './helpers/bidding-automation-api';

const diagnostics: PageDiagnosticsRegistry = new Map();
test.beforeEach(async ({ page }, info) => {
	captureDiagnosticsForTest(diagnostics, page, info);
	await page.clock.install();
	// Navigation to asks uses the same isolated API fixtures as the bidding harness.
	await installBiddingAutomationApiMock(page);
});
test.afterEach(async ({ page }, info) => {
	if (info.status !== info.expectedStatus) await surface(page, info, 'failure-surface');
	await attachDiagnosticsForTestFailure(diagnostics, info);
});

async function surface(page: Page, info: TestInfo, name: string) {
	const path = info.outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: true });
	await info.attach(name, { path, contentType: 'image/png' });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
}

test('sales distinguish NFT quantities from leg totals without changing single-unit prices', async ({
	page
}, info) => {
	await page.goto(`${LISTING_HISTORY_HARNESS.path}?${LISTING_HISTORY_HARNESS.salesKey}=1`);
	for (const label of [
		'1.5 ETH',
		'4 tokens, 8 ETH total',
		'2 ETH',
		'2 tokens, 4 ETH total',
		'2 tokens, 0 ETH total',
		'4 tokens, -'
	]) {
		const cell = page.getByRole('cell', { name: label, exact: true });
		await expect(cell).toBeVisible();
		expect(await cell.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	}
	const quantityRow = page.getByRole('row').filter({
		has: page.getByRole('cell', { name: '4 tokens, 8 ETH total', exact: true })
	});
	const tokenId = await quantityRow.getByRole('link', { name: /^\d+$/ }).innerText();
	await expect(page.getByRole('link', { name: '8 ETH', exact: true })).toHaveAttribute(
		'href',
		openseaItemHref({
			chainSlug: BIDDING_E2E_CHAIN.slug,
			collectionAddress: BIDDING_E2E_COLLECTION.address,
			tokenId
		})!
	);
	await surface(page, info, 'sale-quantities');
	await page.setViewportSize({ width: 1280, height: 1024 });
	await surface(page, info, 'sale-quantities-desktop');
});

test('daily listings retain historical prices and pinned timestamps after expiry', async ({
	page
}, info) => {
	await page.setViewportSize({ width: 1280, height: 1024 });
	await page.goto(LISTING_HISTORY_HARNESS.path);
	await expect(page.getByRole('columnheader', { name: 'price', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: '0.1 ETH', exact: true })).toBeVisible();
	const pinnedTime = () =>
		page.locator('tbody tr').first().locator('td').last().locator('[title]').getAttribute('title');
	const timestamp = await pinnedTime();
	expect(timestamp).toBeTruthy();
	await surface(page, info, 'daily-listing-current');
	await page.getByRole('link', { name: 'older', exact: true }).click();
	await expect(page.getByText('showing 2-2 of 2')).toBeVisible();
	expect(await pinnedTime()).not.toBe(timestamp);
	await surface(page, info, 'daily-listing-second-page');
	await page.getByRole('link', { name: 'newer', exact: true }).click();
	await expect(page.getByText('showing 1-1 of 2')).toBeVisible();
	expect(await pinnedTime()).toBe(timestamp);
	await page.goto(`${LISTING_HISTORY_HARNESS.path}?${LISTING_HISTORY_HARNESS.updatedKey}=1`);
	await expect(page.getByRole('link', { name: '0.05 ETH', exact: true })).toBeVisible();
	expect(await pinnedTime()).toBe(timestamp);
	await surface(page, info, 'daily-listing-price-changed');
	await page.goto(`${LISTING_HISTORY_HARNESS.path}?${LISTING_HISTORY_HARNESS.unavailableKey}=1`);
	await expect(page.getByRole('link', { name: '0.05 ETH', exact: true })).toBeVisible();
	await expect(page.getByText('No current ask', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('link', { name: '104', exact: true })).toBeVisible();
	expect(await pinnedTime()).toBe(timestamp);
	await surface(page, info, 'daily-listing-retained-price');
	await page.goto(`${LISTING_HISTORY_HARNESS.path}?${LISTING_HISTORY_HARNESS.emptyKey}=1`);
	await expect(page.getByText('no activities found', { exact: true })).toBeVisible();
	await surface(page, info, 'daily-listing-empty');
	await page.getByRole('link', { name: 'asks', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`${BIDDING_AUTOMATION_E2E_COLLECTION_BASE_PATH}\\?`));
	await expect(page.getByRole('link', { name: '0.9 ETH', exact: true })).toBeVisible();
	await surface(page, info, 'asks-card-grid');
	await page.getByRole('link', { name: 'listings', exact: true }).click();
	await expect(page.getByRole('link', { name: '0.1 ETH', exact: true })).toBeVisible();
	expect(await pinnedTime()).toBe(timestamp);
});

test('a sold token leaves asks and remains browsable without its old price', async ({
	page
}, info) => {
	await page.setViewportSize({ width: 1280, height: 1024 });
	const base = BIDDING_AUTOMATION_E2E_COLLECTION_BASE_PATH;
	await page.goto(base);
	await expect(page.getByRole('link', { name: '0.9 ETH', exact: true })).toBeVisible();
	await page.goto(`${base}?${LISTING_HISTORY_HARNESS.soldKey}=1`);
	await expect(page.getByRole('link', { name: '0.85 ETH', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: '101', exact: true })).toHaveCount(0);
	await expect(page.getByRole('link', { name: '0.9 ETH', exact: true })).toHaveCount(0);
	await surface(page, info, 'asks-after-sale');
	await page.goto(`${base}?${LISTING_HISTORY_HARNESS.soldKey}=1&token_status=all`);
	await expect(page.getByRole('link', { name: '101', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: '0.9 ETH', exact: true })).toHaveCount(0);
	await surface(page, info, 'sold-token-still-browsable');
});
