import { expect, test, type Locator, type Page } from 'playwright/test';
import { OPENSEA_COLLECTION_SLUG_PROBE_ERROR } from '@artgod/shared/opensea/collection-slug-probe';
import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
import {
	BOOTSTRAP_ENUMERATION_MODE,
	BOOTSTRAP_STEP_ACTION,
	BOOTSTRAP_STEP_KEY
} from '@artgod/shared/bootstrap/pipeline';
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from '@artgod/shared/media/token-metadata-image-source';
import { TOKEN_METADATA_ANIMATION_SOURCE_FIELD } from '@artgod/shared/media/token-metadata-animation-source';
import { TEST_IDS } from '../src/lib/test-ids';
import {
	attachDiagnosticsForTestFailure,
	captureDiagnosticsForTest,
	type PageDiagnosticsRegistry
} from './attached-app';
import {
	BOOTSTRAP_PROBE_E2E_ROUTE_PATH,
	BOOTSTRAP_PROBE_CONTRACTS,
	BOOTSTRAP_PROBE_OPENSEA_SLUGS,
	BOOTSTRAP_PROBE_SHARED_MANUAL_SCOPE,
	installBootstrapProbeApiMock
} from './helpers/bootstrap-probe-api';
import {
	BOOTSTRAP_RUN_DETAIL_E2E_ROUTE_PATH,
	installBootstrapRunDetailApiMock
} from './helpers/bootstrap-run-detail-api';
import {
	COLLECTION_OPENSEA_SYNC_E2E_ROUTE_PATH,
	installCollectionOpenSeaSyncApiMock
} from './helpers/collection-opensea-sync-api';
import {
	COLLECTION_OPENSEA_SNAPSHOT_E2E_COLLECTION,
	COLLECTION_OPENSEA_SNAPSHOT_E2E_TIMESTAMP,
	COLLECTION_OPENSEA_SYNC_E2E_COLLECTION,
	COLLECTION_OPENSEA_SYNC_E2E_SLUG,
	COLLECTION_OPENSEA_SYNC_E2E_UNAVAILABLE_ROUTE_PATH
} from '../src/lib/e2e/collection-opensea-sync-fixtures';
import { BOOTSTRAP_CONTRACT_ADDRESS_SAFETY_ACKNOWLEDGEMENT } from '../src/lib/bootstrap-contract-probe';

const diagnosticsByTest: PageDiagnosticsRegistry = new Map();
// Confirms the late-sync slug field uses the wider shared slug-input control.
const COLLECTION_OPENSEA_SYNC_SLUG_INPUT_MIN_WIDTH_PX = 250;
const SHARED_ENUMERABLE_SAMPLE_TOKEN_ID = '282000000';
const SHARED_ENUMERABLE_RANGE_TOTAL_SUPPLY = '1024';

test.beforeEach(({ page }, testInfo) => {
	captureDiagnosticsForTest(diagnosticsByTest, page, testInfo);
});

test.afterEach(async ({}, testInfo) => {
	await attachDiagnosticsForTestFailure(diagnosticsByTest, testInfo);
});

