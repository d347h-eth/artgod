import { BIDDING_E2E_COMPETITION_PRESET_ID } from '../src/lib/e2e/bidding-automation-fixtures';
import { BIDDING_JOB_REAPPLY_ACTION_KEY } from '../src/lib/action-confirmation';
import {
	buildCompetitionPresetReapplyPreviewPath,
	buildCompetitionPresetReapplyPath
} from '@artgod/shared/http/trading-routes';
import { expect, test, type Locator, type Page } from 'playwright/test';
import { COLLECTION_MEDIA_MODES, COLLECTION_MEDIA_QUERY_PARAMS } from '@artgod/shared/extensions';
import {
	COLLECTION_BIDDING_BID_SCOPE_FILTER,
	COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS,
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER,
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS,
	COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER,
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
	TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
	TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
	TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
	TRADING_BIDDING_TIER_SELECTION_MODE,
	TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
	TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
	TRADING_BIDDING_PRICE_TIER_DELTA_KIND,
	TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND,
	TRADING_JOB_STATUS,
	TRADING_JOB_TARGET_KIND
} from '@artgod/shared/types';
import type { TradingBiddingBidBookOwnState } from '@artgod/shared/types';
import { DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG } from '@artgod/shared/config/bidding';
import { BID_BOOK_FILTER_LABEL } from '../src/lib/bid-book-view-models';
import { LOCAL_STORAGE_KEYS } from '../src/lib/local-storage-keys';
import { TOKEN_BROWSER_STATUS } from '@artgod/shared/types/browse';
import {
	TERRAFORMS_MODE_ATTRIBUTE_KEY,
	TERRAFORMS_MODE_ATTRIBUTE_VALUES,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES
} from '@artgod/shared/extensions/terraforms';
import { BIDDING_SELECTION_ACTION_LABEL } from '../src/lib/bidding-selection-actions';
import {
	BID_BOOK_MAKER_QUERY_PARAM,
	BID_BOOK_OWNERSHIP_QUERY_PARAM,
	BID_SCOPE_QUERY_PARAM
} from '../src/lib/bidding-query';
import { TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_DOM } from '../src/lib/bid-book-trait-previews/terraforms/preview-model';
import {
	TERRAFORMS_BIOME_CHARACTER_BAND_DOM,
	TERRAFORMS_ZONE_PALETTE_BAND_DOM
} from '../src/lib/collection-extension-pages/terraforms/trait-previews';
import { TEST_IDS } from '../src/lib/test-ids';
import {
	attachDiagnosticsForTestFailure,
	captureDiagnosticsForTest,
	type PageDiagnosticsRegistry
} from './attached-app';
import { installBiddingAutomationApiMock } from './helpers/bidding-automation-api';
import {
	BIDDING_E2E_FIRST_RUN_INTENT,
	BIDDING_E2E_UNCONFIRMED_BID,
	BIDDING_E2E_FACETS,
	BIDDING_E2E_HOLDER_ADDRESS,
	BIDDING_E2E_COMPETITION_PRESETS,
	BIDDING_E2E_REAPPLY_JOB_ID,
	BIDDING_E2E_CHAIN,
	BIDDING_E2E_COLLECTION,
	buildBiddingE2eCompetitionReapplyFixture,
	BIDDING_E2E_OWN_STATE_OPPONENT_ORDER_IDS,
	BIDDING_E2E_SCENARIO,
	BIDDING_E2E_SCENARIO_QUERY_PARAM,
	biddingCompetitionPresetFixture,
	findBiddingE2eJobForTarget
} from '../src/lib/e2e/bidding-automation-fixtures';

const COLLECTION_PATH = '/e2e-harness/collection';
const BIDDING_PATH = `${COLLECTION_PATH}/bidding`;
const MARKET_MAKER_A = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CANCELLATION_PHASE_SCENARIO_QUERY = `${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.CancellationPhases}`;
const AUTHORIZATION_REQUIRED_SCENARIO_QUERY = `${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.AuthorizationRequired}`;
const FIRST_RUN_INTENT_SCENARIO_QUERY = `${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.FirstRunIntent}`;
const diagnosticsByTest: PageDiagnosticsRegistry = new Map();

test.beforeEach(({ page }, testInfo) => {
	captureDiagnosticsForTest(diagnosticsByTest, page, testInfo);
});

test.afterEach(async ({}, testInfo) => {
	await attachDiagnosticsForTestFailure(diagnosticsByTest, testInfo);
});

