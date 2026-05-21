import { expect, test, type Page } from 'playwright/test';
import {
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
	TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND
} from '@artgod/shared/types';
import { TEST_IDS } from '../src/lib/test-ids';
import { installBiddingAutomationApiMock } from './helpers/bidding-automation-api';

const COLLECTION_PATH = '/e2e-harness/collection';
const BIDDING_PATH = `${COLLECTION_PATH}/bidding`;
const MARKET_MAKER_A = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test.describe('bidding automation fixture harness', () => {
	test('renders token-scope offers from fixtures and captures a TokenOfferFilter mutation', async ({
		page
	}) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(
			page,
			`${BIDDING_PATH}?bid_scope=token&traits=Zone:Shahra&maker=${MARKET_MAKER_A}`
		);

		await page.getByRole('button', { name: 'bid on all tokens' }).click();
		await expect(page.getByText('1 tokens selected')).toBeVisible();

		await fillManualPrice(page, { floor: '0.210', ceiling: '0.260', delta: '0.004' });
		await confirmPanelAction(page, TEST_IDS.BiddingPanelCreate);

		const mutation = await api.nextMutation();
		expect(mutation.path).toContain('/bidding/jobs/tokens/batch');
		expect(mutation.body).toMatchObject({
			status: 'enabled',
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

	test('supports token-browser trait and explicit-token bidding selections', async ({ page }) => {
		const api = await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${COLLECTION_PATH}?token_status=all&traits=Zone:Shahra`);

		await page.getByRole('button', { name: 'bid on traits' }).click();
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

		await page.getByRole('button', { name: 'clear' }).click();
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

	test('keeps token-card link gestures out of bidding selection', async ({ page }) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${COLLECTION_PATH}?token_status=all`);

		const firstTokenLink = page.locator(`[data-testid="${TEST_IDS.TokenCard}"]`).first().getByRole('link', {
			name: '101'
		});
		await firstTokenLink.click({ modifiers: ['Control'] });

		await expect(page.getByText('1 token selected')).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
	});

	test('supports trait bucket bid and filter actions independently', async ({ page }) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);

		const filterAction = page
			.locator(`[data-testid="${TEST_IDS.BidBookTraitBucketFilter}"][data-traits="Mode=Terrain|Zone=Shahra"]`)
			.first();
		await expect(filterAction).toBeVisible();
		await filterAction.click();
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
		await bidAction.click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toBeVisible();
		await expect(page.locator('#bidding-automation-floor')).toHaveValue('0.421');
		await expect(page.locator('#bidding-automation-delta')).toHaveValue('0.001');
	});

	test('keeps collection bidding explicit and row actions hidden', async ({ page }) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=collection`);

		await expect(page.locator(`[data-testid="${TEST_IDS.BidBookRowBid}"]`)).toHaveCount(0);
		await page.getByRole('button', { name: 'place collection bid' }).click();
		const panel = page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`);
		await expect(panel).toBeVisible();
		await expect(panel).toContainText('job-collection');
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelActivate}"]`)).toBeEnabled();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanelModify}"]`)).toBeDisabled();
	});

	test('supports token detail token and trait bid actions while hiding collection row actions', async ({
		page
	}) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, `${COLLECTION_PATH}/101`);

		await expect(page.getByRole('button', { name: /^place bid on collection/ })).toHaveCount(0);
		await page.getByRole('button', { name: 'bid on token' }).click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText('#101');

		await page.getByRole('button', { name: 'place bid on Zone=Shahra' }).click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText('Zone=Shahra');

		const traitRowBid = page.locator(`[data-testid="${TEST_IDS.BidBookRowBid}"][data-traits="Biome=42"]`).first();
		await traitRowBid.click();
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toContainText('Biome=42');
	});
});

async function openHarnessPage(page: Page, path: string): Promise<void> {
	await page.goto(path, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');
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
	await button.click();
	await expect(button).toHaveClass(/token-bidding-action-armed/);
	await button.click();
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