test.describe('bootstrap contract probe UI', () => {
	test('keeps all staged inputs visible and makes no requests while editing', async ({
		page
	}, testInfo) => {
		const api = await installBootstrapProbeApiMock(page);
		await page.goto(BOOTSTRAP_PROBE_E2E_ROUTE_PATH);
		const address = page.locator('input[name="address"]');
		await expect(address).toBeDisabled();
		await expect(page.locator('input[name="sampleTokenId"]')).toBeVisible();
		await expect(rowControl(page, 'Image source field')).toBeVisible();
		await expect(rowControl(page, 'Animation source field')).toBeVisible();
		await expect(rowControl(page, 'Manual range start token ID')).toBeVisible();
		await contractAddressSafetyAcknowledgement(page).check();
		await address.fill(BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
		await page
			.locator('input[name="sampleTokenId"]')
			.fill(BOOTSTRAP_PROBE_SHARED_MANUAL_SCOPE.sampleTokenId);
		await rowControl(page, 'Image source field').fill(TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image);
		await rowControl(page, 'Image source field').clear();
		await expect(page.locator('input[name="sampleTokenId"]')).toHaveValue(
			BOOTSTRAP_PROBE_SHARED_MANUAL_SCOPE.sampleTokenId
		);
		await rowControl(page, 'Manual range total supply').fill(
			String(BOOTSTRAP_PROBE_SHARED_MANUAL_SCOPE.totalSupply)
		);
		await expect(page.getByRole('button', { name: 'Probe', exact: true })).toBeEnabled();
		expect(api.probeRequests).toEqual([]);
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual([]);
		expect(api.imageCacheEstimateRequests).toEqual([]);
		await page.screenshot({ path: testInfo.outputPath('staged-inputs.png'), fullPage: true });
	});

	test('uses one sample and preserves the independent scope through probing and queueing', async ({
		page
	}, testInfo) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
		const sample = BOOTSTRAP_PROBE_SHARED_MANUAL_SCOPE.sampleTokenId;
		await page.locator('input[name="sampleTokenId"]').fill(sample);
		await page.getByRole('button', { name: 'Probe', exact: true }).click();
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		expect(api.probeRequestSampleTokenIds).toEqual([sample]);
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual([sample]);
		await expect(rowControl(page, 'Manual range start token ID')).toHaveValue('1');
		await expect(rowControl(page, 'Manual range total supply')).toHaveValue('999');
		await expect(page.locator('input[name="slug"]')).toHaveValue('curated-collection');
		await expect(rowControl(page, 'Manual range total supply')).toBeEnabled();
		await expect(page.getByTestId(TEST_IDS.BootstrapAllowManualEditing)).toHaveCount(0);
		// Scope edits do not cause marketplace calls, including for an unminted upper boundary.
		await rowControl(page, 'Manual range total supply').fill('1000');
		await expect(page.getByRole('button', { name: 'queue bootstrap' })).toBeEnabled();
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual([sample]);
		await page.screenshot({ path: testInfo.outputPath('sample-resolved.png'), fullPage: true });
		await page.getByRole('button', { name: 'queue bootstrap' }).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).toMatchObject({
			slug: 'curated-collection',
			manualInput: {
				mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
				startTokenId: '1',
				totalSupply: 1000
			},
			openseaSlug: BOOTSTRAP_PROBE_OPENSEA_SLUGS.SharedManualScope
		});
	});

	test('keeps shared enumerable contracts in the user-selected manual scope', async ({ page }) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
		await page.locator('input[name="sampleTokenId"]').fill(SHARED_ENUMERABLE_SAMPLE_TOKEN_ID);
		await rowControl(page, 'Manual range start token ID').fill(SHARED_ENUMERABLE_SAMPLE_TOKEN_ID);
		await rowControl(page, 'Manual range total supply').fill(SHARED_ENUMERABLE_RANGE_TOTAL_SUPPLY);
		await page.getByRole('button', { name: 'Probe', exact: true }).click();
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		await expect(rowControl(page, 'Use ERC721Enumerable token enumeration')).not.toBeChecked();
		await expect(formRow(page, 'ERC721Enumerable interface')).toContainText('yes');
		await expect(rowControl(page, 'Manual range total supply')).toHaveValue(
			SHARED_ENUMERABLE_RANGE_TOTAL_SUPPLY
		);
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual([SHARED_ENUMERABLE_SAMPLE_TOKEN_ID]);
		await page.locator('input[name="sampleTokenId"]').fill('4000000');
		await expect(page.getByRole('button', { name: 'queue bootstrap' })).toBeDisabled();
		expect(api.probeRequests).toHaveLength(1);
		await expect(rowControl(page, 'Manual range start token ID')).toHaveValue(
			SHARED_ENUMERABLE_SAMPLE_TOKEN_ID
		);
	});

	test('accepts detected metadata fields only after the explicit apply action', async ({
		page
	}) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await rowControl(page, 'Image source field').clear();
		await page.locator('input[name="sampleTokenId"]').clear();
		await page.getByRole('button', { name: 'Probe', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Apply detected fields' })).toBeVisible();
		await expect(rowControl(page, 'Image source field')).toHaveValue('');
		await expect(page.locator('input[name="sampleTokenId"]')).toHaveValue('');
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual([]);
		await page.getByRole('button', { name: 'Apply detected fields' }).click();
		await expect(rowControl(page, 'Image source field')).toHaveValue(
			TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image
		);
		await expect(page.locator('input[name="sampleTokenId"]')).toHaveValue('1');
		await expect(rowControl(page, 'Manual range total supply')).toHaveValue('999');
		await expect(page.locator('input[name="slug"]')).toHaveValue('curated-collection');
		expect(api.probeRequests).toHaveLength(1);
	});

	test('preserves inputs after an error and allows explicit recovery', async ({
		page
	}, testInfo) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await page.route(
			'**/collections/bootstrap/probe?**',
			(route) =>
				route.fulfill({
					status: 422,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'unavailable' })
				}),
			{ times: 1 }
		);
		await page.getByRole('button', { name: 'Probe', exact: true }).click();
		await expect(formRow(page, 'Contract probe status')).toContainText('probe failed');
		await expect(page.locator('input[name="sampleTokenId"]')).toHaveValue('2');
		await expect(rowControl(page, 'Manual range total supply')).toHaveValue('999');
		await page.screenshot({ path: testInfo.outputPath('probe-error.png'), fullPage: true });
		const warningBox = await page.locator('.bootstrap-contract-address-warning').boundingBox();
		const errorSectionBox = await page.locator('.bootstrap-probe-section').boundingBox();
		expect(errorSectionBox?.width).toBeLessThanOrEqual((warningBox?.width ?? 0) + 2);
		await page.getByRole('button', { name: 'Probe', exact: true }).click();
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		expect(api.probeRequests).toHaveLength(1);
	});

	test('allows onchain bootstrap while an optional OpenSea slug is incorrect', async ({ page }) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await page.locator('input[name="openseaSlug"]').fill('another-project');
		await page.getByRole('button', { name: 'Probe', exact: true }).click();
		await expect(formRow(page, 'OpenSea slug')).toContainText('incorrect');
		await page.getByRole('button', { name: 'queue bootstrap' }).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).not.toHaveProperty('openseaSlug');
	});

	test('rejects a sample outside a manually edited range', async ({ page }) => {
		await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await page.getByRole('button', { name: 'Probe', exact: true }).click();
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		await rowControl(page, 'Manual range start token ID').fill('10');
		await expect(page.getByRole('button', { name: 'queue bootstrap' })).toBeDisabled();
		await expect(
			page.getByText('Sample token ID must be inside the collection range.')
		).toBeVisible();
	});

	test('validates explicit token lists without querying OpenSea again', async ({ page }) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await page.getByRole('button', { name: 'Probe', exact: true }).click();
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		await rowControl(page, 'Manual token scope mode').selectOption(
			BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
		);
		await rowControl(page, 'Manual token IDs').fill('1, 3');
		await expect(page.getByRole('button', { name: 'queue bootstrap' })).toBeDisabled();
		await rowControl(page, 'Manual token IDs').fill('1, invalid, 2');
		await expect(
			page.getByText('Enter decimal token IDs separated by commas or spaces.')
		).toBeVisible();
		await rowControl(page, 'Manual token IDs').fill('1, 2, 3');
		await expect(page.getByRole('button', { name: 'queue bootstrap' })).toBeEnabled();
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual(['2']);
	});

	test('lets users turn off an old Enumerable selection after changing contracts', async ({
		page
	}) => {
		await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
		await page.getByRole('button', { name: 'Probe', exact: true }).click();
		await expect(rowControl(page, 'Use ERC721Enumerable token enumeration')).toBeEnabled();
		await rowControl(page, 'Use ERC721Enumerable token enumeration').check();
		await page.locator('input[name="address"]').fill(BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await page.getByRole('button', { name: 'Probe', exact: true }).click();
		await expect(
			page.getByText(
				'Enumerable support was not confirmed. Turn off whole-contract enumeration and specify the token scope.'
			)
		).toBeVisible();
		await rowControl(page, 'Use ERC721Enumerable token enumeration').uncheck();
		await expect(rowControl(page, 'Manual range total supply')).toHaveValue('999');
	});

	test('keeps cache estimation explicit and supports optional animation', async ({
		page
	}, testInfo) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
		await rowControl(page, 'Animation source field').fill(
			TOKEN_METADATA_ANIMATION_SOURCE_FIELD.AnimationUrl
		);
		await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.CacheOnce);
		await page.getByRole('button', { name: 'Probe', exact: true }).click();
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		await expect(formRow(page, 'Animation source field')).toContainText('resolved');
		expect(api.imageCacheEstimateRequests).toEqual([]);
		await page.getByRole('button', { name: 'estimate', exact: true }).click();
		await expect(formRow(page, 'Cached image max dimension')).toContainText('estimated');
		expect(api.imageCacheEstimateRequests).toHaveLength(1);
		await page.screenshot({ path: testInfo.outputPath('cache-estimated.png'), fullPage: true });
	});
});