test.describe('bidding automation fixture harness', () => {
	for (const scope of [
		COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
		COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
	]) {
		test(`initializes fresh direct ${scope} entry to My bids and active`, async ({
			page
		}, testInfo) => {
			await installBiddingAutomationApiMock(page);
			await openHarnessPage(page, COLLECTION_PATH);
			expect(
				await page.evaluate(
					(key) => localStorage.getItem(key),
					LOCAL_STORAGE_KEYS.collectionBiddingNavigationPreferences
				)
			).toBeNull();
			await openHarnessPage(
				page,
				`${BIDDING_PATH}?${COLLECTION_MEDIA_QUERY_PARAMS.MediaMode}=${COLLECTION_MEDIA_MODES.Snapshot}&${BID_SCOPE_QUERY_PARAM}=${scope}`
			);
			await expect(page).toHaveURL(
				new RegExp(
					`${BID_BOOK_OWNERSHIP_QUERY_PARAM}=${COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own}`
				)
			);
			const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
			await expect(tabs.locator('[aria-current="true"]')).toContainText('active [');
			await expect(
				page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.OwnBids, exact: true })
			).toBeDisabled();
			const query = new URL(page.url()).searchParams;
			expect(query.get(BID_SCOPE_QUERY_PARAM)).toBe(scope);
			expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
				COLLECTION_MEDIA_MODES.Snapshot
			);
			expect(query.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)).toBe(
				COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active
			);
			await page.screenshot({
				path: testInfo.outputPath(`direct-${scope}-my-active.png`),
				fullPage: true
			});
			await page.reload();
			await expect(tabs.locator('[aria-current="true"]')).toContainText('active [');
			await page.getByRole('link', { name: 'asks', exact: true }).click();
			await page.getByRole('link', { name: 'offers', exact: true }).click();
			await expect(tabs.locator('[aria-current="true"]')).toContainText('active [');
			await expect(
				page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.OwnBids, exact: true })
			).toBeDisabled();
		});
	}

	test('initializes legacy scope-only entry and keeps empty active selected beside paused', async ({
		page
	}, testInfo) => {
		await page.addInitScript(
			({ key, scope }) => {
				if (!localStorage.getItem(key))
					localStorage.setItem(key, JSON.stringify({ bidScope: scope }));
			},
			{
				key: LOCAL_STORAGE_KEYS.collectionBiddingNavigationPreferences,
				scope: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
			}
		);
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${COLLECTION_MEDIA_QUERY_PARAMS.MediaMode}=${COLLECTION_MEDIA_MODES.Snapshot}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStatesOnlyPaused}`
		);
		const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
		await expect(tabs.locator('a, .secondary-tab-active, button')).toHaveText([
			'active [0]',
			'paused [3]',
			BID_BOOK_FILTER_LABEL.ResetOwnState
		]);
		await expect(tabs.locator('[aria-current="true"]')).toHaveText('active [0]');
		await expect(
			page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.OwnBids, exact: true })
		).toBeDisabled();
		expect(new URL(page.url()).searchParams.get(BID_SCOPE_QUERY_PARAM)).toBe(
			COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
		);
		await page.screenshot({
			path: testInfo.outputPath('direct-legacy-active-zero.png'),
			fullPage: true
		});
		await tabs.getByRole('link', { name: 'paused [3]', exact: true }).click();
		await expect(tabs.locator('[aria-current="true"]')).toHaveText('paused [3]');
		await expect(page.locator('.bid-book-empty')).toHaveCount(0);
	});

	test('rejects collection-scoped own-state URLs and recovers through browser back', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStates}`
		);
		const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
		await expect(tabs.locator('[aria-current="true"]')).toContainText('active [');
		const validUrl = page.url();
		const invalidQuery = new URLSearchParams({
			[BID_SCOPE_QUERY_PARAM]: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
			[COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState]:
				TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused
		});
		await page.goto(`${BIDDING_PATH}?${invalidQuery}`);
		await expect(page.getByRole('heading', { name: '400', exact: true })).toBeVisible();
		await expect(
			page.getByText('Use token or trait bids to filter by own bid state')
		).toBeVisible();
		expect(new URL(page.url()).searchParams.toString()).toBe(invalidQuery.toString());
		await page.screenshot({
			path: testInfo.outputPath('collection-own-state-invalid-url.png'),
			fullPage: true
		});
		await page.goBack();
		await expect(page).toHaveURL(validUrl);
		await expect(tabs.locator('[aria-current="true"]')).toContainText('active [');
		await page.screenshot({
			path: testInfo.outputPath('collection-own-state-recovered.png'),
			fullPage: true
		});
	});

	test('suspends own state in collection scope and keeps refresh consistent', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page);
		await page.clock.install();
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active}`
		);
		await expect(page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState })).toBeVisible();
		await page.getByRole('link', { name: 'collection', exact: true }).click();
		await expect(page).toHaveURL(
			new RegExp(`${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection}`)
		);
		expect(
			new URL(page.url()).searchParams.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)
		).toBe(false);
		await expect(page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState })).toHaveCount(0);
		const rows = metaValue(page.locator('.bid-book-meta'), 'rows');
		const beforeRefresh = await rows.innerText();
		const refreshResponse = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return (
				response.request().method() === 'GET' &&
				url.pathname.endsWith('/bidding/bids') &&
				url.searchParams.get(BID_SCOPE_QUERY_PARAM) ===
					COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection
			);
		});
		await page.clock.fastForward(DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs);
		const response = await refreshResponse;
		expect(response.status()).toBe(200);
		expect(
			new URL(response.url()).searchParams.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)
		).toBe(false);
		await expect(rows).toHaveText(beforeRefresh);
		await page.screenshot({
			path: testInfo.outputPath('collection-own-state-switch-refreshed.png'),
			fullPage: true
		});
	});

	test('defaults fresh Offers navigation to My bids and active and remembers reset and All bids', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, COLLECTION_PATH);
		await page.getByRole('link', { name: 'offers', exact: true }).click();
		const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
		await expect(tabs.locator('[aria-current="true"]')).toContainText('active [');
		expect(new URL(page.url()).searchParams.get(BID_BOOK_OWNERSHIP_QUERY_PARAM)).toBe(
			COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own
		);
		expect(
			new URL(page.url()).searchParams.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)
		).toBe(COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active);
		await expect(
			page
				.getByRole('button', { name: BID_BOOK_FILTER_LABEL.OwnBids, exact: true })
				.locator('..')
				.locator('a, button')
		).toHaveText([BID_BOOK_FILTER_LABEL.OwnBids, BID_BOOK_FILTER_LABEL.AllBids]);
		await expect(tabs.locator(':scope > :last-child')).toHaveText(
			BID_BOOK_FILTER_LABEL.ResetOwnState
		);
		await page.screenshot({
			path: testInfo.outputPath('offers-default-my-active.png'),
			fullPage: true
		});
		await tabs
			.getByRole('button', { name: BID_BOOK_FILTER_LABEL.ResetOwnState, exact: true })
			.click();
		await expect(tabs.locator('[aria-current="true"]')).toHaveCount(0);
		expect(
			new URL(page.url()).searchParams.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)
		).toBe(false);
		expect(new URL(page.url()).searchParams.get(BID_BOOK_OWNERSHIP_QUERY_PARAM)).toBe(
			COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own
		);
		await page.getByRole('link', { name: 'asks', exact: true }).click();
		await page.getByRole('link', { name: 'offers', exact: true }).click();
		await expect(
			page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.OwnBids, exact: true })
		).toBeDisabled();
		expect(
			new URL(page.url()).searchParams.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)
		).toBe(false);
		await page.getByRole('link', { name: BID_BOOK_FILTER_LABEL.AllBids, exact: true }).click();
		await expect(
			page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.AllBids, exact: true })
		).toBeDisabled();
		await page.getByRole('link', { name: 'asks', exact: true }).click();
		await page.getByRole('link', { name: 'offers', exact: true }).click();
		await expect(
			page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.AllBids, exact: true })
		).toBeDisabled();
		const query = new URL(page.url()).searchParams;
		expect(query.has(BID_BOOK_OWNERSHIP_QUERY_PARAM)).toBe(false);
		expect(query.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)).toBe(false);
		// A direct visit after an intentional All/reset choice stays unfiltered.
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Token}`
		);
		await expect(
			page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.AllBids, exact: true })
		).toBeDisabled();
		await expect(tabs.locator('[aria-current="true"]')).toHaveCount(0);
	});

	test('restores trait scope on Offers navigation and keeps active zero beside three paused jobs', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page);
		// Retain the paused-only fixture across a visit to the main navigation.
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}&${BID_BOOK_OWNERSHIP_QUERY_PARAM}=${COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStatesOnlyPaused}`
		);
		await page.getByRole('link', { name: 'asks', exact: true }).click();
		await page.getByRole('link', { name: 'offers', exact: true }).click();
		const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
		await expect(tabs.locator('a, .secondary-tab-active, button')).toHaveText([
			'active [0]',
			'paused [3]',
			BID_BOOK_FILTER_LABEL.ResetOwnState
		]);
		await expect(tabs.locator('[aria-current="true"]')).toHaveText('active [0]');
		await expect(page.locator('.bid-book-empty')).toBeVisible();
		expect(new URL(page.url()).searchParams.get(BID_SCOPE_QUERY_PARAM)).toBe(
			COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
		);
		await page.screenshot({
			path: testInfo.outputPath('offers-active-zero-paused-three.png'),
			fullPage: true
		});
		await tabs.getByRole('link', { name: 'paused [3]', exact: true }).click();
		await expect(tabs.locator('[aria-current="true"]')).toHaveText('paused [3]');
		await page.getByRole('link', { name: 'asks', exact: true }).click();
		await page.getByRole('link', { name: 'offers', exact: true }).click();
		await expect(tabs.locator('[aria-current="true"]')).toHaveText('paused [3]');
		await tabs
			.getByRole('button', { name: BID_BOOK_FILTER_LABEL.ResetOwnState, exact: true })
			.click();
		await expect(tabs.locator('a, .secondary-tab-active, button')).toHaveText(['paused [3]']);
		await expect(metaValue(page.locator('.bid-book-meta'), 'rows')).toHaveText('3');
		await expect(page.locator('.bid-book-empty')).toHaveCount(0);
	});

	for (const scope of [
		COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
		COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
	]) {
		test(`preserves ${scope} state and reset through collection scope buttons`, async ({
			page
		}, testInfo) => {
			await installBiddingAutomationApiMock(page);
			// Assert the initial fixture after reload without a polling response repairing it.
			let releaseRefresh!: () => void;
			const heldRefresh = new Promise<void>((resolve) => {
				releaseRefresh = resolve;
			});
			await page.route('**/bidding/bids?**', async (route) => {
				await heldRefresh;
				await route.fallback();
			});
			try {
				await openHarnessPage(
					page,
					`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${scope}&${BID_BOOK_OWNERSHIP_QUERY_PARAM}=${COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.ShowMuted}=true&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStates}`
				);
				const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
				await expect(tabs.locator('[aria-current="true"]')).toHaveText('losing [1]');
				const otherScope =
					scope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token
						? COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
						: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token;
				for (const nextScope of [scope, otherScope]) {
					await page.getByRole('link', { name: 'collection', exact: true }).click();
					await expect(tabs).toHaveCount(0);
					expect(
						new URL(page.url()).searchParams.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)
					).toBe(false);
					// The suspended selection also survives a reload of the collection view.
					await page.reload();
					await expect(page.locator('.bid-book-meta')).toBeVisible();
					await page.getByRole('link', { name: nextScope, exact: true }).click();
					await expect(tabs.locator('[aria-current="true"]')).toHaveText('losing [1]');
					const query = new URL(page.url()).searchParams;
					expect(query.get(BID_SCOPE_QUERY_PARAM)).toBe(nextScope);
					expect(query.get(BID_BOOK_OWNERSHIP_QUERY_PARAM)).toBe(
						COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own
					);
					expect(query.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)).toBe(
						TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing
					);
					expect(query.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.ShowMuted)).toBe('true');
				}
				await page.screenshot({
					path: testInfo.outputPath(`scope-${scope}-state-resumed.png`),
					fullPage: true
				});
				await tabs
					.getByRole('button', { name: BID_BOOK_FILTER_LABEL.ResetOwnState, exact: true })
					.click();
				await expect(tabs.locator('[aria-current="true"]')).toHaveCount(0);
				await page.getByRole('link', { name: 'collection', exact: true }).click();
				await expect(tabs).toHaveCount(0);
				await page.getByRole('link', { name: scope, exact: true }).click();
				await expect(tabs).toBeVisible();
				await expect(tabs.locator('[aria-current="true"]')).toHaveCount(0);
				await expect(
					tabs.getByRole('button', { name: BID_BOOK_FILTER_LABEL.ResetOwnState, exact: true })
				).toHaveCount(0);
				expect(
					new URL(page.url()).searchParams.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)
				).toBe(false);
				await page.screenshot({
					path: testInfo.outputPath(`scope-${scope}-reset-retained.png`),
					fullPage: true
				});
			} finally {
				releaseRefresh();
			}
		});

		test(`preserves ${scope} status when applying and clearing a maker filter`, async ({
			page
		}) => {
			await installBiddingAutomationApiMock(page);
			await openHarnessPage(
				page,
				`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${scope}&${BID_BOOK_OWNERSHIP_QUERY_PARAM}=${COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.ShowMuted}=true&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStates}`
			);
			const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('losing [1]');
			const makerInput = page.getByRole('textbox', {
				name: 'Filter bids by maker address or ENS name'
			});
			await makerInput.fill(MARKET_MAKER_A);
			await makerInput.press('Enter');
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('losing [0]');
			const query = new URL(page.url()).searchParams;
			expect(query.get(BID_BOOK_MAKER_QUERY_PARAM)).toBe(MARKET_MAKER_A);
			expect(query.has(BID_BOOK_OWNERSHIP_QUERY_PARAM)).toBe(false);
			expect(query.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)).toBe(
				TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing
			);
			expect(query.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.ShowMuted)).toBe('true');
			await expect(page.locator('.bid-book-empty')).toBeVisible();
			await page.getByRole('button', { name: 'clear maker filter', exact: true }).click();
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('losing [1]');
			expect(new URL(page.url()).searchParams.has(BID_BOOK_MAKER_QUERY_PARAM)).toBe(false);
		});

		test(`filters every own bid state in ${scope} scope with stable overlapping counts`, async ({
			page
		}, testInfo) => {
			await installBiddingAutomationApiMock(page);
			await page.clock.install();
			await openHarnessPage(
				page,
				`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${scope}&${BID_BOOK_OWNERSHIP_QUERY_PARAM}=${COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.ShowMuted}=true&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStates}`
			);
			const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
			await expect(tabs.locator('a, .secondary-tab-active')).toHaveText([
				'active [12]',
				'waiting for bot [1]',
				'verifying [1]',
				'unconfirmed [1]',
				'queued [1]',
				'authorization required [1]',
				'authorization unavailable [1]',
				'replacing [1]',
				'canceling [1]',
				'cancel failed [1]',
				'cancelled [1]',
				'winning [1]',
				'draw [1]',
				'losing [1]',
				'at ceiling [1]',
				'at floor [1]',
				'unknown [1]',
				'paused [3]'
			]);
			await testInfo.attach(`own-bid-states-${scope}.png`, {
				body: await page.screenshot({
					path: testInfo.outputPath(`own-bid-states-${scope}.png`),
					fullPage: true
				}),
				contentType: 'image/png'
			});
			if (scope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
				await page.getByRole('link', { name: 'load next', exact: true }).click();
				await expect(tokenCard(page, '104')).toBeVisible();
				await expect(tabs).toContainText('active [12]');
				expect(
					new URL(page.url()).searchParams.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.ShowMuted)
				).toBe('true');
			}
			for (const state of COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS) {
				const link = tabs.locator(
					`a[href*="${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${state}"]`
				);
				await link.click();
				await expect(page).toHaveURL(
					new RegExp(`${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${state}`)
				);
				await expect(tabs.locator('[aria-current="true"]')).toBeVisible();
				await expect(tabs).toContainText('active [12]');
				if (state === COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active) {
					await expect(
						page.locator(ownStatusSelector(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused))
					).toHaveCount(0);
					await page.screenshot({
						path: testInfo.outputPath(`own-bid-states-${scope}-active.png`),
						fullPage: true
					});
				} else {
					await expect(page.locator(ownStatusSelector(state)).first()).toBeVisible();
				}
				const matchingRows =
					state === COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active
						? '12'
						: state === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused
							? '3'
							: '1';
				if (scope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits) {
					await expect(metaValue(page.locator('.bid-book-meta'), 'rows')).toHaveText(matchingRows);
				} else {
					await expect(metaValue(page.locator('.bid-book-meta'), 'offers')).toHaveText(
						matchingRows
					);
				}
				if (state === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused) {
					await page.screenshot({
						path: testInfo.outputPath(`own-bid-states-${scope}-paused.png`),
						fullPage: true
					});
				}
				expect(new URL(page.url()).searchParams.get('cursor')).toBeNull();
			}
			await page.screenshot({
				path: testInfo.outputPath(`own-bid-states-${scope}-selected.png`),
				fullPage: true
			});
			expect(new URL(page.url()).searchParams.get(BID_BOOK_OWNERSHIP_QUERY_PARAM)).toBe(
				COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own
			);
			await expect(tabs).toContainText('active [12]');
		});

		test(`refreshes ${scope} state counts and allows choosing another state after no matches`, async ({
			page
		}, testInfo) => {
			const api = await installBiddingAutomationApiMock(page);
			await page.clock.install();
			await openHarnessPage(
				page,
				`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${scope}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Winning}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStates}`
			);
			const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('winning [1]');
			const selectedUrl = page.url();
			api.setBidBookScenario(BIDDING_E2E_SCENARIO.OwnBidStatesUpdated);
			await page.clock.fastForward(DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs);
			await expect(tabs.getByText('winning [0]', { exact: true })).toBeVisible();
			await expect(tabs.getByText('waiting for bot', { exact: false })).toHaveCount(0);
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('winning [0]');
			expect(page.url()).toBe(selectedUrl);
			await expect(tabs).toContainText('verifying [2]');
			await expect(tabs).toContainText('losing [2]');
			await expect(page.locator('.bid-book-empty')).toHaveText(
				scope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token ? 'no token offers' : 'no bids'
			);
			if (scope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits) {
				await expect(metaValue(page.locator('.bid-book-meta'), 'rows')).toHaveText('0');
			}
			await testInfo.attach(`own-bid-states-${scope}-empty.png`, {
				body: await page.screenshot({
					path: testInfo.outputPath(`own-bid-states-${scope}-empty.png`),
					fullPage: true
				}),
				contentType: 'image/png'
			});
			await tabs.getByRole('link', { name: 'active [12]', exact: true }).click();
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('active [12]');
			await page.clock.fastForward(DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs);
			await expect(page.locator('.bid-book-empty')).toHaveCount(0);
		});

		test(`keeps ownership and own state independent in ${scope} scope with opponent context`, async ({
			page
		}, testInfo) => {
			await rememberUnfilteredBiddingNavigation(page);
			await installBiddingAutomationApiMock(page);
			await page.clock.install();
			await openHarnessPage(
				page,
				`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${scope}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStates}`
			);
			const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
			const opponentIds = BIDDING_E2E_OWN_STATE_OPPONENT_ORDER_IDS[scope];
			const matchedOpponent = page.locator(
				`tr:has([data-open-sea-order-hash="${opponentIds.Matching}"])`
			);
			const otherOpponent = page.locator(
				`tr:has([data-open-sea-order-hash="${opponentIds.Other}"])`
			);
			const expectOpponentContext = async (present: boolean) => {
				if (scope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits) {
					if (present) await expect(matchedOpponent).toBeVisible();
					else await expect(matchedOpponent).toHaveCount(0);
					await expect(otherOpponent).toHaveCount(0);
				} else {
					const card = tokenCard(page, '101');
					await expect(card.locator('.token-grid-secondary-meta')).toHaveText(
						present ? '2 offers' : '1 offer'
					);
					await expect(card.locator('.bid-price')).toContainText(
						present ? '0.35 WETH' : '0.3 WETH'
					);
					await expect(tokenCard(page, '103')).toHaveCount(0);
				}
			};
			const assertSelection = (state: string, ownership: string | null) => {
				const query = new URL(page.url()).searchParams;
				expect(query.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)).toBe(state);
				expect(query.get(BID_BOOK_OWNERSHIP_QUERY_PARAM)).toBe(ownership);
			};
			await tabs.getByRole('link', { name: 'losing [1]', exact: true }).click();
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('losing [1]');
			assertSelection(TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing, null);
			await expect(
				page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.AllBids, exact: true })
			).toBeDisabled();
			await expectOpponentContext(true);
			await expect(
				page.locator(ownStatusSelector(TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Winning))
			).toHaveCount(0);
			await expect(tabs).toContainText('active [12]');
			await testInfo.attach(`own-state-${scope}-with-opponents.png`, {
				body: await page.screenshot({
					path: testInfo.outputPath(`own-state-${scope}-with-opponents.png`),
					fullPage: true
				}),
				contentType: 'image/png'
			});
			await page.getByRole('link', { name: BID_BOOK_FILTER_LABEL.OwnBids, exact: true }).click();
			await expect(
				page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.OwnBids, exact: true })
			).toBeDisabled();
			assertSelection(
				TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
				COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own
			);
			await expectOpponentContext(false);
			await expect(tabs).toContainText('active [12]');
			await page.screenshot({
				path: testInfo.outputPath(`own-state-${scope}-own-only.png`),
				fullPage: true
			});
			await tabs.getByRole('link', { name: 'at ceiling [1]', exact: true }).click();
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('at ceiling [1]');
			assertSelection(
				TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling,
				COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own
			);
			await page.getByRole('link', { name: BID_BOOK_FILTER_LABEL.AllBids, exact: true }).click();
			await expectOpponentContext(true);
			assertSelection(TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling, null);
		});

		test(`keeps an empty active tab selected in ${scope} scope without moving the user`, async ({
			page
		}, testInfo) => {
			const api = await installBiddingAutomationApiMock(page);
			await page.clock.install();
			await openHarnessPage(
				page,
				`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${scope}&${BID_BOOK_OWNERSHIP_QUERY_PARAM}=${COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStates}`
			);
			const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('active [12]');
			const selectedUrl = page.url();
			api.setBidBookScenario(BIDDING_E2E_SCENARIO.OwnBidStatesPaused);
			await page.clock.fastForward(DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs);
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('active [0]');
			await expect(
				tabs.getByRole('button', { name: BID_BOOK_FILTER_LABEL.ResetOwnState, exact: true })
			).toBeVisible();
			await expect(tabs).toContainText('paused [12]');
			await expect(page.locator('.bid-book-empty')).toBeVisible();
			expect(page.url()).toBe(selectedUrl);
			await page.screenshot({
				path: testInfo.outputPath(`own-state-${scope}-active-empty.png`),
				fullPage: true
			});
			await tabs.getByRole('link', { name: 'paused [12]', exact: true }).click();
			await expect(page).toHaveURL(
				new RegExp(
					`${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused}`
				)
			);
			expect(new URL(page.url()).searchParams.get(BID_BOOK_OWNERSHIP_QUERY_PARAM)).toBe(
				COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own
			);
			await page.clock.fastForward(DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs);
			await expect(page.locator('.bid-book-empty')).toHaveCount(0);
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('paused [12]');
			await expect(tabs.getByText('active', { exact: false })).toHaveCount(0);
		});

		test(`keeps only the selected ${scope} state tab when own rows disappear and allows reset`, async ({
			page
		}, testInfo) => {
			const api = await installBiddingAutomationApiMock(page);
			await page.clock.install();
			await openHarnessPage(
				page,
				`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${scope}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Winning}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStates}`
			);
			await expect(
				page.locator(ownStatusSelector(TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Winning))
			).toBeVisible();
			const selectedUrl = page.url();
			api.setBidBookScenario(BIDDING_E2E_SCENARIO.OwnBidStatesWithoutOwn);
			await page.clock.fastForward(DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs);
			await expect(page.locator('.bid-book-empty')).toBeVisible();
			const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
			await expect(tabs.locator('[aria-current="true"]')).toHaveText('winning [0]');
			await expect(tabs.locator('a, .secondary-tab-active, button')).toHaveText([
				'winning [0]',
				BID_BOOK_FILTER_LABEL.ResetOwnState
			]);
			expect(page.url()).toBe(selectedUrl);
			await page.screenshot({
				path: testInfo.outputPath(`own-state-${scope}-no-own-rows.png`),
				fullPage: true
			});
			await tabs
				.getByRole('button', { name: BID_BOOK_FILTER_LABEL.ResetOwnState, exact: true })
				.click();
			await expect(page).not.toHaveURL(
				new RegExp(`${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=`)
			);
			await expect(
				tabs.getByRole('button', { name: BID_BOOK_FILTER_LABEL.ResetOwnState, exact: true })
			).toHaveCount(0);
			await page.clock.fastForward(DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs);
			await expect(tabs).toHaveCount(0);
			await expect(page.locator('.bid-book-empty')).toHaveCount(0);
			expect(
				new URL(page.url()).searchParams.has(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState)
			).toBe(false);
		});
	}

	test('restores a selected zero-count state through scope buttons', async ({ page }, testInfo) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}&${BID_BOOK_OWNERSHIP_QUERY_PARAM}=${COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStatesOnlyPaused}`
		);
		const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
		await expect(tabs.locator('[aria-current="true"]')).toHaveText('active [0]');
		await page.getByRole('link', { name: 'collection', exact: true }).click();
		await expect(tabs).toHaveCount(0);
		await page.getByRole('link', { name: 'traits', exact: true }).click();
		await expect(tabs.locator('[aria-current="true"]')).toHaveText('active [0]');
		await expect(tabs.getByRole('link', { name: 'paused [3]', exact: true })).toBeVisible();
		await expect(page.locator('.bid-book-empty')).toBeVisible();
		await page.screenshot({
			path: testInfo.outputPath('scope-active-zero-resumed.png'),
			fullPage: true
		});
	});

	test('preserves scope-button state when preference storage cannot write', async ({ page }) => {
		await page.addInitScript((storageKey) => {
			const setItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key, value) {
				if (key === storageKey) throw new Error('Preference storage unavailable');
				setItem.call(this, key, value);
			};
		}, LOCAL_STORAGE_KEYS.collectionBiddingNavigationPreferences);
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Token}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStates}`
		);
		const tabs = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.OwnState });
		await expect(tabs.locator('[aria-current="true"]')).toHaveText('losing [1]');
		await page.getByRole('link', { name: 'collection', exact: true }).click();
		await expect(tabs).toHaveCount(0);
		await page.getByRole('link', { name: 'traits', exact: true }).click();
		await expect(tabs.locator('[aria-current="true"]')).toHaveText('losing [1]');
		await tabs
			.getByRole('button', { name: BID_BOOK_FILTER_LABEL.ResetOwnState, exact: true })
			.click();
		await expect(tabs.locator('[aria-current="true"]')).toHaveCount(0);
		await expect(
			page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.AllBids, exact: true })
		).toBeDisabled();
		await page.getByRole('link', { name: 'asks', exact: true }).click();
		await page.getByRole('link', { name: 'offers', exact: true }).click();
		await expect(tabs.locator('[aria-current="true"]')).toHaveCount(0);
		await expect(
			page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.AllBids, exact: true })
		).toBeDisabled();
	});

	for (const state of [
		COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active,
		TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing
	]) {
		test(`carries ${state} into an all-results token bidding action`, async ({ page }) => {
			const api = await installBiddingAutomationApiMock(page);
			await openHarnessPage(
				page,
				`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Token}&${COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState}=${state}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.OwnBidStates}&traits=Zone:Shahra&traits=Biome:42`
			);
			await expect(tokenCard(page, '101')).toBeVisible();
			await expect(tokenCard(page, '102')).toHaveCount(0);
			await page
				.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnAllTokens })
				.click();
			await expect(page.getByText('1 tokens selected')).toBeVisible();
			await fillManualPrice(page, { floor: '0.210', ceiling: '0.260', delta: '0.004' });
			await confirmPanelAction(page, TEST_IDS.BiddingPanelCreate);
			expect((await api.nextMutation()).body).toMatchObject({
				selection: {
					type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter,
					ownStateFilter: state,
					traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
				}
			});
		});
	}

	test('shows extra targets management only in traits view mode', async ({ page }, testInfo) => {
		await installBiddingAutomationApiMock(page);
		const toggle = page.getByRole('button', {
			name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras,
			exact: true
		});
		for (const path of [
			COLLECTION_PATH,
			`${BIDDING_PATH}?bid_scope=token`,
			`${BIDDING_PATH}?bid_scope=collection`
		]) {
			await openHarnessPage(page, path);
			await expect(toggle).toHaveCount(0);
			await expect(page.getByRole('region', { name: 'extra targets presets' })).toHaveCount(0);
		}
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByRole('region', { name: 'extra targets presets' })).toBeVisible();
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-traits-entry.png'),
			fullPage: true
		});
		await page.getByRole('link', { name: 'token', exact: true }).click();
		await expect(toggle).toHaveCount(0);
		await expect(page.getByRole('region', { name: 'extra targets presets' })).toHaveCount(0);
	});

	test('aligns extra target preset controls and keeps field help accessible', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits&traits=Zone:Shahra`);
		await page
			.getByRole('button', {
				name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras,
				exact: true
			})
			.click();
		const inventory = page.getByRole('region', { name: 'extra targets presets' });
		const refresh = await inventory
			.getByRole('button', { name: 'refresh', exact: true })
			.boundingBox();
		const hide = await inventory.getByRole('button', { name: 'hide', exact: true }).boundingBox();
		expect(refresh).not.toBeNull();
		expect(hide).not.toBeNull();
		expect(Math.abs(refresh!.height - hide!.height)).toBeLessThanOrEqual(1);
		for (const id of ['extra-target-source-key-1', 'extra-target-extra-key-1']) {
			await expectFieldCenterAligned(inventory, id);
		}
		const source = inventory.getByRole('group', { name: 'source target', exact: true });
		const extras = inventory.getByRole('group', { name: 'extra target', exact: true });
		for (const [group, name] of [
			[source, 'source'],
			[extras, 'extras']
		] as const) {
			const help = group.getByRole('button', { name: 'Help', exact: true });
			const popup = group.getByRole('tooltip');
			if (testInfo.project.use.hasTouch) {
				await help.tap();
				await expect(help).not.toBeFocused();
			} else await help.hover();
			await expect(popup).toBeVisible();
			await expect(popup).toBeInViewport({ ratio: 1 });
			await page.screenshot({ path: testInfo.outputPath(`extra-targets-${name}-help.png`) });
			if (testInfo.project.use.hasTouch) await page.keyboard.press('Escape');
			else await help.press('Escape');
			await expect(popup).toBeHidden();
			if (testInfo.project.use.hasTouch) {
				await help.tap();
				await expect(help).not.toBeFocused();
				await expect(popup).toBeVisible();
				await inventory.getByRole('heading', { name: 'extra targets', exact: true }).tap();
				await expect(popup).toBeHidden();
			}
			await help.press('Enter');
			await expect(help).toBeFocused();
			await expect(popup).toBeVisible();
			await expect(popup).toBeInViewport({ ratio: 1 });
			await help.press('Escape');
			await expect(popup).toBeHidden();
		}
		await source.getByRole('button', { name: 'add', exact: true }).click();
		await expectFieldCenterAligned(inventory, 'extra-target-source-key-1');
		await source.getByRole('button', { name: 'remove source target 2', exact: true }).click();
		await source.getByRole('button', { name: 'remove source target 1', exact: true }).click();
		await expect(source.getByRole('button', { name: 'Help', exact: true })).toBeVisible();
		await source.getByRole('button', { name: 'Help', exact: true }).press('Enter');
		await expect(source.getByRole('tooltip')).toBeInViewport({ ratio: 1 });
		await source.getByRole('button', { name: 'Help', exact: true }).press('Escape');
		await source.getByRole('button', { name: 'add', exact: true }).click();
		await expectFieldCenterAligned(inventory, 'extra-target-source-key-1');
		const row = inventory.getByRole('row').filter({ hasText: 'Biome=42' });
		const textCenter = await row
			.getByRole('cell')
			.first()
			.evaluate((cell) => {
				const range = document.createRange();
				range.selectNodeContents(cell);
				const bounds = range.getBoundingClientRect();
				return bounds.y + bounds.height / 2;
			});
		const archive = await row.getByRole('button', { name: 'archive', exact: true }).boundingBox();
		expect(archive).not.toBeNull();
		expect(Math.abs(textCenter - (archive!.y + archive!.height / 2))).toBeLessThanOrEqual(2);
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-centered-controls.png'),
			fullPage: true
		});
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.Tiers, exact: true })
			.click();
		const tierForm = page
			.getByRole('heading', { name: 'price tiers', exact: true })
			.locator('..')
			.locator('..');
		const styles = (button: Locator) =>
			button.evaluate((element) => {
				const css = getComputedStyle(element);
				return {
					fontSize: css.fontSize,
					lineHeight: css.lineHeight,
					height: css.height,
					padding: css.padding,
					color: css.color,
					border: css.borderTopColor,
					background: css.backgroundColor,
					textTransform: css.textTransform
				};
			});
		expect(await styles(inventory.getByRole('button', { name: 'reset', exact: true }))).toEqual(
			await styles(tierForm.getByRole('button', { name: 'reset', exact: true }))
		);
		await inventory.getByRole('button', { name: 'reset', exact: true }).click();
		await source.getByRole('combobox', { name: 'source target key 1' }).selectOption('Zone');
		await source.getByRole('combobox', { name: 'source target value 1' }).click();
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-flat-values.png'),
			fullPage: true
		});
		await page.keyboard.press('Escape');
	});

	test('applies two-pair wildcard source presets and distinguishes literal any metadata', async ({
		page
	}, testInfo) => {
		const api = await installBiddingAutomationApiMock(page);
		await page.route('**/traits/catalog**', (route) =>
			route.fulfill({
				json: {
					traitCatalog: {
						facets: BIDDING_E2E_FACETS.map((facet) => ({
							...facet,
							values: [
								...facet.values,
								{ value: 'any', tokenCount: 1, marketplaceBiddingSupported: true }
							]
						}))
					}
				}
			})
		);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?bid_scope=traits&traits=Mode:Terrain&traits=Zone:Shahra`
		);
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras, exact: true })
			.click();
		const inventory = page.getByRole('region', { name: 'extra targets presets' });
		const source = inventory.getByRole('group', { name: 'source target', exact: true });
		const extras = inventory.getByRole('group', { name: 'extra target', exact: true });
		await source.getByRole('combobox', { name: 'source target key 1' }).selectOption('Mode');
		const sourceValue = source.getByRole('combobox', { name: 'source target value 1' });
		await sourceValue.selectOption({ label: '"any"' });
		await expect(sourceValue).toHaveValue('value:any');
		await expect(sourceValue).not.toHaveClass(/trait-group-active/);
		await extras.getByRole('combobox', { name: 'extra target key 1' }).selectOption('Biome');
		const extraValue = extras.getByRole('combobox', { name: 'extra target value 1' });
		await extraValue.selectOption({ label: '"any"' });
		await expect(extraValue).toHaveValue('value:any');
		await expect(extraValue).not.toHaveClass(/trait-group-active/);
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-literal-any.png'),
			fullPage: true
		});
		await sourceValue.selectOption({ label: 'any (all)' });
		await expect(sourceValue).toHaveValue('*');
		await expect(sourceValue).toHaveClass(/trait-group-active/);
		await extraValue.selectOption({ label: 'any (all)' });
		await expect(extraValue).toHaveValue('*');
		await expect(extraValue).toHaveClass(/trait-group-active/);
		await source.getByRole('button', { name: 'add', exact: true }).click();
		await expect(source.getByRole('button', { name: 'add', exact: true })).toBeDisabled();
		await expect(
			source
				.getByRole('combobox', { name: 'source target key 2' })
				.getByRole('option', { name: 'Mode', exact: true })
		).toBeDisabled();
		await source.getByRole('combobox', { name: 'source target key 2' }).selectOption('Zone');
		await source
			.getByRole('combobox', { name: 'source target value 2' })
			.selectOption({ label: 'Shahra' });
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-wildcard-source.png'),
			fullPage: true
		});
		const create = inventory.getByRole('button', { name: 'create', exact: true });
		await create.click();
		await expect(create).toHaveClass(/token-bidding-action-armed/);
		await sourceValue.focus();
		await expect(create).not.toHaveClass(/token-bidding-action-armed/);
		await create.click();
		expect(api.mutations).toHaveLength(0);
		await create.click();
		expect((await api.nextMutation()).body).toMatchObject({
			targetTraits: [{ type: 'Mode' }, { type: 'Zone', value: 'Shahra' }],
			extraCompetitionTraits: [{ type: 'Biome' }]
		});
		const savedRow = inventory.getByRole('row').filter({ hasText: 'Mode=any + Zone=Shahra' });
		await savedRow.getByRole('button', { name: 'edit', exact: true }).click();
		await expect(source.getByRole('combobox')).toHaveCount(4);
		for (const control of await source.getByRole('combobox').all()) {
			await expect(control).toBeDisabled();
		}
		for (const name of ['add', 'remove source target 1', 'remove source target 2']) {
			await expect(source.getByRole('button', { name, exact: true })).toBeDisabled();
		}
		await expect(sourceValue).toHaveValue('*');
		await expect(source.getByRole('combobox', { name: 'source target value 2' })).toHaveValue(
			'value:Shahra'
		);
		await expect(extraValue).toBeEnabled();
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-wildcard-source-locked.png'),
			fullPage: true
		});
		await inventory.getByRole('button', { name: 'reset', exact: true }).click();
		await inventory.getByRole('button', { name: 'hide', exact: true }).click();
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnTraits, exact: true })
			.click();
		const options = page
			.getByTestId(TEST_IDS.BiddingPanel)
			.getByLabel('Extra targets', { exact: true });
		await expect(options.getByRole('button', { name: 'none', exact: true })).toBeDisabled();
		await options.getByRole('button', { name: 'Biome=any', exact: true }).click();
		await fillManualPrice(page, { floor: '0.310', ceiling: '0.410', delta: '0.004' });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelCreate);
		expect((await api.nextMutation()).body).toMatchObject({
			targetTraits: [
				{ type: 'Mode', value: 'Terrain' },
				{ type: 'Zone', value: 'Shahra' }
			],
			competitionPresetVersionId: `${BIDDING_E2E_COMPETITION_PRESET_ID.Created}:v1`
		});
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-wildcard-job-saved.png'),
			fullPage: true
		});
	});

	test('creates structured extra targets presets and selects, resets and clears a reference', async ({
		page
	}, testInfo) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits&traits=Zone:Shahra`);
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras, exact: true })
			.click();
		const inventory = page.getByRole('region', { name: 'extra targets presets' });
		await expect(inventory.getByRole('button', { name: 'create', exact: true })).toBeDisabled();
		await page.screenshot({ path: testInfo.outputPath('competition-presets-empty.png') });
		const targets = inventory.getByRole('group', { name: 'source target', exact: true });
		await targets
			.getByRole('combobox', { name: 'source target key 1', exact: true })
			.selectOption('Zone');
		await targets
			.getByRole('combobox', { name: 'source target value 1', exact: true })
			.selectOption({ label: 'Shahra' });
		const extras = inventory.getByRole('group', { name: 'extra target', exact: true });
		await extras
			.getByRole('combobox', { name: 'extra target key 1', exact: true })
			.selectOption('Mode');
		await extras
			.getByRole('combobox', { name: 'extra target value 1', exact: true })
			.selectOption({ label: 'Terrain' });
		await extras.getByRole('button', { name: 'add', exact: true }).click();
		await extras
			.getByRole('combobox', { name: 'extra target key 2', exact: true })
			.selectOption('Biome');
		await extras
			.getByRole('combobox', { name: 'extra target value 2', exact: true })
			.selectOption({ label: 'any (all)' });
		await expect(
			extras.getByRole('combobox', { name: 'extra target value 2', exact: true })
		).toHaveValue('*');
		await expect(inventory.getByRole('textbox')).toHaveCount(0);
		await page.screenshot({
			path: testInfo.outputPath('competition-presets-editable.png'),
			fullPage: true
		});
		await inventory.getByRole('button', { name: 'create', exact: true }).click();
		expect(api.mutations).toHaveLength(0);
		await inventory.getByRole('button', { name: 'create', exact: true }).click();
		expect((await api.nextMutation()).body).toMatchObject({
			targetTraits: [{ type: 'Zone', value: 'Shahra' }],
			extraCompetitionTraits: [{ type: 'Biome' }, { type: 'Mode', value: 'Terrain' }]
		});
		await expect(inventory.getByRole('row').filter({ hasText: 'Zone=Shahra' })).toContainText(
			'Biome=any + Mode=Terrain'
		);
		await page.screenshot({ path: testInfo.outputPath('competition-presets-saved.png') });
		await inventory.getByRole('button', { name: 'hide', exact: true }).click();
		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnTraits }).click();
		const panel = page.getByTestId(TEST_IDS.BiddingPanel);
		const options = panel.getByLabel('Extra targets', { exact: true });
		await expect(options.getByRole('button', { name: 'none', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(options.getByRole('button', { name: 'Mode=Terrain', exact: true })).toHaveCount(0);
		await expect(
			options.getByRole('button', { name: 'Biome=any + Mode=Terrain', exact: true })
		).toBeVisible();
		expect(
			await options
				.getByRole('button', { name: 'Biome=any + Mode=Terrain', exact: true })
				.evaluate((button) => button.scrollWidth <= button.clientWidth + 1)
		).toBe(true);
		await options.getByRole('button', { name: 'Biome=any + Mode=Terrain', exact: true }).click();
		await fillManualPrice(page, { floor: '0.310', ceiling: '0.410', delta: '0.004' });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelCreate);
		const created = (await api.nextMutation()).body;
		expect(created).toMatchObject({
			targetTraits: [{ type: 'Zone', value: 'Shahra' }],
			competitionPresetVersionId: `${BIDDING_E2E_COMPETITION_PRESET_ID.Created}:v1`
		});
		expect(created).not.toHaveProperty('extraCompetitionTraits');
		await expect(page.getByTestId(TEST_IDS.BiddingPanelModify)).toBeDisabled();
		await page.screenshot({ path: testInfo.outputPath('competition-reference-saved.png') });
		await options.getByRole('button', { name: 'none', exact: true }).click();
		await panel.getByRole('button', { name: 'reset', exact: true }).click();
		await expect(
			options.getByRole('button', { name: 'Biome=any + Mode=Terrain', exact: true })
		).toHaveAttribute('aria-pressed', 'true');
		await options.getByRole('button', { name: 'none', exact: true }).click();
		let releaseFailure!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseFailure = resolve;
		});
		await page.route(
			'**/bidding/jobs/traits',
			async (route) => {
				await held;
				await route.fulfill({
					status: 400,
					json: { message: 'Could not save. Try modify again.' }
				});
			},
			{ times: 1 }
		);
		await confirmPanelAction(page, TEST_IDS.BiddingPanelModify);
		await expect(
			options.getByRole('button', { name: 'Biome=any + Mode=Terrain', exact: true })
		).toBeDisabled();
		await page.screenshot({ path: testInfo.outputPath('competition-reference-saving.png') });
		releaseFailure();
		await expect(panel.getByRole('alert')).toContainText('Try modify again');
		await page.screenshot({ path: testInfo.outputPath('competition-reference-save-failed.png') });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelModify);
		expect((await api.nextMutation()).body).toMatchObject({ competitionPresetVersionId: null });
		await expect(page.getByTestId(TEST_IDS.BiddingPanelModify)).toBeDisabled();
	});

	for (const clearPreset of [false, true]) {
		test(`preserves ${clearPreset ? 'explicitly cleared' : 'saved'} extra targets during price edits before a delayed lookup`, async ({
			page
		}, testInfo) => {
			const api = await installBiddingAutomationApiMock(page);
			let release!: () => void;
			let requested!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const lookupRequested = new Promise<void>((resolve) => {
				requested = resolve;
			});
			await page.route(
				'**/bidding/jobs/target-lookup',
				async (route) => {
					const job = findBiddingE2eJobForTarget(route.request().postDataJSON());
					expect(job?.config.competitionPreset?.versionId).toBe(
						`${BIDDING_E2E_COMPETITION_PRESET_ID.Biome}:v1`
					);
					requested();
					await held;
					await route.fulfill({ json: { job } });
				},
				{ times: 1 }
			);
			await openHarnessPage(page, `${COLLECTION_PATH}?token_status=all&traits=Biome:42`);
			await page
				.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnTraits, exact: true })
				.click();
			await lookupRequested;
			const panel = page.getByTestId(TEST_IDS.BiddingPanel);
			const options = panel.getByRole('group', { name: 'Extra targets', exact: true });
			if (clearPreset) {
				await options.getByRole('button', { name: 'Mode=Terrain', exact: true }).click();
				await options.getByRole('button', { name: 'none', exact: true }).click();
			}
			await fillManualPrice(page, { floor: '0.360', ceiling: '0.400', delta: '0.004' });
			release();
			await expect(panel).toContainText('job-trait-biome-42');
			await expect(
				options.getByRole('button', { name: clearPreset ? 'none' : 'Mode=Terrain', exact: true })
			).toHaveAttribute('aria-pressed', 'true');
			await expect(page.locator('#bidding-automation-floor')).toHaveValue('0.360');
			await confirmPanelAction(page, TEST_IDS.BiddingPanelModify);
			const mutation = await api.nextMutation();
			expect(mutation.body).toMatchObject({
				floorEth: '0.360',
				ceilingEth: '0.400',
				deltaEth: '0.004'
			});
			if (clearPreset) expect(mutation.body).toHaveProperty('competitionPresetVersionId', null);
			else expect(mutation.body).not.toHaveProperty('competitionPresetVersionId');
			await expect(panel.getByTestId(TEST_IDS.BiddingPanelModify)).toBeDisabled();
			await expect(
				options.getByRole('button', { name: clearPreset ? 'none' : 'Mode=Terrain', exact: true })
			).toHaveAttribute('aria-pressed', 'true');
			await page.screenshot({
				path: testInfo.outputPath(
					`extra-targets-delayed-lookup-${clearPreset ? 'cleared' : 'preserved'}.png`
				)
			});
		});
	}

	for (const [entry, path] of [
		[
			'token browser',
			`${COLLECTION_PATH}?token_status=${TOKEN_BROWSER_STATUS.All}&traits=Biome:42`
		],
		['holder browser', `${COLLECTION_PATH}/holders/${BIDDING_E2E_HOLDER_ADDRESS}?traits=Biome:42`],
		['token detail', `${COLLECTION_PATH}/101`],
		['offers', `${BIDDING_PATH}?bid_scope=traits&traits=Biome:42`]
	]) {
		test(`recovers extra targets inventory in the ${entry} bidding picker`, async ({
			page
		}, testInfo) => {
			await installBiddingAutomationApiMock(page);
			let releaseFailure!: () => void;
			let releaseRetry!: () => void;
			let requested!: () => void;
			const heldFailure = new Promise<void>((resolve) => {
				releaseFailure = resolve;
			});
			const heldRetry = new Promise<void>((resolve) => {
				releaseRetry = resolve;
			});
			const inventoryRequested = new Promise<void>((resolve) => {
				requested = resolve;
			});
			let attempts = 0;
			let recoverInventory = false;
			await page.route('**/bidding/competition-presets', async (route) => {
				attempts++;
				if (!recoverInventory) {
					requested();
					await heldFailure;
					await route.fulfill({ status: 500, json: { message: 'Inventory unavailable.' } });
				} else {
					await heldRetry;
					await route.fulfill({
						json: {
							presets: [
								...BIDDING_E2E_COMPETITION_PRESETS,
								biddingCompetitionPresetFixture(
									BIDDING_E2E_COMPETITION_PRESET_ID.Created,
									[{ type: 'Biome' }],
									[
										{
											type: TERRAFORMS_MODE_ATTRIBUTE_KEY,
											value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Daydream
										}
									]
								)
							]
						}
					});
				}
			});
			await openHarnessPage(page, path);
			if (entry === 'holder browser') {
				const geometry = await page.evaluate(() => ({
					width: document.documentElement.clientWidth,
					scrollWidth: document.documentElement.scrollWidth
				}));
				expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
			}
			await inventoryRequested;
			if (entry === 'token detail') {
				await page
					.locator(`[data-testid="${TEST_IDS.BidBookRowBid}"][data-traits="Biome=42"]`)
					.first()
					.click();
			} else {
				await page
					.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnTraits, exact: true })
					.click();
			}
			const panel = page.getByTestId(TEST_IDS.BiddingPanel);
			const options = panel.getByRole('group', { name: 'Extra targets', exact: true });
			await expect(panel).toContainText('job-trait-biome-42');
			await expect(panel.getByRole('status')).toHaveText('loading...');
			await expect(
				options.getByRole('button', { name: 'Mode=Terrain (v1)', exact: true })
			).toHaveAttribute('aria-pressed', 'true');
			await expect(panel.getByRole('alert')).toHaveCount(0);
			await page.screenshot({
				path: testInfo.outputPath('extra-targets-picker-loading.png')
			});
			await fillManualPrice(page, { floor: '0.360', ceiling: '0.400', delta: '0.004' });
			releaseFailure();
			await expect(panel.getByRole('alert')).toContainText(
				'Could not load extra targets. Refresh.',
				{ timeout: 20_000 }
			);
			await expect(panel.getByRole('status')).toHaveCount(0);
			await expect(page.getByRole('region', { name: 'extra targets presets' })).toHaveCount(0);
			await expect(
				page.getByRole('button', {
					name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras,
					exact: true
				})
			).toHaveCount(entry === 'offers' ? 1 : 0);
			await page.screenshot({
				path: testInfo.outputPath('extra-targets-picker-failed.png')
			});
			const failedAttempts = attempts;
			recoverInventory = true;
			await options.getByRole('button', { name: 'refresh', exact: true }).click();
			await expect(panel.getByRole('status')).toHaveText('loading...');
			await expect(panel.getByRole('alert')).toHaveCount(0);
			await expect(options.getByRole('button', { name: 'refresh', exact: true })).toHaveCount(0);
			releaseRetry();
			await expect(
				options.getByRole('button', { name: 'Mode=Daydream', exact: true })
			).toBeVisible();
			await expect(
				options.getByRole('button', { name: 'Mode=Terrain', exact: true })
			).toHaveAttribute('aria-pressed', 'true');
			await expect(panel.getByRole('status')).toHaveCount(0);
			await expect(page.locator('#bidding-automation-floor')).toHaveValue('0.360');
			expect(attempts).toBe(failedAttempts + 1);
			await page.screenshot({
				path: testInfo.outputPath('extra-targets-picker-recovered.png')
			});
		});
	}

	test('reapplies only selected extra targets jobs with the shared preview controls', async ({
		page
	}, testInfo) => {
		const api = await installBiddingAutomationApiMock(page, { competitionReapply: true });
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras, exact: true })
			.click();
		const inventory = page.getByRole('region', { name: 'extra targets presets' });
		await inventory.getByRole('button', { name: 'reapply', exact: true }).click();
		const preview = inventory.getByRole('region', { name: 'extra targets reapply preview' });
		await expect(preview).toBeVisible();
		const checkboxes = preview.getByRole('checkbox');
		await expect(checkboxes).toHaveCount(4);
		await expect(checkboxes.nth(0)).toBeChecked();
		await expect(checkboxes.nth(1)).toBeChecked();
		await expect(checkboxes.nth(2)).toBeDisabled();
		await expect(checkboxes.nth(3)).toBeDisabled();
		await expect(preview).toContainText('Biome=removed');
		await expect(preview).toContainText('1 -> 2');
		await expect(preview).toContainText('Mode=Terrain -> Mode=Daydream');
		await expect(preview.getByRole('row').filter({ hasText: 'Biome=removed' })).toContainText(
			'not available for marketplace bidding'
		);
		await preview.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-reapply-preview.png'),
			fullPage: true
		});
		await checkboxes.nth(0).uncheck();
		const apply = preview.getByRole('button', { name: 'apply', exact: true });
		await apply.click();
		await expect(apply).toHaveClass(/token-bidding-action-armed/);
		expect(api.mutations).toHaveLength(0);
		await preview.getByRole('columnheader', { name: 'target', exact: true }).click();
		await expect(apply).not.toHaveClass(/token-bidding-action-armed/);
		await apply.click();
		await apply.click();
		const mutation = await api.nextMutation();
		expect(mutation.path).toBe(
			buildCompetitionPresetReapplyPath(
				BIDDING_E2E_CHAIN.slug,
				BIDDING_E2E_COLLECTION.slug,
				BIDDING_E2E_COMPETITION_PRESET_ID.Biome
			)
		);
		expect(mutation.body).toEqual({
			expectedRevision: 2,
			jobs: [
				{
					jobId: BIDDING_E2E_REAPPLY_JOB_ID.Paused,
					expectedRevision: 3,
					versionId: `${BIDDING_E2E_COMPETITION_PRESET_ID.Biome}:v1`
				}
			]
		});
		await expect(inventory.getByRole('status').filter({ hasText: 'reapplied' })).toBeVisible();
		await expect(preview.getByRole('checkbox').nth(1)).toBeDisabled();
		await expect(preview.getByRole('checkbox').nth(0)).toBeChecked();
		await expect(preview.getByRole('row').filter({ hasText: 'Biome=7' })).toContainText('paused');
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-reapply-selected-result.png'),
			fullPage: true
		});
	});

	test('rejects stale extra targets previews and recovers by previewing again', async ({
		page
	}, testInfo) => {
		const api = await installBiddingAutomationApiMock(page, { competitionReapply: true });
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras, exact: true })
			.click();
		const inventory = page.getByRole('region', { name: 'extra targets presets' });
		await inventory.getByRole('button', { name: 'reapply', exact: true }).click();
		const preview = inventory.getByRole('region', { name: 'extra targets reapply preview' });
		await expect(preview.getByRole('checkbox').nth(0)).toBeChecked();
		api.reviseCompetitionReapplyJob(BIDDING_E2E_REAPPLY_JOB_ID.Paused);
		const apply = preview.getByRole('button', { name: 'apply', exact: true });
		await apply.click();
		await apply.click();
		expect((await api.nextMutation()).body).toMatchObject({
			jobs: [
				{ jobId: BIDDING_E2E_REAPPLY_JOB_ID.Enabled, expectedRevision: 3 },
				{ jobId: BIDDING_E2E_REAPPLY_JOB_ID.Paused, expectedRevision: 3 }
			]
		});
		await expect(inventory.getByRole('alert')).toHaveText(
			'Selected jobs changed. Preview reapply again.'
		);
		await expect(preview.getByRole('checkbox').nth(0)).toBeChecked();
		await expect(preview.getByRole('checkbox').nth(1)).toBeChecked();
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-reapply-stale.png'),
			fullPage: true
		});
		await inventory.getByRole('button', { name: 'reapply', exact: true }).click();
		await expect(inventory.getByRole('alert')).toHaveCount(0);
		await apply.click();
		await apply.click();
		expect((await api.nextMutation()).body).toMatchObject({
			jobs: [
				{ jobId: BIDDING_E2E_REAPPLY_JOB_ID.Enabled, expectedRevision: 3 },
				{ jobId: BIDDING_E2E_REAPPLY_JOB_ID.Paused, expectedRevision: 4 }
			]
		});
		await expect(preview.getByRole('checkbox').nth(0)).toBeDisabled();
		await expect(preview.getByRole('checkbox').nth(1)).toBeDisabled();
		await expect(apply).toBeDisabled();
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-reapply-recovered.png'),
			fullPage: true
		});
	});

	test('shows extra targets preview errors, pending work and empty results', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page, { competitionReapply: true });
		const fixture = buildBiddingE2eCompetitionReapplyFixture();
		const path = buildCompetitionPresetReapplyPreviewPath(
			BIDDING_E2E_CHAIN.slug,
			BIDDING_E2E_COLLECTION.slug,
			fixture.presets[0].presetId
		);
		let pending: (() => void) | null = null;
		let empty = false;
		await page.route(`**${path}`, async (route) => {
			if (empty) {
				await route.fulfill({
					json: {
						chain: BIDDING_E2E_CHAIN,
						collection: BIDDING_E2E_COLLECTION,
						preset: fixture.presets[0],
						jobs: []
					}
				});
				return;
			}
			if (!pending)
				await new Promise<void>((resolve) => {
					pending = resolve;
				});
			await route.fulfill({ status: 500, json: { message: 'internal test failure' } });
		});
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras, exact: true })
			.click();
		const inventory = page.getByRole('region', { name: 'extra targets presets' });
		const reapply = inventory.getByRole('button', { name: 'reapply', exact: true });
		await reapply.click();
		await expect(reapply).toBeDisabled();
		await expect(inventory.getByRole('button', { name: 'edit', exact: true })).toBeDisabled();
		await expect(inventory.getByRole('status')).toContainText('loading...');
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-reapply-loading.png'),
			fullPage: true
		});
		if (!pending) throw new Error('Preview request was not captured');
		(pending as () => void)();
		await expect(inventory.getByRole('alert')).toHaveText(
			'Could not preview extra targets. Try reapply again.',
			{ timeout: 20_000 }
		);
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-reapply-read-error.png'),
			fullPage: true
		});
		empty = true;
		await reapply.click();
		const preview = inventory.getByRole('region', { name: 'extra targets reapply preview' });
		await expect(preview).toContainText('no jobs use this preset');
		await expect(preview.getByRole('button', { name: 'apply', exact: true })).toBeDisabled();
		await expect(inventory.getByRole('alert')).toHaveCount(0);
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-reapply-empty.png'),
			fullPage: true
		});
	});

	test('keeps extra targets reapply read-only without trait-offer opt-in', async ({ page }) => {
		await installBiddingAutomationApiMock(page, { competitionReapply: true });
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?bid_scope=traits&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.TraitCompetitionReadOnly}`
		);
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras, exact: true })
			.click();
		const inventory = page.getByRole('region', { name: 'extra targets presets' });
		await expect(inventory.getByRole('button', { name: 'reapply', exact: true })).toBeDisabled();
		await expect(inventory.getByRole('button', { name: 'edit', exact: true })).toBeEnabled();
	});

	for (const explicitClear of [false, true]) {
		test(`refreshes an open job after extra targets reapply and preserves ${explicitClear ? 'an explicit clear' : 'a price draft'}`, async ({
			page
		}, testInfo) => {
			const api = await installBiddingAutomationApiMock(page, { competitionReapply: true });
			const lookupRevisions: number[] = [];
			const marketStates: unknown[] = [];
			page.on('response', async (response) => {
				const path = new URL(response.url()).pathname;
				if (!path.startsWith('/api/')) return;
				if (path.endsWith('/bidding/jobs/target-lookup')) {
					const body = await response.json();
					if (body.job?.jobId === BIDDING_E2E_REAPPLY_JOB_ID.Enabled)
						lookupRevisions.push(body.job.revision);
				} else if (path.endsWith('/bidding/bids') && response.request().method() === 'GET') {
					marketStates.push((await response.json()).bidBook.state);
				}
			});
			await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits&traits=Biome:42`);
			await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnTraits }).click();
			const panel = page.getByTestId(TEST_IDS.BiddingPanel);
			const options = panel.getByRole('group', { name: 'Extra targets', exact: true });
			await expect(
				options.getByRole('button', { name: 'Mode=Terrain (v1)', exact: true })
			).toHaveAttribute('aria-pressed', 'true');
			await fillManualPrice(page, { floor: '0.360', ceiling: '0.400', delta: '0.004' });
			if (explicitClear) await options.getByRole('button', { name: 'none', exact: true }).click();
			if (testInfo.project.name === 'pixel-7') {
				await panel.getByRole('button', { name: 'hide', exact: true }).click();
			}
			await page
				.getByRole('button', {
					name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras,
					exact: true
				})
				.click();
			const inventory = page.getByRole('region', { name: 'extra targets presets' });
			await inventory.getByRole('button', { name: 'reapply', exact: true }).click();
			const preview = inventory.getByRole('region', { name: 'extra targets reapply preview' });
			await preview.getByRole('checkbox').nth(1).uncheck();
			const apply = preview.getByRole('button', { name: 'apply', exact: true });
			await apply.click();
			await apply.click();
			expect((await api.nextMutation()).body).toMatchObject({
				jobs: [{ jobId: BIDDING_E2E_REAPPLY_JOB_ID.Enabled, expectedRevision: 3 }]
			});
			await expect(inventory.getByRole('status')).toHaveText('reapplied');
			await expect.poll(() => lookupRevisions.at(-1)).toBe(4);
			if (testInfo.project.name === 'pixel-7') {
				await page.getByRole('button', { name: 'show bidding panel', exact: true }).click();
			}
			await expect(
				options.getByRole('button', { name: 'Mode=Terrain (v1)', exact: true })
			).toHaveCount(0);
			await expect(
				options.getByRole('button', { name: explicitClear ? 'none' : 'Mode=Daydream', exact: true })
			).toHaveAttribute('aria-pressed', 'true');
			await expect(page.locator('#bidding-automation-floor')).toHaveValue('0.360');
			await page.screenshot({
				path: testInfo.outputPath('reapply-open-editor.png'),
				fullPage: true
			});
			await confirmPanelAction(page, TEST_IDS.BiddingPanelModify);
			const saved = await api.nextMutation();
			expect(saved.body).toMatchObject({
				floorEth: '0.360',
				ceilingEth: '0.400',
				deltaEth: '0.004'
			});
			if (explicitClear) expect(saved.body).toHaveProperty('competitionPresetVersionId', null);
			else expect(saved.body).not.toHaveProperty('competitionPresetVersionId');
			await expect.poll(() => lookupRevisions.at(-1)).toBe(5);
			await expect.poll(() => marketStates.length).toBeGreaterThanOrEqual(2);
			expect(
				marketStates.every((state) => JSON.stringify(state) === JSON.stringify(marketStates[0]))
			).toBe(true);
			await expect(
				options.getByRole('button', { name: explicitClear ? 'none' : 'Mode=Daydream', exact: true })
			).toHaveAttribute('aria-pressed', 'true');
		});
	}

	test('keeps saved extra targets versions until an explicit newer selection', async ({
		page
	}, testInfo) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits&traits=Biome:42`);
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras, exact: true })
			.click();
		const inventory = page.getByRole('region', { name: 'extra targets presets' });
		await inventory.getByRole('button', { name: 'edit', exact: true }).click();
		const source = inventory.getByRole('group', { name: 'source target', exact: true });
		const key = source.getByRole('combobox', { name: 'source target key 1', exact: true });
		const value = source.getByRole('combobox', { name: 'source target value 1', exact: true });
		await expect(key).toBeDisabled();
		await expect(value).toBeDisabled();
		await expect(key).toHaveValue('Biome');
		await expect(value).toHaveValue('value:42');
		await expect(source.getByRole('button', { name: 'add', exact: true })).toBeDisabled();
		await expect(
			source.getByRole('button', { name: 'remove source target 1', exact: true })
		).toBeDisabled();
		await source.getByRole('button', { name: 'Help', exact: true }).press('Enter');
		await expect(source.getByRole('tooltip')).toBeInViewport({ ratio: 1 });
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-source-locked-help.png'),
			fullPage: true
		});
		await source.getByRole('button', { name: 'Help', exact: true }).press('Escape');
		await inventory.getByRole('button', { name: 'reset', exact: true }).click();
		await expect(key).toBeEnabled();
		await expect(key).toHaveValue('');
		await key.selectOption('Zone');
		await expect(value).toBeEnabled();
		await expect(inventory.getByRole('button', { name: 'create', exact: true })).toBeDisabled();
		await page.screenshot({
			path: testInfo.outputPath('extra-targets-new-source-after-reset.png'),
			fullPage: true
		});
		await inventory.getByRole('button', { name: 'edit', exact: true }).click();
		await inventory
			.getByRole('combobox', { name: 'extra target value 1', exact: true })
			.selectOption({ label: 'Daydream' });
		await inventory.getByRole('button', { name: 'modify', exact: true }).click();
		await inventory.getByRole('button', { name: 'modify', exact: true }).click();
		expect((await api.nextMutation()).body).toMatchObject({
			presetId: BIDDING_E2E_COMPETITION_PRESET_ID.Biome,
			expectedRevision: 1,
			targetTraits: [{ type: 'Biome', value: '42' }],
			extraCompetitionTraits: [{ type: 'Mode', value: 'Daydream' }]
		});
		await expect(inventory.getByRole('row').filter({ hasText: 'Biome=42' })).toContainText(
			'Mode=Daydream'
		);
		await inventory.getByRole('button', { name: 'hide', exact: true }).click();
		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnTraits }).click();
		const options = page
			.getByTestId(TEST_IDS.BiddingPanel)
			.getByLabel('Extra targets', { exact: true });
		await expect(
			options.getByRole('button', { name: 'Mode=Terrain (v1)', exact: true })
		).toHaveAttribute('aria-pressed', 'true');
		expect(
			await options
				.getByRole('button', { name: 'Mode=Terrain (v1)', exact: true })
				.evaluate((button) => button.scrollWidth <= button.clientWidth + 1)
		).toBe(true);
		await expect(page.getByTestId(TEST_IDS.BiddingPanelModify)).toBeDisabled();
		await page.screenshot({ path: testInfo.outputPath('competition-reference-older.png') });
		await options.getByRole('button', { name: 'Mode=Daydream', exact: true }).click();
		await confirmPanelAction(page, TEST_IDS.BiddingPanelModify);
		expect((await api.nextMutation()).body).toMatchObject({
			competitionPresetVersionId: `${BIDDING_E2E_COMPETITION_PRESET_ID.Biome}:v2`
		});
		await page.screenshot({ path: testInfo.outputPath('competition-reference-updated.png') });
	});

	test('recovers extra targets inventory errors and archives without changing saved jobs', async ({
		page
	}, testInfo) => {
		const api = await installBiddingAutomationApiMock(page);
		let inventoryUnavailable = true;
		await page.route('**/bidding/competition-presets', (route) =>
			inventoryUnavailable
				? route.fulfill({ status: 500, json: { message: 'Preset inventory unavailable.' } })
				: route.fallback()
		);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits&traits=Biome:42`);
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.CompetitiveExtras, exact: true })
			.click();
		const inventory = page.getByRole('region', { name: 'extra targets presets' });
		await expect(inventory.getByRole('alert')).toContainText('Refresh', {
			timeout: 20_000
		});
		await page.screenshot({ path: testInfo.outputPath('competition-presets-load-failed.png') });
		inventoryUnavailable = false;
		await inventory.getByRole('button', { name: 'refresh', exact: true }).click();
		await expect(inventory.getByRole('row').filter({ hasText: 'Biome=42' })).toContainText(
			'Mode=Terrain'
		);
		await expect(inventory.getByRole('alert')).toHaveCount(0);
		await inventory.getByRole('button', { name: 'edit', exact: true }).click();
		const value = inventory.getByRole('combobox', {
			name: 'extra target value 1',
			exact: true
		});
		await value.selectOption({ label: 'Daydream' });
		let releaseFailure!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseFailure = resolve;
		});
		await page.route(
			'**/bidding/competition-presets',
			async (route) => {
				await held;
				await route.fulfill({
					status: 500,
					json: { message: 'Could not save preset. Try modify again.' }
				});
			},
			{ times: 1 }
		);
		await inventory.getByRole('button', { name: 'modify', exact: true }).click();
		await inventory.getByRole('button', { name: 'modify', exact: true }).click();
		await expect(value).toBeDisabled();
		await page.screenshot({
			path: testInfo.outputPath('competition-presets-saving.png'),
			fullPage: true
		});
		releaseFailure();
		await expect(inventory.getByRole('alert')).toContainText('Try modify again');
		await expect(value).toHaveValue('value:Daydream');
		await page.screenshot({
			path: testInfo.outputPath('competition-presets-save-failed.png'),
			fullPage: true
		});
		await inventory.getByRole('button', { name: 'modify', exact: true }).click();
		await inventory.getByRole('button', { name: 'modify', exact: true }).click();
		expect((await api.nextMutation()).body).toMatchObject({
			presetId: BIDDING_E2E_COMPETITION_PRESET_ID.Biome,
			expectedRevision: 1
		});
		await expect(inventory.getByRole('row').filter({ hasText: 'Biome=42' })).toContainText(
			'Mode=Daydream'
		);
		await inventory.getByRole('button', { name: 'archive', exact: true }).click();
		await inventory.getByRole('button', { name: 'archive', exact: true }).click();
		expect(await api.nextMutation()).toMatchObject({
			method: 'DELETE',
			body: { expectedRevision: 2 }
		});
		await expect(inventory.getByRole('button', { name: 'edit', exact: true })).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath('competition-presets-archived.png') });
		await inventory.getByRole('button', { name: 'hide', exact: true }).click();
		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnTraits }).click();
		const options = page
			.getByTestId(TEST_IDS.BiddingPanel)
			.getByLabel('Extra targets', { exact: true });
		await expect(
			options.getByRole('button', { name: 'Mode=Terrain (v1)', exact: true })
		).toHaveAttribute('aria-pressed', 'true');
		await expect(options.getByRole('button', { name: 'Mode=Daydream', exact: true })).toHaveCount(
			0
		);
		await expect(page.getByTestId(TEST_IDS.BiddingPanelModify)).toBeDisabled();
		await page.screenshot({ path: testInfo.outputPath('competition-reference-archived.png') });
	});

	test('loads saved extra targets and keeps selection read-only without trait trust', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${COLLECTION_PATH}?token_status=${TOKEN_BROWSER_STATUS.All}&traits=Biome:42&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.TraitCompetitionReadOnly}`
		);
		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnTraits }).click();
		const options = page
			.getByTestId(TEST_IDS.BiddingPanel)
			.getByLabel('Extra targets', { exact: true });
		await expect(
			options.getByRole('button', { name: 'Mode=Terrain', exact: true })
		).toHaveAttribute('aria-pressed', 'true');
		await expect(options.getByRole('button', { name: 'none', exact: true })).toBeDisabled();
		await expect(page.getByTestId(TEST_IDS.BiddingPanelModify)).toHaveCount(0);
		await expect(page.getByTestId(TEST_IDS.BiddingPanelPause)).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath('competition-reference-readonly.png') });
	});

	test('renders token-scope offers from fixtures and captures a TokenOfferFilter mutation', async ({
		page
	}) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?bid_scope=token&traits=Zone:Shahra&maker=${MARKET_MAKER_A}`
		);

		await expectSecondaryTabHoverChrome(
			page.getByLabel('Bid scope filter').getByRole('link', { name: 'traits' })
		);
		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnAllTokens }).click();
		await expect(page.getByText('1 tokens selected')).toBeVisible();

		await fillManualPrice(page, { floor: '0.210', ceiling: '0.260', delta: '0.004' });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelCreate);

		const mutation = await api.nextMutation();
		expect(mutation.path).toContain('/bidding/jobs/tokens/batch');
		expect(mutation.body).toMatchObject({
			status: TRADING_JOB_STATUS.Enabled,
			floorEth: '0.210',
			ceilingEth: '0.260',
			deltaEth: '0.004',
			selection: {
				type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter,
				traits: [{ key: 'Zone', value: 'Shahra' }],
				traitRanges: [],
				traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
				makerAddress: MARKET_MAKER_A
			}
		});
	});

	test('supports token-browser all-result and visible-page batch modes', async ({ page }) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${COLLECTION_PATH}?token_status=${TOKEN_BROWSER_STATUS.All}`);

		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnAllTokens }).click();
		await expect(page.getByText('4 tokens selected')).toBeVisible();
		await fillManualPrice(page, { floor: '0.180', ceiling: '0.240', delta: '0.004' });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelCreate);

		const allTokensMutation = await api.nextMutation();
		expect(allTokensMutation.path).toContain('/bidding/jobs/tokens/batch');
		expect(allTokensMutation.body).toMatchObject({
			selection: {
				type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenBrowserFilter,
				tokenStatus: TOKEN_BROWSER_STATUS.All,
				traits: [],
				traitRanges: []
			}
		});

		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.Clear }).click();
		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnAllTokens }).click();
		await expect(
			page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnThisPage })
		).toBeVisible();
		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnThisPage }).click();
		await expect(page.getByText('2 tokens selected')).toBeVisible();
		await fillManualPrice(page, { floor: '0.190', ceiling: '0.230', delta: '0.004' });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelCreate);

		const pageTokensMutation = await api.nextMutation();
		expect(pageTokensMutation.path).toContain('/bidding/jobs/tokens/batch');
		expect(pageTokensMutation.body).toMatchObject({
			selection: {
				type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds,
				tokenIds: ['101', '102']
			}
		});
	});

	test('supports token-browser trait and explicit-token bidding selections', async ({ page }) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${COLLECTION_PATH}?token_status=${TOKEN_BROWSER_STATUS.All}&traits=Zone:Shahra`
		);

		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnTraits }).click();
		await expect(page.getByText('1 trait selected')).toBeVisible();
		await fillManualPrice(page, { floor: '0.310', ceiling: '0.410', delta: '0.004' });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelCreate);

		const traitMutation = await api.nextMutation();
		expect(traitMutation.path).toContain('/bidding/jobs/traits');
		expect(traitMutation.body).toMatchObject({
			targetTraits: [{ type: 'Zone', value: 'Shahra' }],
			floorEth: '0.310',
			ceilingEth: '0.410'
		});

		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.Clear }).click();
		await clickTokenCard(page, '101', { ctrl: true });
		await page.getByRole('button', { name: 'hide' }).click();
		await page.locator(`[data-testid="${TEST_IDS.TokenCard}"][data-token-id="102"]`).click({
			button: 'middle'
		});
		await expect(page.getByText('2 tokens selected')).toBeVisible();
		await page.getByRole('button', { name: 'show bidding panel' }).click();
		await fillManualPrice(page, { floor: '0.220', ceiling: '0.230', delta: '0.004' });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelCreate);

		const tokenMutation = await api.nextMutation();
		expect(tokenMutation.path).toContain('/bidding/jobs/tokens/batch');
		expect(tokenMutation.body).toMatchObject({
			selection: {
				type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds,
				tokenIds: ['101', '102']
			}
		});
	});

	test('blocks unsupported token-browser trait bidding before submission', async ({ page }) => {
		const api = await installBiddingAutomationApiMock(page);
		const unsupportedTrait = `${TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY}:${TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed}`;
		await openHarnessPage(
			page,
			`${COLLECTION_PATH}?token_status=${TOKEN_BROWSER_STATUS.All}&traits=${encodeURIComponent(
				unsupportedTrait
			)}`
		);

		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnTraits }).click();
		const panel = page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`);

		await expect(panel).toContainText('not available');
		await expect(panel).toContainText(
			'selected trait target is not available for marketplace bidding'
		);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelCreate}"]`)).toHaveCount(0);
		expect(api.mutations).toHaveLength(0);
	});

	test('supports root trait search and jump into a matching bucket', async ({ page }) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${COLLECTION_PATH}?token_status=${TOKEN_BROWSER_STATUS.All}`);
		await page.getByRole('button', { name: 'expand traits panel' }).click();

		const facetPanel = page.locator('.facet-panel');
		const rootSearch = page.getByRole('searchbox', { name: 'search all traits' });
		await expect(rootSearch).toBeVisible();

		await rootSearch.fill('terra');

		await expect(facetPanel.locator('details.trait-group')).toHaveCount(1);
		const modeGroup = facetPanel.locator('details.trait-group').filter({ hasText: 'Mode' });
		await expect(modeGroup).toHaveAttribute('open', '');
		await expect(modeGroup.getByText('Terrain')).toBeVisible();
		await expect(modeGroup.getByText('Daydream')).toHaveCount(0);
		await expect(modeGroup.getByPlaceholder('search')).toHaveCount(0);

		await modeGroup.getByRole('button', { name: 'search Mode' }).click();

		await expect(rootSearch).toHaveValue('');
		await expect(facetPanel.locator('details.trait-group[open]')).toHaveCount(1);
		await expect(modeGroup).toHaveAttribute('open', '');
		await expect(modeGroup.getByPlaceholder('search')).toHaveValue('terra');
		await expect(modeGroup.getByText('Terrain')).toBeVisible();
		await expect(modeGroup.getByText('Daydream')).toHaveCount(0);
	});

	test('supports token-offer visible-page refinement and own-status cards', async ({ page }) => {
		await rememberUnfilteredBiddingNavigation(page);
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=token`);

		const ownStatusCard = tokenCard(page, '102');
		await expect(
			ownStatusCard.locator(ownStatusSelector(TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing))
		).toContainText('losing');
		await expect(
			ownStatusCard.locator(ownStatusSelector(TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Floor))
		).toContainText('at floor');
		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnAllTokens }).click();
		await expect(page.getByText('3 tokens selected')).toBeVisible();
		await expect(
			page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnThisPage })
		).toBeVisible();
		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnThisPage }).click();
		await expect(page.getByText('2 tokens selected')).toBeVisible();
		await fillManualPrice(page, { floor: '0.205', ceiling: '0.245', delta: '0.004' });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelCreate);

		const mutation = await api.nextMutation();
		expect(mutation.path).toContain('/bidding/jobs/tokens/batch');
		expect(mutation.body).toMatchObject({
			selection: {
				type: TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds,
				tokenIds: ['101', '102']
			}
		});
	});

	test('renders token-offer cancellation phases from the bid-book read model', async ({ page }) => {
		await rememberUnfilteredBiddingNavigation(page);
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?bid_scope=token&cursor=page-2&${CANCELLATION_PHASE_SCENARIO_QUERY}`
		);

		const cancelingCard = tokenCard(page, '103');
		await expect(cancelingCard).toBeVisible();
		await expect(
			cancelingCard.locator(ownStatusSelector(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling))
		).toContainText('canceling');

		const cancelFailedCard = tokenCard(page, '104');
		await expect(cancelFailedCard).toBeVisible();
		await expect(
			cancelFailedCard.locator(
				ownStatusSelector(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed)
			)
		).toContainText('cancel failed');
	});

	test('opens the bidding panel with cancellation phases from trait bid buckets', async ({
		page
	}) => {
		await rememberUnfilteredBiddingNavigation(page);
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?bid_scope=traits&${CANCELLATION_PHASE_SCENARIO_QUERY}`
		);

		await expect(rowForJob(page, 'job-trait-biome-7-canceling')).toContainText('canceling');
		await clickCenterVerifiedAction(
			page
				.locator(`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="Biome=7"]`)
				.first()
		);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText(
			'job-trait-biome-7-canceling'
		);
		await expect(
			page
				.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)
				.locator(ownStatusSelector(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling))
		).toContainText('canceling');

		await page.keyboard.press('c');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
		await clickCenterVerifiedAction(
			page
				.locator(`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="Zone=Xleph"]`)
				.first()
		);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText(
			'job-trait-zone-xleph-cancel-failed'
		);
		await expect(
			page
				.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)
				.locator(ownStatusSelector(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed))
		).toContainText('cancel failed');
	});

	test('keeps token-card link gestures out of bidding selection', async ({ page }) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${COLLECTION_PATH}?token_status=${TOKEN_BROWSER_STATUS.All}`);

		const firstTokenLink = page
			.locator(`[data-testid="${TEST_IDS.TokenCard}"]`)
			.first()
			.getByRole('link', {
				name: '101'
			});
		await firstTokenLink.click({ modifiers: ['Control'] });

		await expect(page.getByText('1 token selected')).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
	});

	test('supports trait bucket bid and filter actions independently', async ({ page }, testInfo) => {
		await rememberUnfilteredBiddingNavigation(page);
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);

		await expect(
			page.locator(`[data-testid="${TERRAFORMS_BID_BOOK_TRAIT_PREVIEW_DOM.testIds.root}"]`)
		).toHaveCount(5);
		await expect(
			page.locator(`[data-testid="${TERRAFORMS_ZONE_PALETTE_BAND_DOM.testIds.swatch}"]`).first()
		).toBeVisible();
		await expect(
			page
				.locator(`[data-testid="${TERRAFORMS_BIOME_CHARACTER_BAND_DOM.testIds.character}"]`)
				.first()
		).toBeVisible();
		await testInfo.attach('terraforms-bid-book-trait-previews-page.png', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png'
		});

		const filterAction = page
			.locator(
				`[data-testid="${TEST_IDS.BidBookTraitBucketFilter}"][data-traits="Mode=Terrain|Zone=Shahra"]`
			)
			.first();
		await clickCenterVerifiedAction(filterAction);
		await expect(page).toHaveURL(/traits=Mode%3ATerrain/);
		await expect(page).toHaveURL(/traits=Zone%3AShahra/);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);

		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);
		await expect(
			page.locator(
				`[data-testid="${TEST_IDS.BidBookTraitBucketFilter}"][data-traits="Zone=Shahra"]`
			)
		).toHaveCount(0);

		const bidAction = page
			.locator(
				`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="Mode=Terrain|Zone=Shahra"]`
			)
			.first();
		await clickCenterVerifiedAction(bidAction);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toBeVisible();
		await expect(page.locator('#bidding-automation-floor')).toHaveValue('0.421');
		await expect(page.locator('#bidding-automation-delta')).toHaveValue('0.004');
	});

	test('supports top trait bidding with OR filters and existing trait job lookup', async ({
		page
	}) => {
		await rememberUnfilteredBiddingNavigation(page);
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?bid_scope=traits&trait_join=or&traits=Zone:Shahra&traits=Biome:42`
		);

		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnTraits }).click();
		await expect(page.getByText('2 traits selected')).toBeVisible();
		await fillManualPrice(page, { floor: '0.330', ceiling: '0.430', delta: '0.004' });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelCreate);

		const mutation = await api.nextMutation();
		expect(mutation.path).toContain('/bidding/jobs/traits');
		expect(mutation.body).toMatchObject({
			targetTraits: [
				{ type: 'Biome', value: '42' },
				{ type: 'Zone', value: 'Shahra' }
			]
		});

		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);
		await clickCenterVerifiedAction(
			page
				.locator(`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="Biome=42"]`)
				.first()
		);
		const panel = page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`);
		await expect(panel).toContainText('job-trait-biome-42');
		await expect(page.locator('#bidding-automation-floor')).toHaveValue('0.350');
		await expect(page.locator('#bidding-automation-ceiling')).toHaveValue('0.400');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelModify}"]`)).toBeDisabled();
		await page.locator('#bidding-automation-floor').fill('0.360');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelModify}"]`)).toBeEnabled();
	});

	test('keeps the first bidding job visible and editable before bidder identity exists', async ({
		page
	}, testInfo) => {
		await rememberUnfilteredBiddingNavigation(page);
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}&${FIRST_RUN_INTENT_SCENARIO_QUERY}`
		);

		const opponentTraitSignature = `${TERRAFORMS_MODE_ATTRIBUTE_KEY}=${TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain}`;
		const opponentGroup = page.locator('.bid-book-demand-group-row').filter({
			has: page.locator(
				`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="${opponentTraitSignature}"]`
			)
		});
		await expect(opponentGroup).toBeVisible();
		const myBidsLink = page.getByRole('link', { name: BID_BOOK_FILTER_LABEL.OwnBids });
		const myBidsHref = await myBidsLink.getAttribute('href');
		if (!myBidsHref) {
			throw new Error('my bids link is missing its destination');
		}
		const myBidsUrl = new URL(myBidsHref, page.url());
		expect(myBidsUrl.searchParams.get(BID_BOOK_OWNERSHIP_QUERY_PARAM)).toBe(
			COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own
		);
		expect(myBidsUrl.searchParams.get(BID_BOOK_MAKER_QUERY_PARAM)).toBeNull();

		await myBidsLink.click();
		await expect(page).toHaveURL(
			new RegExp(
				`${BID_BOOK_OWNERSHIP_QUERY_PARAM}=${COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own}`
			)
		);
		await expect(opponentGroup).toHaveCount(0);
		await expect(page.getByRole('button', { name: BID_BOOK_FILTER_LABEL.OwnBids })).toBeVisible();
		await expect(page.getByRole('link', { name: BID_BOOK_FILTER_LABEL.AllBids })).toBeVisible();
		const intentRow = rowForJob(page, BIDDING_E2E_FIRST_RUN_INTENT.JobId);
		await expect(intentRow).toBeVisible();
		const makerCell = intentRow.locator('.bid-book-maker-cell');
		await expect(makerCell).toContainText('You');
		await expect(makerCell.getByRole('link')).toHaveCount(0);
		await expect(
			intentRow.locator(ownStatusSelector(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.WaitingForBot))
		).toContainText('waiting for bidding bot');

		const traitSignature = `${BIDDING_E2E_FIRST_RUN_INTENT.TraitType}=${BIDDING_E2E_FIRST_RUN_INTENT.TraitValue}`;
		await clickCenterVerifiedAction(
			page
				.locator(
					`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="${traitSignature}"]`
				)
				.first()
		);

		const panel = page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`);
		await expect(panel).toContainText(BIDDING_E2E_FIRST_RUN_INTENT.JobId);
		await expect(page.locator('#bidding-automation-floor')).toHaveValue('0.325');
		await expect(page.locator('#bidding-automation-ceiling')).toHaveValue('0.375');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelCreate}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelModify}"]`)).toBeDisabled();

		await testInfo.attach('first-run-bidding-job-intent.png', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png'
		});

		await page.locator('#bidding-automation-floor').fill('0.330');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelModify}"]`)).toBeEnabled();
	});

	test('keeps collection bidding at one NFT when the top opponent requests multiple NFTs', async ({
		page
	}, testInfo) => {
		await rememberUnfilteredBiddingNavigation(page);
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=collection`);

		await expect(page.locator(`[data-testid="${TEST_IDS.BidBookRowBid}"]`)).toHaveCount(0);
		await page.getByRole('button', { name: 'expand 1', exact: true }).click();
		await expect(page.getByText('3x', { exact: true })).toBeVisible();
		const lookupRequest = page.waitForRequest(
			(request) =>
				request.method() === 'POST' &&
				request.postDataJSON()?.target?.type === TRADING_JOB_TARGET_KIND.Collection
		);
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.PlaceCollectionBid })
			.click();
		expect((await lookupRequest).postDataJSON()).toEqual({
			target: { type: TRADING_JOB_TARGET_KIND.Collection, quantity: 1 }
		});
		const panel = page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`);
		await expect(panel).toBeVisible();
		await expect(panel).toContainText('job-collection');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelActivate}"]`)).toBeEnabled();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelModify}"]`)).toBeDisabled();
		await page.screenshot({
			path: testInfo.outputPath('collection-quantity-one.png'),
			fullPage: true
		});

		const activate = page.locator(`[data-testid="${TEST_IDS.BiddingPanelActivate}"]`);
		await activate.click();
		await expect(activate).toHaveClass(/token-bidding-action-armed/);
		expect(api.mutations).toHaveLength(0);
		await page.mouse.click(10, 10);
		await expect(activate).not.toHaveClass(/token-bidding-action-armed/);
		await activate.click();
		await activate.click();
		const mutation = await api.nextMutation();
		expect(mutation.path).toContain('/bidding/jobs/collection');
		expect(mutation.body).toMatchObject({ status: TRADING_JOB_STATUS.Enabled, quantity: 1 });
	});

	test('supports token detail token and trait bid actions while hiding collection row actions', async ({
		page
	}) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${COLLECTION_PATH}/101`);

		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'show bidding panel' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: /^place bid on collection/ })).toHaveCount(0);
		await page.getByRole('button', { name: 'bid on token' }).click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText('#101');
		await page.getByRole('button', { name: 'hide' }).click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'show bidding panel' })).toHaveCount(0);

		await page.getByRole('button', { name: 'place bid on Zone=Shahra' }).click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText(
			'Zone=Shahra'
		);
		await page.getByRole('button', { name: 'hide' }).click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'show bidding panel' })).toHaveCount(0);

		const traitRowBid = page
			.locator(`[data-testid="${TEST_IDS.BidBookRowBid}"][data-traits="Biome=42"]`)
			.first();
		await traitRowBid.click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText(
			'Biome=42'
		);
	});

	test('supports token-detail existing job modification and token-row bid action', async ({
		page
	}) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${COLLECTION_PATH}/101`);

		await page.getByRole('button', { name: 'bid on token' }).click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText(
			'job-token-101'
		);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelPause}"]`)).toBeEnabled();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelArchive}"]`)).toBeEnabled();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelModify}"]`)).toBeDisabled();
		await page.locator('#bidding-automation-floor').fill('0.705');
		await confirmPanelAction(page, TEST_IDS.BiddingPanelModify);

		const mutation = await api.nextMutation();
		expect(mutation.path).toContain('/101/bidding/job');
		expect(mutation.body).toMatchObject({
			status: TRADING_JOB_STATUS.Enabled,
			floorEth: '0.705'
		});

		await page.getByRole('button', { name: 'place bid on #101' }).first().click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText('#101');
		await page.getByRole('button', { name: 'hide' }).click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'show bidding panel' })).toHaveCount(0);
	});

	test('keeps an unauthorized token job archived after modification and refresh', async ({
		page
	}, testInfo) => {
		const api = await installBiddingAutomationApiMock(page);
		await page.clock.install();
		const scenarioQuery = `${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.UnconfirmedBid}`;
		await openHarnessPage(
			page,
			`${COLLECTION_PATH}/${BIDDING_E2E_UNCONFIRMED_BID.TokenId}?${scenarioQuery}`
		);
		await page.getByRole('button', { name: 'bid on token' }).click();
		const panel = page.getByTestId(TEST_IDS.BiddingPanel);
		await page.locator('#bidding-automation-floor').fill('0.705');
		await confirmPanelAction(page, TEST_IDS.BiddingPanelModify);
		const modification = await api.nextMutation();
		expect(modification.body).toMatchObject({
			status: TRADING_JOB_STATUS.Enabled,
			floorEth: '0.705'
		});

		await confirmPanelAction(page, TEST_IDS.BiddingPanelArchive);
		expect(await api.nextMutation()).toMatchObject({
			method: 'DELETE',
			path: `/api/${BIDDING_E2E_CHAIN.slug}/${BIDDING_E2E_COLLECTION.slug}/bidding/jobs/${BIDDING_E2E_UNCONFIRMED_BID.JobId}`
		});

		// Exercise the production refresh: an archive must not restore the last saved spec.
		const refreshedJob = page.waitForResponse(
			(response) =>
				response.request().method() === 'GET' &&
				new URL(response.url()).pathname === modification.path
		);
		await page.clock.fastForward(DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs);
		expect((await (await refreshedJob).json()).job).toBeNull();
		await expect(panel).not.toContainText(BIDDING_E2E_UNCONFIRMED_BID.JobId);
		await expect(panel.getByTestId(TEST_IDS.BiddingPanelArchive)).toBeDisabled();
		await expect(panel.getByTestId(TEST_IDS.BiddingPanelPause)).toBeDisabled();
		await page.screenshot({
			path: testInfo.outputPath('saved-job-archived-after-refresh.png'),
			fullPage: true
		});

		// Archiving this job must leave another token's saved job available.
		const otherTokenJobPath = `/api/${BIDDING_E2E_CHAIN.slug}/${BIDDING_E2E_COLLECTION.slug}/102/bidding/job`;
		const otherJob = await page.evaluate(async (path) => {
			const response = await fetch(path);
			return response.json();
		}, otherTokenJobPath);
		expect(otherJob.job).toMatchObject({
			status: TRADING_JOB_STATUS.Enabled,
			target: { type: TRADING_JOB_TARGET_KIND.Token, tokenId: '102' }
		});
		expect(api.mutations).toHaveLength(0);
	});

	test('shows an active bot feed and the collection authorization block independently', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?bid_scope=token&${AUTHORIZATION_REQUIRED_SCENARIO_QUERY}`
		);

		const summary = page.locator('section.bid-book-summary-panel').first();
		await expect(metaValue(summary, 'bid-book feed')).toHaveText('bidding bot');
		await expect(metaValue(summary, 'bidding bot')).toHaveText('active');
		await expect(metaValue(summary, 'bidding authorization')).toHaveText('not included');

		await openHarnessPage(page, `${COLLECTION_PATH}/101?${AUTHORIZATION_REQUIRED_SCENARIO_QUERY}`);
		await page.getByRole('button', { name: 'bid on token' }).click();

		const panel = page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`);
		await expect(panel).toContainText('job-token-101');
		await expect(panel).toContainText('authorization required');
		await expect(panel).toContainText(
			'Stop and start the bidding bot in Admin, then include e2e-bidding in the new bidding authorization.'
		);
		await expect(panel.getByText('queued', { exact: true })).toHaveCount(0);

		await testInfo.attach('bidding-authorization-required.png', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png'
		});
	});

	test('renders token-detail cancellation phases in rows and the token bidding panel', async ({
		page
	}) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${COLLECTION_PATH}/103?${CANCELLATION_PHASE_SCENARIO_QUERY}`);

		await expect(rowForJob(page, 'job-token-103-canceling')).toContainText('canceling');
		await page.getByRole('button', { name: 'bid on token' }).click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText(
			'job-token-103-canceling'
		);
		await expect(
			page
				.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)
				.locator(ownStatusSelector(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling))
		).toContainText('canceling');
		await page.getByRole('button', { name: 'hide' }).click();

		await openHarnessPage(page, `${COLLECTION_PATH}/104?${CANCELLATION_PHASE_SCENARIO_QUERY}`);
		await expect(rowForJob(page, 'job-token-104-cancel-failed')).toContainText('cancel failed');
		await page.getByRole('button', { name: 'bid on token' }).click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText(
			'job-token-104-cancel-failed'
		);
		await expect(
			page
				.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)
				.locator(ownStatusSelector(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed))
		).toContainText('cancel failed');
	});

	test('keeps an unauthorized saved bid unconfirmed and follows its explicit cancellation', async ({
		page
	}, testInfo) => {
		const api = await installBiddingAutomationApiMock(page);
		await page.clock.install();
		const scenarioQuery = `${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.UnconfirmedBid}`;
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=token&${scenarioQuery}`);
		const card = tokenCard(page, BIDDING_E2E_UNCONFIRMED_BID.TokenId);
		await expect(
			card.locator(ownStatusSelector(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Unconfirmed))
		).toHaveText('unconfirmed');
		await expect(card).toContainText('0.72 WETH');
		await page.screenshot({
			path: testInfo.outputPath('saved-bid-card-unconfirmed.png'),
			fullPage: true
		});

		await openHarnessPage(
			page,
			`${COLLECTION_PATH}/${BIDDING_E2E_UNCONFIRMED_BID.TokenId}?${scenarioQuery}`
		);
		await page.getByRole('button', { name: 'bid on token' }).click();
		const panel = page.getByTestId(TEST_IDS.BiddingPanel);
		const state = (phase: TradingBiddingBidBookOwnState) => panel.locator(ownStatusSelector(phase));
		await expect(state(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Unconfirmed)).toHaveText(
			'unconfirmed'
		);
		await expect(panel.getByTestId(TEST_IDS.BiddingPanelPause)).toBeEnabled();
		await expect(panel.getByTestId(TEST_IDS.BiddingPanelArchive)).toBeEnabled();
		await page.screenshot({
			path: testInfo.outputPath('saved-bid-panel-unconfirmed.png'),
			fullPage: true
		});

		// Specs remain editable without boot authorization; the saved order stays distinct.
		await page.locator('#bidding-automation-floor').fill('0.705');
		await confirmPanelAction(page, TEST_IDS.BiddingPanelModify);
		expect((await api.nextMutation()).body).toMatchObject({
			status: TRADING_JOB_STATUS.Enabled,
			floorEth: '0.705'
		});
		await expect(state(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Unconfirmed)).toHaveText(
			'unconfirmed'
		);

		api.setBidBookScenario(BIDDING_E2E_SCENARIO.UnconfirmedBidCanceling);
		await confirmPanelAction(page, TEST_IDS.BiddingPanelPause);
		const cancellation = await api.nextMutation();
		expect(cancellation.path).toContain(`/${BIDDING_E2E_UNCONFIRMED_BID.TokenId}/bidding/job`);
		expect(cancellation.body).toMatchObject({ status: TRADING_JOB_STATUS.Paused });
		await expect(state(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling)).toHaveText('canceling');
		await page.screenshot({ path: testInfo.outputPath('saved-bid-canceling.png'), fullPage: true });

		api.setBidBookScenario(BIDDING_E2E_SCENARIO.UnconfirmedBidCancelFailed);
		await page.clock.fastForward(DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs);
		await expect(state(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed)).toHaveText(
			'cancel failed'
		);
		await page.screenshot({
			path: testInfo.outputPath('saved-bid-cancel-failed.png'),
			fullPage: true
		});

		api.setBidBookScenario(BIDDING_E2E_SCENARIO.UnconfirmedBidCancelled);
		await page.clock.fastForward(DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs);
		await expect(state(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Cancelled)).toHaveText('cancelled');
		await expect(state(TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Unconfirmed)).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath('saved-bid-cancelled.png'), fullPage: true });
	});

	test('keeps invalid job delta text focused and blocks saving until corrected', async ({
		page
	}, testInfo) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${COLLECTION_PATH}/101`);
		await page.getByRole('button', { name: 'bid on token' }).click();
		await page.locator('#bidding-automation-delta').fill('0.004');
		await page.locator('#bidding-automation-floor').fill('1.3');
		await page.locator('#bidding-automation-ceiling').fill('1.4');
		const delta = page.locator('#bidding-automation-delta');
		const warning = page.getByTestId(TEST_IDS.BiddingPanelDeltaWarning);
		const modify = page.getByTestId(TEST_IDS.BiddingPanelModify);
		await expect(delta).toHaveValue('0.01');
		await expect(modify).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath('delta-job-valid.png'), fullPage: true });

		await delta.fill('0.015');
		await expect(delta).toBeFocused();
		await expect(delta).toHaveValue('0.015');
		await expect(delta).toHaveAttribute('aria-invalid', 'true');
		await expect(warning).toHaveText('Invalid delta. Closest valid value: 0.02 ETH.');
		await expect(modify).toBeDisabled();
		await expect(page.getByTestId(TEST_IDS.BiddingPanelPause)).toBeDisabled();
		expect(api.mutations).toHaveLength(0);
		await page.screenshot({
			path: testInfo.outputPath('delta-job-invalid-focused.png'),
			fullPage: true
		});

		await delta.fill('0.010000000000000001');
		await expect(warning).toHaveText('Invalid delta. Closest valid value: 0.01 ETH.');
		await expect(delta).toBeFocused();
		await delta.fill('0.0150000000000000001');
		await expect(warning).toHaveText('Invalid delta. Closest valid value: 0.02 ETH.');
		await expect(delta).toBeFocused();
		await delta.fill('0');
		await expect(warning).toHaveText('Invalid delta. Closest valid value: 0.01 ETH.');
		await delta.fill('invalid');
		await expect(warning).toHaveText('Enter a positive delta in steps of 0.01 ETH.');
		await expect(modify).toBeDisabled();

		await delta.fill('+0.02');
		await expect(delta).toHaveValue('+0.02');
		await expect(warning).toHaveCount(0);
		await expect(delta).toHaveAttribute('aria-invalid', 'false');
		await expect(modify).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath('delta-job-corrected.png'), fullPage: true });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelModify);
		expect((await api.nextMutation()).body).toMatchObject({
			floorEth: '1.3',
			ceilingEth: '1.4',
			deltaEth: '0.02'
		});
	});

	for (const { floorEth, ceilingEth, savedFloorEth, savedCeilingEth, stepEth, invalidDeltaEth } of [
		{
			floorEth: '1.3000000000000000001',
			ceilingEth: '1.4000000000000000001',
			savedFloorEth: '1.3',
			savedCeilingEth: '1.4',
			stepEth: '0.01',
			invalidDeltaEth: '0.001'
		},
		{
			floorEth: '0.3',
			ceilingEth: '1.4000000000000000001',
			savedFloorEth: '0.3',
			savedCeilingEth: '1.4',
			stepEth: '0.01',
			invalidDeltaEth: '0.001'
		},
		{
			floorEth: '0.3',
			ceilingEth: '0.99999999999999999996',
			savedFloorEth: '0.3',
			savedCeilingEth: '1',
			stepEth: '0.01',
			invalidDeltaEth: '0.001'
		},
		{
			floorEth: '0.03',
			ceilingEth: '0.09999999999999999996',
			savedFloorEth: '0.03',
			savedCeilingEth: '0.1',
			stepEth: '0.001',
			invalidDeltaEth: '0.0001'
		}
	]) {
		test(`keeps delta validation consistent after saving sub-wei range ${floorEth}–${ceilingEth}`, async ({
			page
		}, testInfo) => {
			const api = await installBiddingAutomationApiMock(page);
			const job = findBiddingE2eJobForTarget({
				target: { type: TRADING_JOB_TARGET_KIND.Token, tokenId: '101' }
			});
			if (!job) {
				throw new Error('The token 101 bidding job fixture is required.');
			}
			let persistedJob = job;
			let mutationCount = 0;
			await page.route('**/api/**/101/bidding/job', async (route) => {
				const method = route.request().method();
				if (method !== 'PUT' && method !== 'GET') {
					await route.fallback();
					return;
				}
				if (method === 'PUT') {
					mutationCount += 1;
					// Explicit canonical prices model persistence independently of UI parsing.
					persistedJob = {
						...job,
						revision: job.revision + 1,
						config: {
							...job.config,
							floorEth: savedFloorEth,
							ceilingEth: savedCeilingEth,
							deltaEth: stepEth
						},
						runtime: null
					};
				}
				// The token page reloads the job after a successful mutation.
				await route.fulfill({
					json: {
						chain: BIDDING_E2E_CHAIN,
						collection: BIDDING_E2E_COLLECTION,
						tokenId: '101',
						job: persistedJob
					}
				});
			});
			await openHarnessPage(page, `${COLLECTION_PATH}/101`);
			await page.getByRole('button', { name: 'bid on token' }).click();
			const floor = page.locator('#bidding-automation-floor');
			const ceiling = page.locator('#bidding-automation-ceiling');
			const delta = page.locator('#bidding-automation-delta');
			const warning = page.getByTestId(TEST_IDS.BiddingPanelDeltaWarning);
			const modify = page.getByTestId(TEST_IDS.BiddingPanelModify);
			const pause = page.getByTestId(TEST_IDS.BiddingPanelPause);
			await delta.fill(invalidDeltaEth);
			await floor.fill(floorEth);
			await ceiling.fill(ceilingEth);
			await expect(floor).toHaveValue(floorEth);
			await expect(ceiling).toHaveValue(ceilingEth);
			await expect(delta).toHaveValue(stepEth);

			await delta.fill(invalidDeltaEth);
			await expect(delta).toBeFocused();
			await expect(delta).toHaveValue(invalidDeltaEth);
			await expect(delta).toHaveAttribute('aria-invalid', 'true');
			await expect(warning).toHaveText(`Invalid delta. Closest valid value: ${stepEth} ETH.`);
			await expect(modify).toBeDisabled();
			await expect(pause).toBeDisabled();
			expect(mutationCount).toBe(0);
			expect(api.mutations).toHaveLength(0);
			await page.screenshot({
				path: testInfo.outputPath('delta-sub-wei-range-invalid-focused.png'),
				fullPage: true
			});

			await delta.fill(stepEth);
			await expect(warning).toHaveCount(0);
			await expect(modify).toBeEnabled();
			const saveRequest = page.waitForRequest(
				(request) =>
					request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/101/bidding/job')
			);
			await confirmPanelAction(page, TEST_IDS.BiddingPanelModify);
			expect((await saveRequest).postDataJSON()).toMatchObject({
				floorEth,
				ceilingEth,
				deltaEth: stepEth
			});
			await expect(floor).toHaveValue(savedFloorEth);
			await expect(ceiling).toHaveValue(savedCeilingEth);
			await expect(delta).toHaveValue(stepEth);
			await expect(delta).toHaveAttribute('aria-invalid', 'false');
			await expect(warning).toHaveCount(0);
			await expect(modify).toBeDisabled();
			await expect(pause).toBeEnabled();
			expect(mutationCount).toBe(1);
			await page.screenshot({
				path: testInfo.outputPath('delta-sub-wei-range-saved.png'),
				fullPage: true
			});
		});
	}

	test('reconciles job deltas across precision boundaries and ignores incompatible defaults', async ({
		page
	}) => {
		await rememberUnfilteredBiddingNavigation(page);
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}`
		);
		await clickCenterVerifiedAction(
			page
				.locator(
					`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="Mode=Terrain|Zone=Shahra"]`
				)
				.first()
		);
		const floor = page.locator('#bidding-automation-floor');
		const ceiling = page.locator('#bidding-automation-ceiling');
		const delta = page.locator('#bidding-automation-delta');
		await expect(delta).toHaveValue('0.004');
		await floor.fill('1.3');
		await ceiling.fill('1.4');
		await expect(delta).toHaveValue('0.01');
		await floor.fill('0.3');
		await ceiling.fill('0.4');
		await expect(delta).toHaveValue('0.004');

		await floor.fill('0.05');
		await ceiling.fill('0.0999');
		await delta.fill('0.0001');
		await ceiling.fill('0.1');
		await expect(delta).toHaveValue('0.001');
		await ceiling.fill('1');
		await expect(delta).toHaveValue('0.01');
		await delta.fill('0.02');
		await ceiling.fill('0.999');
		await expect(delta).toHaveValue('0.02');
		await expect(page.getByTestId(TEST_IDS.BiddingPanelDeltaWarning)).toHaveCount(0);
	});

	test('validates default and tier deltas immediately and follows resolved tier prices', async ({
		page
	}, testInfo) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}`
		);
		await page
			.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.Tiers, exact: true })
			.click();
		const defaultDelta = page.locator('#bidding-price-tier-default-delta');
		await defaultDelta.fill('0.00015');
		await expect(defaultDelta).toBeFocused();
		await expect(defaultDelta).toHaveValue('0.00015');
		await expect(page.getByTestId(TEST_IDS.BiddingDefaultDeltaWarning)).toHaveText(
			'Invalid delta. Closest valid value: 0.0002 ETH.'
		);
		await expect(page.getByRole('button', { name: 'save settings' })).toBeDisabled();
		await page.screenshot({
			path: testInfo.outputPath('delta-default-invalid-focused.png'),
			fullPage: true
		});
		await defaultDelta.fill('0.007');
		await page.getByRole('button', { name: 'save settings' }).click();
		expect((await api.nextMutation()).body).toMatchObject({ defaultDeltaEth: '0.007' });

		const form = page.locator('.bidding-price-tier-form');
		const floor = form
			.locator('.bootstrap-form-row')
			.filter({ has: page.locator('label[for="bidding-price-tier-floor-kind"]') })
			.getByPlaceholder('ETH');
		const ceiling = form
			.locator('.bootstrap-form-row')
			.filter({ has: page.locator('label[for="bidding-price-tier-ceiling-kind"]') })
			.getByPlaceholder('ETH');
		const delta = page.locator('#bidding-price-tier-delta');
		const warning = page.getByTestId(TEST_IDS.BiddingPriceTierDeltaWarning);
		await page.locator('#bidding-price-tier-name').fill('Whole ETH');
		await floor.fill('1.3');
		await ceiling.fill('1.4');
		await expect(delta).toHaveValue('0.01');
		await floor.fill('0.3');
		await ceiling.fill('0.4');
		await expect(delta).toHaveValue('0.007');
		await delta.fill('0.0045');
		await expect(delta).toBeFocused();
		await expect(delta).toHaveValue('0.0045');
		await expect(warning).toHaveText('Invalid delta. Closest valid value: 0.005 ETH.');
		await expect(form.getByRole('button', { name: 'create', exact: true })).toBeDisabled();
		await page.screenshot({
			path: testInfo.outputPath('delta-tier-invalid-focused.png'),
			fullPage: true
		});
		await delta.fill('0.005');
		await expect(warning).toHaveCount(0);
		await expect(form.getByRole('button', { name: 'create', exact: true })).toBeEnabled();

		await page.locator('#bidding-price-tier-parent').selectOption('tier-base');
		await page
			.locator('#bidding-price-tier-floor-kind')
			.selectOption(TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta);
		const floorRow = form
			.locator('.bootstrap-form-row')
			.filter({ has: page.locator('label[for="bidding-price-tier-floor-kind"]') });
		await floorRow
			.locator('.bidding-price-tier-delta-kind')
			.selectOption(TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Percent);
		await floorRow.locator('input').fill('300');
		await page
			.locator('#bidding-price-tier-ceiling-kind')
			.selectOption(TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta);
		const ceilingRow = form
			.locator('.bootstrap-form-row')
			.filter({ has: page.locator('label[for="bidding-price-tier-ceiling-kind"]') });
		await ceilingRow.locator('input').fill('0.1');
		await expect(delta).toHaveValue('0.01');
		await delta.fill('0.015');
		await expect(warning).toHaveText('Invalid delta. Closest valid value: 0.02 ETH.');
		await expect(form.getByRole('button', { name: 'create', exact: true })).toBeDisabled();
		await delta.fill('0.02');
		await confirmPriceTierAction(page, 'create:form');
		expect((await api.nextMutation()).body).toMatchObject({
			deltaEth: '0.02',
			floorConfig: {
				kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta,
				deltaKind: TRADING_BIDDING_PRICE_TIER_DELTA_KIND.Percent,
				percent: '300'
			}
		});
	});

	test('blocks an incompatible saved tier delta and offers manual recovery', async ({
		page
	}, testInfo) => {
		await rememberUnfilteredBiddingNavigation(page);
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits}&${BIDDING_E2E_SCENARIO_QUERY_PARAM}=${BIDDING_E2E_SCENARIO.IncompatibleTierDelta}`
		);
		const tiersButton = page.getByRole('button', {
			name: BIDDING_SELECTION_ACTION_LABEL.Tiers,
			exact: true
		});
		await tiersButton.click();
		await page.getByRole('button', { name: 'edit', exact: true }).first().click();
		await expect(page.locator('#bidding-price-tier-delta')).toHaveValue('0.001');
		await expect(page.getByTestId(TEST_IDS.BiddingPriceTierDeltaWarning)).toHaveText(
			'Invalid delta. Closest valid value: 0.01 ETH.'
		);
		await expect(
			page.locator('.bidding-price-tier-form').getByRole('button', { name: 'modify', exact: true })
		).toBeDisabled();
		await tiersButton.click();

		await clickCenterVerifiedAction(
			page
				.locator(
					`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="Mode=Terrain|Zone=Shahra"]`
				)
				.first()
		);
		await page.getByRole('button', { name: 'Base', exact: true }).click({ force: true });
		await expect(page.locator('#bidding-automation-delta')).toHaveValue('0.001');
		await expect(page.locator('#bidding-automation-delta')).toBeDisabled();
		await expect(page.getByTestId(TEST_IDS.BiddingPanelDeltaWarning)).toContainText(
			'Closest valid value: 0.01 ETH.'
		);
		await expect(page.getByTestId(TEST_IDS.BiddingPanelDeltaWarning)).toContainText(
			"Edit the price tier's delta or select manual pricing."
		);
		await expect(page.getByTestId(TEST_IDS.BiddingPanelCreate)).toBeDisabled();
		await page.screenshot({
			path: testInfo.outputPath('delta-saved-tier-invalid.png'),
			fullPage: true
		});
		await page.getByRole('button', { name: 'manual', exact: true }).click({ force: true });
		await expect(page.locator('#bidding-automation-delta')).toHaveValue('0.01');
		await expect(page.getByTestId(TEST_IDS.BiddingPanelDeltaWarning)).toHaveCount(0);
		await expect(page.getByTestId(TEST_IDS.BiddingPanelCreate)).toBeEnabled();
	});

	test('supports panel tier pricing and floating panel keybindings', async ({ page }) => {
		await rememberUnfilteredBiddingNavigation(page);
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);

		await clickCenterVerifiedAction(
			page
				.locator(
					`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="Mode=Terrain|Zone=Shahra"]`
				)
				.first()
		);
		await page.getByRole('button', { name: 'Base' }).click({ force: true });
		await expect(page.locator('#bidding-automation-floor')).toHaveValue('0.300');
		await expect(page.locator('#bidding-automation-floor')).toBeDisabled();
		await expect(page.locator('#bidding-automation-ceiling')).toHaveValue('0.400');
		await expect(page.locator('#bidding-automation-delta')).toHaveValue('0.004');

		await page.getByRole('button', { name: 'manual' }).click({ force: true });
		await expect(page.locator('#bidding-automation-floor')).toBeEnabled();
		await expect(page.locator('#bidding-automation-floor')).toHaveValue('0.300');
		await page.keyboard.press('b');
		await expect(page.getByRole('button', { name: 'show bidding panel' })).toBeVisible();
		await page.keyboard.press('b');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toBeVisible();
		await page.keyboard.press('c');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
	});

	for (const scope of [
		COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
		COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
	]) {
		test(`supports price tier settings and staged reapply controls in ${scope} scope`, async ({
			page
		}, testInfo) => {
			const api = await installBiddingAutomationApiMock(page);
			await openHarnessPage(page, `${BIDDING_PATH}?${BID_SCOPE_QUERY_PARAM}=${scope}`);
			const tiersButton = page.getByRole('button', {
				name: BIDDING_SELECTION_ACTION_LABEL.Tiers,
				exact: true
			});
			await expect(tiersButton).toBeVisible();
			await expect(tiersButton).toHaveAttribute('aria-pressed', 'false');
			await page.screenshot({
				path: testInfo.outputPath(`tiers-${scope}-closed.png`),
				fullPage: true
			});
			await tiersButton.click();
			await expect(page.getByRole('heading', { name: 'price tiers' })).toBeVisible();
			await expect(tiersButton).toHaveAttribute('aria-pressed', 'true');
			await page.screenshot({
				path: testInfo.outputPath(`tiers-${scope}-open.png`),
				fullPage: true
			});
			await tiersButton.click();
			await expect(page.getByRole('heading', { name: 'price tiers' })).toHaveCount(0);
			await expect(tiersButton).toHaveAttribute('aria-pressed', 'false');

			await page.keyboard.press('t');
			await expect(page.getByRole('heading', { name: 'price tiers' })).toBeVisible();
			await expect(page.locator('#bidding-price-tier-delta')).toHaveValue('0.004');

			await page.locator('#bidding-price-tier-selector-mode').check();
			await page.locator('#bidding-price-tier-default-delta').fill('0.007');
			await page.getByRole('button', { name: 'save settings' }).click();
			const settingsMutation = await api.nextMutation();
			expect(settingsMutation.path).toContain('/bidding/settings');
			expect(settingsMutation.body).toMatchObject({
				tierSelectionMode: TRADING_BIDDING_TIER_SELECTION_MODE.Dropdown,
				defaultDeltaEth: '0.007'
			});

			await page.getByRole('button', { name: 'reapply' }).first().click();
			await expect(page.getByRole('region', { name: 'tier reapply preview' })).toBeVisible();
			await expect(page.getByText('0.700 -> 0.300')).toBeVisible();
			await confirmPriceTierAction(page, BIDDING_JOB_REAPPLY_ACTION_KEY);
			const reapplyMutation = await api.nextMutation();
			expect(reapplyMutation.path).toContain('/reapply');
			expect(reapplyMutation.body).toMatchObject({ jobIds: ['job-token-101'] });
		});
	}
});

async function openHarnessPage(page: Page, path: string): Promise<void> {
	await page.goto(path, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');
}

// These scenarios exercise the complete market book after an intentional
// All-bids/reset choice, rather than the default view for a first visit.
async function rememberUnfilteredBiddingNavigation(page: Page): Promise<void> {
	await page.addInitScript((key) => {
		if (!localStorage.getItem(key)) {
			localStorage.setItem(key, JSON.stringify({ ownershipFilter: null, ownStateFilter: null }));
		}
	}, LOCAL_STORAGE_KEYS.collectionBiddingNavigationPreferences);
}

function metaValue(summary: Locator, label: string): Locator {
	return summary
		.locator('.runtime-k')
		.filter({ hasText: new RegExp(`^${label}$`) })
		.locator('..')
		.locator('.runtime-v');
}

async function expectSecondaryTabHoverChrome(locator: Locator): Promise<void> {
	await expect(locator).toBeVisible();
	await locator.hover();
	const colors = await locator.evaluate((element) => {
		const computed = getComputedStyle(element);
		const root = getComputedStyle(document.documentElement);
		const probe = document.createElement('span');
		probe.style.color = root.getPropertyValue('--c-yellow');
		document.body.append(probe);
		const yellow = getComputedStyle(probe).color;
		probe.remove();
		return {
			border: computed.borderTopColor,
			color: computed.color,
			yellow
		};
	});
	expect(colors.border).toBe(colors.yellow);
	expect(colors.color).toBe(colors.yellow);
}

async function expectFieldCenterAligned(panel: Locator, id: string): Promise<void> {
	const label = await panel.locator(`label[for="${id}"]`).boundingBox();
	const field = await panel.locator(`#${id}`).boundingBox();
	expect(label).not.toBeNull();
	expect(field).not.toBeNull();
	expect(
		Math.abs(label!.y + label!.height / 2 - (field!.y + field!.height / 2))
	).toBeLessThanOrEqual(1);
}

