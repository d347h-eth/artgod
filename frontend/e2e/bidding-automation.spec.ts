import { expect, test, type Locator, type Page } from 'playwright/test';
import {
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
	TRADING_BIDDING_TIER_SELECTION_MODE,
	TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND,
	TRADING_JOB_STATUS
} from '@artgod/shared/types';
import { TOKEN_BROWSER_STATUS } from '@artgod/shared/types/browse';
import { BIDDING_SELECTION_ACTION_LABEL } from '../src/lib/bidding-selection-actions';
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

const COLLECTION_PATH = '/e2e-harness/collection';
const BIDDING_PATH = `${COLLECTION_PATH}/bidding`;
const MARKET_MAKER_A = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const diagnosticsByTest: PageDiagnosticsRegistry = new Map();

test.beforeEach(({ page }, testInfo) => {
	captureDiagnosticsForTest(diagnosticsByTest, page, testInfo);
});

test.afterEach(async ({}, testInfo) => {
	await attachDiagnosticsForTestFailure(diagnosticsByTest, testInfo);
});

test.describe('bidding automation fixture harness', () => {
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
				traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
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

	test('supports token-offer visible-page refinement and own-status cards', async ({ page }) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=token`);

		await expect(
			page.locator(`[data-testid="${TEST_IDS.TokenCard}"][data-token-id="102"]`)
		).toContainText('queued');
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

	test('keeps token-card link gestures out of bidding selection', async ({ page }) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${COLLECTION_PATH}?token_status=${TOKEN_BROWSER_STATUS.All}`);

		const firstTokenLink = page.locator(`[data-testid="${TEST_IDS.TokenCard}"]`).first().getByRole('link', {
			name: '101'
		});
		await firstTokenLink.click({ modifiers: ['Control'] });

		await expect(page.getByText('1 token selected')).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
	});

	test('supports trait bucket bid and filter actions independently', async ({ page }, testInfo) => {
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
			.locator(`[data-testid="${TEST_IDS.BidBookTraitBucketFilter}"][data-traits="Mode=Terrain|Zone=Shahra"]`)
			.first();
		await clickCenterVerifiedAction(filterAction);
		await expect(page).toHaveURL(/traits=Mode%3ATerrain/);
		await expect(page).toHaveURL(/traits=Zone%3AShahra/);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);

		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);
		await expect(
			page.locator(`[data-testid="${TEST_IDS.BidBookTraitBucketFilter}"][data-traits="Zone=Shahra"]`)
		).toHaveCount(0);

		const bidAction = page
			.locator(`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="Mode=Terrain|Zone=Shahra"]`)
			.first();
		await clickCenterVerifiedAction(bidAction);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toBeVisible();
		await expect(page.locator('#bidding-automation-floor')).toHaveValue('0.421');
		await expect(page.locator('#bidding-automation-delta')).toHaveValue('0.001');
	});

	test('supports top trait bidding with OR filters and existing trait job lookup', async ({ page }) => {
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
			page.locator(`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="Biome=42"]`).first()
		);
		const panel = page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`);
		await expect(panel).toContainText('job-trait-biome-42');
		await expect(page.locator('#bidding-automation-floor')).toHaveValue('0.350');
		await expect(page.locator('#bidding-automation-ceiling')).toHaveValue('0.400');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelModify}"]`)).toBeDisabled();
		await page.locator('#bidding-automation-floor').fill('0.360');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelModify}"]`)).toBeEnabled();
	});

	test('keeps collection bidding explicit and row actions hidden', async ({ page }) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=collection`);

		await expect(page.locator(`[data-testid="${TEST_IDS.BidBookRowBid}"]`)).toHaveCount(0);
		await page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.PlaceCollectionBid }).click();
		const panel = page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`);
		await expect(panel).toBeVisible();
		await expect(panel).toContainText('job-collection');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelActivate}"]`)).toBeEnabled();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelModify}"]`)).toBeDisabled();

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
		expect(mutation.body).toMatchObject({ status: TRADING_JOB_STATUS.Enabled });
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
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText('Zone=Shahra');
		await page.getByRole('button', { name: 'hide' }).click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'show bidding panel' })).toHaveCount(0);

		const traitRowBid = page.locator(`[data-testid="${TEST_IDS.BidBookRowBid}"][data-traits="Biome=42"]`).first();
		await traitRowBid.click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText('Biome=42');
	});

	test('supports token-detail existing job modification and token-row bid action', async ({ page }) => {
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

	test('supports panel tier pricing and floating panel keybindings', async ({ page }) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);

		await clickCenterVerifiedAction(
			page
				.locator(`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"][data-traits="Mode=Terrain|Zone=Shahra"]`)
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

	test('supports price tier settings and staged reapply controls', async ({ page }) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=token`);

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
		await confirmPriceTierAction(page, 'reapply:form');
		const reapplyMutation = await api.nextMutation();
		expect(reapplyMutation.path).toContain('/reapply');
		expect(reapplyMutation.body).toMatchObject({ jobIds: ['job-token-101'] });
	});
});

async function openHarnessPage(page: Page, path: string): Promise<void> {
	await page.goto(path, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');
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