async function stageManualProbe(page: Page, address: string) {
	const api = await installBootstrapProbeApiMock(page);
	await page.goto(BOOTSTRAP_PROBE_E2E_ROUTE_PATH);
	await contractAddressSafetyAcknowledgement(page).check();
	await page.locator('input[name="address"]').fill(address);
	await page.locator('input[name="sampleTokenId"]').fill('2');
	await rowControl(page, 'Image source field').fill(TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image);
	await rowControl(page, 'Manual range start token ID').fill('1');
	await rowControl(page, 'Manual range total supply').fill('999');
	await page.locator('input[name="slug"]').fill('curated-collection');
	await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.Off);
	return api;
}

test.describe('bootstrap run detail UI', () => {
	test('renders progress and toggles image-cache pause resume actions', async ({ page }) => {
		const api = await installBootstrapRunDetailApiMock(page);
		await page.goto(BOOTSTRAP_RUN_DETAIL_E2E_ROUTE_PATH);

		const flow = page.getByRole('list', { name: 'bootstrap flow' });
		await expect(flow).toBeVisible();
		await expect(flow.getByText('metadata', { exact: true })).toBeVisible();
		await expect(page.getByText('1000 / 1000')).toHaveCount(2);
		await expect(page.getByText('600 / 1000')).toBeVisible();
		await expect(page.getByText('60%')).toBeVisible();
		await expect(page.getByText('collection live')).toBeVisible();
		await expect(page.getByText('next refresh')).toBeVisible();
		await expect(page.getByRole('button', { name: 'refresh' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'retry failed' })).toHaveCount(0);
		await expect(page.getByText('metadata mode')).toHaveCount(0);
		await expect(page.getByText('enumeration')).toHaveCount(0);
		await expect(page.getByText('anchor block')).toHaveCount(0);
		await page.waitForTimeout(1200);
		expect(api.detailRequests).toBe(0);

		await page.getByRole('button', { name: 'pause image cache' }).click();
		await expect.poll(() => api.actions.length).toBe(1);
		expect(api.actions[0]).toMatchObject({
			stepKey: BOOTSTRAP_STEP_KEY.ImageCache,
			action: BOOTSTRAP_STEP_ACTION.Pause
		});
		await expect(page.getByRole('button', { name: 'resume image cache' })).toBeVisible();
		await expect(page.getByText('paused')).toBeVisible();

		await page.getByRole('button', { name: 'resume image cache' }).click();
		await expect.poll(() => api.actions.length).toBe(2);
		expect(api.actions[1]).toMatchObject({
			stepKey: BOOTSTRAP_STEP_KEY.ImageCache,
			action: BOOTSTRAP_STEP_ACTION.Resume
		});
		await expect(page.getByRole('button', { name: 'pause image cache' })).toBeVisible();
		await expect.poll(() => api.detailRequests).toBeGreaterThan(0);
	});
});

