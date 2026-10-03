import { expect, test, type Page } from 'playwright/test';
import { BIDDING_SELECTION_ACTION_LABEL } from '../src/lib/bidding-selection-actions';
import { TEST_IDS } from '../src/lib/test-ids';
import { BID_BOOK_FILTER_LABEL } from '../src/lib/bid-book-view-models';
import {
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER,
	COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER,
	COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS,
	COLLECTION_BIDDING_BID_SCOPE_FILTER
} from '@artgod/shared/types';
import { LOCAL_STORAGE_KEYS } from '../src/lib/local-storage-keys';
import {
	attachDiagnosticsForTestFailure,
	captureDiagnosticsForTest,
	type PageDiagnosticsRegistry
} from './attached-app';
import { installBiddingAutomationApiMock } from './helpers/bidding-automation-api';

const COLLECTION_PATH = '/e2e-harness/collection';
const BIDDING_PATH = `${COLLECTION_PATH}/bidding`;
const diagnosticsByTest: PageDiagnosticsRegistry = new Map();

test.beforeEach(async ({ page }, testInfo) => {
	captureDiagnosticsForTest(diagnosticsByTest, page, testInfo);
	await installBiddingAutomationApiMock(page);
});

test.afterEach(async ({}, testInfo) => {
	await attachDiagnosticsForTestFailure(diagnosticsByTest, testInfo);
});

test.describe('bidding automation public read-only guardrails', () => {
	test('opens an unfiltered direct Offers URL without private defaults', async ({ page }) => {
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.BidScope}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}`
		);
		await expect(page.locator('.bid-book-meta')).toBeVisible();
		const query = new URL(page.url()).searchParams;
		expect(query.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Ownership)).toBe(false);
		expect(query.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)).toBe(false);
		await expect(page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState })).toHaveCount(0);
		await expect(page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.OwnBids })).toHaveCount(0);
	});

	test('opens fresh Offers navigation without private filters', async ({ page }, testInfo) => {
		await openHarnessPage(page, COLLECTION_PATH);
		await page.getByRole('link', { name: 'offers', exact: true }).click();
		await expect(page.locator('.bid-book-meta')).toBeVisible();
		const query = new URL(page.url()).searchParams;
		expect(query.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Ownership)).toBe(false);
		expect(query.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)).toBe(false);
		await expect(page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState })).toHaveCount(0);
		await expect(page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.OwnBids })).toHaveCount(0);
		await expect(page.getByRole('link', { name: BID_BOOK_FILTER_LABEL.OwnBids })).toHaveCount(0);
		await page.screenshot({
			path: testInfo.outputPath('public-offers-default.png'),
			fullPage: true
		});
	});

	test('preserves remembered trait scope without restoring private filters', async ({ page }) => {
		await page.addInitScript(
			({ storageKey, preference }) => localStorage.setItem(storageKey, JSON.stringify(preference)),
			{
				storageKey: LOCAL_STORAGE_KEYS.collectionBiddingNavigationPreferences,
				preference: {
					bidScope: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
					ownershipFilter: COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own,
					ownStateFilter: COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active
				}
			}
		);
		await openHarnessPage(page, COLLECTION_PATH);
		await page.getByRole('link', { name: 'offers', exact: true }).click();
		await expect(page.locator('.bid-book-meta')).toContainText('targets');
		const query = new URL(page.url()).searchParams;
		expect(query.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.BidScope)).toBe(
			COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
		);
		expect(query.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Ownership)).toBe(false);
		expect(query.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)).toBe(false);
		await expect(page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState })).toHaveCount(0);
		for (const scope of [
			COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
			COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
			COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
		]) {
			await page.getByRole('link', { name: scope, exact: true }).click();
			await expect(page).toHaveURL(
				new RegExp(`${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.BidScope}=${scope}`)
			);
			await expect(page.locator('.bid-book-meta')).toBeVisible();
			const scopeQuery = new URL(page.url()).searchParams;
			expect(scopeQuery.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Ownership)).toBe(false);
			expect(scopeQuery.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)).toBe(false);
			await expect(page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState })).toHaveCount(
				0
			);
		}
	});

	test('renders offers bid books without local bidding write controls', async ({ page }) => {
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=token`);

		await expect(page.locator('.bid-book-meta')).toBeVisible();
		await expect(
			page.locator(`[data-testid="${TEST_IDS.TokenCard}"][data-token-id="101"]`)
		).toBeVisible();
		await expect(
			page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnAllTokens })
		).toHaveCount(0);
		await expect(
			page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.Tiers })
		).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
		await expect(page.getByRole('link', { name: BID_BOOK_FILTER_LABEL.OwnBids })).toHaveCount(0);
		await expect(page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState })).toHaveCount(0);

		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);
		await expect(page.locator('.bid-book-meta')).toContainText('targets');
		await expect(
			page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.Tiers })
		).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"]`)).toHaveCount(0);
		await expect(page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState })).toHaveCount(0);
	});

	test('renders token detail bid book without local bidding write controls', async ({ page }) => {
		await openHarnessPage(page, `${COLLECTION_PATH}/101`);

		await expect(page.locator('.bid-book-meta')).toBeVisible();
		await expect(
			page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnToken })
		).toHaveCount(0);
		await expect(page.getByRole('button', { name: /^place bid on / })).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BidBookRowBid}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
	});
});

async function openHarnessPage(page: Page, path: string): Promise<void> {
	await page.goto(path, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');
}
