import {
	BIDDING_E2E_SCENARIO,
	BIDDING_E2E_SCENARIO_QUERY_PARAM
} from '../src/lib/e2e/bidding-automation-fixtures';
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
	test('hides private pricing filters when tier-attributed jobs exist', async ({ page }) => {
		for (const scope of [
			COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
			COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
		]) {
			await openHarnessPage(
				page,
				`${BIDDING_PATH}?${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.BidScope}=${scope}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.PriceTierFilters}`
			);
			await expect(page.locator('.bid-book-meta')).toBeVisible();
			await expect(page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.PriceTier })).toHaveCount(
				0
			);
			await expect(page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState })).toHaveCount(
				0
			);
			expect(
				new URL(page.url()).searchParams.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.PriceTier)
			).toBe(false);
		}
	});

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

test('public collection entry waits for a view and exposes read-only browsing', async ({
	page
}, info) => {
	const path = '/api/ethereum/e2e-bidding';
	const { buildBiddingE2eCollectionDetailData } =
		await import('../src/lib/e2e/bidding-automation-fixtures');
	const { TRAIT_CATALOG_QUERY } = await import('@artgod/shared/types/trait-catalog');
	const view = {
		id: 'egg',
		label: 'Eggs',
		parent: null,
		pinnedTraits: [{ key: 'type', value: 'egg' }],
		generation: 1,
		activeMapperVersion: 'test',
		availableMapperVersion: 'test',
		ready: 0,
		classified: 0
	};
	const reads: string[] = [];
	const identity = buildBiddingE2eCollectionDetailData(new URLSearchParams()).collection;
	const collection = { ...identity, extensions: [], activityEventFeeds: [] };
	await page.route('**/api/**', (route) =>
		route.fulfill({ status: 404, json: { message: 'Unexpected fixture request' } })
	);
	await page.route('**/collection-views*', (route) =>
		route.fulfill({
			json: {
				required: true,
				selectedViewId: new URL(route.request().url()).searchParams.get(TRAIT_CATALOG_QUERY.View),
				collection,
				views: [view]
			}
		})
	);
	await page.route('**/api/runtime/config', (route) => route.fulfill({ json: {} }));
	await page.route(
		(url) => url.pathname === path,
		(route) => {
			const query = new URL(route.request().url()).searchParams;
			reads.push(query.get(TRAIT_CATALOG_QUERY.View) ?? '');
			const fixture = buildBiddingE2eCollectionDetailData(query);
			return route.fulfill({
				json: {
					...fixture,
					collection,
					tokens: {
						...fixture.tokens,
						items: [],
						totalItems: 0,
						totalPages: 0,
						rangeStart: 0,
						rangeEnd: 0,
						prevCursor: null,
						nextCursor: null
					},
					traits: { facets: [], selected: [], selectedRanges: [] }
				}
			});
		}
	);
	await page.goto(COLLECTION_PATH);
	await expect(page.locator('html')).toHaveAttribute('data-artgod-hydrated', '1');
	await page.evaluate(() => {
		const link = document.createElement('a');
		link.href = '/';
		document.body.append(link);
		link.click();
		link.remove();
	});
	await expect(page.getByLabel('Token kind')).toBeVisible();
	expect(reads).toEqual([]);
	const kinds = page.getByRole('group', { name: 'Token kind' });
	await expect(page.getByRole('link', { name: 'offers', exact: true })).toBeVisible();
	await page.screenshot({ path: info.outputPath('public-choose.png') });
	await kinds.getByRole('link', { name: 'Eggs' }).click();
	await expect(kinds.locator('[aria-current="true"]')).toHaveText('Eggs');
	await expect(page).toHaveURL(
		(url) => url.pathname === '/' && url.searchParams.get(TRAIT_CATALOG_QUERY.View) === view.id
	);
	await expect(page.getByText('type = egg', { exact: true })).toHaveCount(0);
	await page.screenshot({ path: info.outputPath('public-eggs.png') });
	expect(new URL(page.url()).pathname).toBe('/');
	expect(reads).toEqual(['egg']);
	await expect(page.getByRole('link', { name: 'customization', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Rebuild traits' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'bid on traits' })).toHaveCount(0);
});