test.describe('collection OpenSea sync UI', () => {
	test('shows and toggles the latest OpenSea snapshot time', async ({ page }, testInfo) => {
		await page.goto(COLLECTION_OPENSEA_SYNC_E2E_ROUTE_PATH);

		await expect(page.getByRole('columnheader', { name: 'OpenSea snapshot' })).toBeVisible();
		const snapshotTime = page.getByRole('button', {
			name: `toggle ${COLLECTION_OPENSEA_SNAPSHOT_E2E_COLLECTION.slug} OpenSea snapshot time mode`
		});
		await expect(snapshotTime).toBeVisible();
		await expect(snapshotTime).toHaveAttribute('title', COLLECTION_OPENSEA_SNAPSHOT_E2E_TIMESTAMP);
		await snapshotTime.click();
		await expect(snapshotTime).toHaveText(COLLECTION_OPENSEA_SNAPSHOT_E2E_TIMESTAMP);

		const screenshotPath = testInfo.outputPath('collections-opensea-snapshot-time.png');
		await page.screenshot({ path: screenshotPath, fullPage: true });
		await testInfo.attach('collections-opensea-snapshot-time.png', {
			path: screenshotPath,
			contentType: 'image/png'
		});
	});

	test('explains when OpenSea setup status is not available yet', async ({ page }) => {
		await page.goto(COLLECTION_OPENSEA_SYNC_E2E_UNAVAILABLE_ROUTE_PATH);
		await page.getByRole('button', { name: 'start opensea sync' }).click();

		const dialog = page.getByRole('dialog', { name: 'start opensea sync' });
		await expect(dialog.locator('input[name="openseaSlug"]')).toBeDisabled();
		await expect(dialog).toContainText('OpenSea setup status is not available yet');
		await expect(dialog).toContainText('try again after app startup finishes');
		await expect(dialog).toContainText('fully restart the app');
	});

	test('explains when late sync has no locally owned sample and allows retry', async ({
		page
	}, testInfo) => {
		await installCollectionOpenSeaSyncApiMock(page);
		await page.route(
			'**/opensea/slug-probe*',
			(route) =>
				route.fulfill({
					status: 422,
					contentType: 'application/json',
					body: JSON.stringify({
						message: OPENSEA_COLLECTION_SLUG_PROBE_ERROR.LocalSampleUnavailable
					})
				}),
			{ times: 1 }
		);
		await page.goto(COLLECTION_OPENSEA_SYNC_E2E_ROUTE_PATH);
		await page.getByRole('button', { name: 'start opensea sync' }).click();
		const dialog = page.getByRole('dialog', { name: 'start opensea sync' });
		await dialog.getByRole('button', { name: 'resolve', exact: true }).click();
		await expect(dialog).toContainText(OPENSEA_COLLECTION_SLUG_PROBE_ERROR.LocalSampleUnavailable);
		await expect(dialog.getByRole('button', { name: 'start sync' })).toBeDisabled();
		const dialogBox = await dialog.boundingBox();
		const resolveBox = await dialog
			.getByRole('button', { name: 'resolve', exact: true })
			.boundingBox();
		const padding = await dialog.evaluate((node) =>
			Number.parseFloat(getComputedStyle(node).paddingRight)
		);
		expect((resolveBox?.x ?? 0) + (resolveBox?.width ?? 0)).toBeLessThanOrEqual(
			(dialogBox?.x ?? 0) + (dialogBox?.width ?? 0) - padding + 1
		);
		await page.screenshot({
			path: testInfo.outputPath('local-sample-unavailable.png'),
			fullPage: true
		});
		await dialog.getByRole('button', { name: 'resolve', exact: true }).click();
		await expect(dialog.getByRole('button', { name: 'start sync' })).toBeEnabled();
	});

	test('resolves and re-verifies a shared-contract collection slug', async ({ page }, testInfo) => {
		const api = await installCollectionOpenSeaSyncApiMock(page);
		await page.goto(COLLECTION_OPENSEA_SYNC_E2E_ROUTE_PATH);
		await page.getByRole('button', { name: 'start opensea sync' }).click();

		const dialog = page.getByRole('dialog', { name: 'start opensea sync' });
		const slugInput = dialog.locator('input[name="openseaSlug"]');
		const startButton = dialog.getByRole('button', { name: 'start sync' });
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText(COLLECTION_OPENSEA_SYNC_E2E_COLLECTION.slug);
		await expect(dialog).toContainText(COLLECTION_OPENSEA_SYNC_E2E_COLLECTION.address);
		await expect(dialog).toContainText('462000000');
		await expect(dialog).toContainText('400');
		expect(api.probeSlugs).toEqual([]);
		await dialog.getByRole('button', { name: 'resolve', exact: true }).click();
		await expect(slugInput).toHaveValue(COLLECTION_OPENSEA_SYNC_E2E_SLUG);
		await expect(slugInput).toBeEnabled();
		const slugInputBox = await slugInput.boundingBox();
		expect(slugInputBox).not.toBeNull();
		if ((page.viewportSize()?.width ?? 0) >= 900) {
			expect(slugInputBox?.width ?? 0).toBeGreaterThanOrEqual(
				COLLECTION_OPENSEA_SYNC_SLUG_INPUT_MIN_WIDTH_PX
			);
		}
		await expect(dialog).toContainText('resolved');
		await expect(startButton).toBeEnabled();
		const resolvedScreenshotPath = testInfo.outputPath('collection-opensea-sync-resolved.png');
		await page.screenshot({ path: resolvedScreenshotPath, fullPage: true });
		await testInfo.attach('collection-opensea-sync-resolved.png', {
			path: resolvedScreenshotPath,
			contentType: 'image/png'
		});
		expect(api.probeSlugs).toEqual([null]);

		await slugInput.fill('sibling-art-blocks-project');
		await dialog.getByRole('button', { name: 'resolve' }).click();
		await expect(dialog).toContainText('incorrect');
		await expect(dialog).toContainText("Check this collection's OpenSea slug, then resolve again");
		await expect(startButton).toBeDisabled();
		const incorrectScreenshotPath = testInfo.outputPath('collection-opensea-sync-incorrect.png');
		await page.screenshot({ path: incorrectScreenshotPath, fullPage: true });
		await testInfo.attach('collection-opensea-sync-incorrect.png', {
			path: incorrectScreenshotPath,
			contentType: 'image/png'
		});

		await slugInput.fill(COLLECTION_OPENSEA_SYNC_E2E_SLUG);
		await dialog.getByRole('button', { name: 'resolve' }).click();
		await expect(dialog).toContainText('resolved');
		await expect(startButton).toBeEnabled();
		await startButton.click();
		await expect.poll(() => api.syncSlugs).toEqual([COLLECTION_OPENSEA_SYNC_E2E_SLUG]);
		expect(api.probeSlugs).toEqual([
			null,
			'sibling-art-blocks-project',
			COLLECTION_OPENSEA_SYNC_E2E_SLUG
		]);
	});
});

function contractAddressSafetyAcknowledgement(page: Page): Locator {
	return page.getByRole('checkbox', { name: BOOTSTRAP_CONTRACT_ADDRESS_SAFETY_ACKNOWLEDGEMENT });
}

function formRow(page: Page, label: string) {
	return page.locator('.bootstrap-form-fields .bootstrap-form-row').filter({
		has: page
			.locator('.bootstrap-form-label-cell > span:first-child')
			.filter({ hasText: new RegExp('^' + label + '$') })
	});
}
function rowControl(page: Page, label: string) {
	return formRow(page, label).locator('input, select, textarea');
}