async function fillManualPrice(
	page: Page,
	values: { floor: string; ceiling: string; delta: string }
): Promise<void> {
	await page.locator('#bidding-automation-floor').fill(values.floor);
	await page.locator('#bidding-automation-ceiling').fill(values.ceiling);
	await page.locator('#bidding-automation-delta').fill(values.delta);
}

async function confirmPanelAction(page: Page, testId: string): Promise<void> {
	const button = page.locator(`[data-testid="${testId}"]`);
	await expect(button).toBeEnabled();
	await button.click({ force: true });
	await expect(button).toHaveClass(/token-bidding-action-armed/);
	await button.click({ force: true });
}

async function confirmPriceTierAction(page: Page, actionKey: string): Promise<void> {
	const button = page.locator(`[data-price-tier-action="${actionKey}"]`);
	await expect(button).toBeEnabled();
	await button.click({ force: true });
	await expect(button).toHaveClass(/token-bidding-action-armed/);
	await button.click({ force: true });
}

async function clickCenterVerifiedAction(action: Locator): Promise<void> {
	await expect(action).toBeVisible();
	await action.scrollIntoViewIfNeeded();
	const receivesPointerEvents = await action.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const hitTarget = document.elementFromPoint(
			rect.left + rect.width / 2,
			rect.top + rect.height / 2
		);
		return hitTarget !== null && (hitTarget === element || element.contains(hitTarget));
	});
	expect(receivesPointerEvents).toBe(true);
	await action.click({ force: true });
}

async function clickTokenCard(
	page: Page,
	tokenId: string,
	options: { ctrl?: boolean } = {}
): Promise<void> {
	await page.locator(`[data-testid="${TEST_IDS.TokenCard}"][data-token-id="${tokenId}"]`).click({
		modifiers: options.ctrl ? ['Control'] : []
	});
}

function tokenCard(page: Page, tokenId: string): Locator {
	return page.locator(`[data-testid="${TEST_IDS.TokenCard}"][data-token-id="${tokenId}"]`);
}

function rowForJob(page: Page, jobId: string): Locator {
	return page.locator('tr', { has: page.locator(`[data-bidding-job-id="${jobId}"]`) });
}

function ownStatusSelector(kind: TradingBiddingBidBookOwnState): string {
	return `.bid-book-own-status-${kind}`;
}
