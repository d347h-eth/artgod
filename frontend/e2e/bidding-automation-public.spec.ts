import { expect, test, type Page } from 'playwright/test';
import { BIDDING_SELECTION_ACTION_LABEL } from '../src/lib/bidding-selection-actions';
import { TEST_IDS } from '../src/lib/test-ids';

const COLLECTION_PATH = '/e2e-harness/collection';
const BIDDING_PATH = `${COLLECTION_PATH}/bidding`;

test.describe('bidding automation public read-only guardrails', () => {
	test('renders offers bid books without local bidding write controls', async ({ page }) => {
		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=token`);

		await expect(page.locator('.bid-book-meta')).toContainText('normal');
		await expect(page.locator(`[data-testid="${TEST_IDS.TokenCard}"][data-token-id="101"]`)).toBeVisible();
		await expect(
			page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnAllTokens })
		).toHaveCount(0);
		await expect(page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.Tiers })).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);

		await openHarnessPage(page, `${BIDDING_PATH}?bid_scope=traits`);
		await expect(page.locator('.bid-book-meta')).toContainText('targets');
		await expect(page.locator(`[data-testid="${TEST_IDS.BidBookTraitBucketBid}"]`)).toHaveCount(0);
	});

	test('renders token detail bid book without local bidding write controls', async ({ page }) => {
		await openHarnessPage(page, `${COLLECTION_PATH}/101`);

		await expect(page.locator('.bid-book-meta')).toContainText('normal');
		await expect(page.getByRole('button', { name: BIDDING_SELECTION_ACTION_LABEL.BidOnToken })).toHaveCount(
			0
		);
		await expect(page.getByRole('button', { name: /^place bid on / })).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BidBookRowBid}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BiddingPanel}"]`)).toHaveCount(0);
	});
});

async function openHarnessPage(page: Page, path: string): Promise<void> {
	await page.goto(path, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');
}
