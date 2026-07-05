import { expect, test, type Page, type TestInfo } from 'playwright/test';
import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
import { BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION } from '@artgod/shared/config/bootstrap';
import { OPENSEA_API_KEY_ENV } from '@artgod/shared/config/opensea-integration';
import { TERRAFORMS_EXTENSION_KEY } from '@artgod/shared/extensions/terraforms';
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from '@artgod/shared/types';
import { BOOTSTRAP_STEP_ACTION, BOOTSTRAP_STEP_KEY } from '@artgod/shared/bootstrap/pipeline';
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from '@artgod/shared/media/token-metadata-image-source';
import { TEST_IDS } from '../src/lib/test-ids';
import { DEFAULT_BOOTSTRAP_METADATA_MODE } from '../src/lib/bootstrap-metadata-mode';
import {
	attachDiagnosticsForTestFailure,
	captureDiagnosticsForTest,
	type PageDiagnosticsRegistry
} from './attached-app';
import {
	BOOTSTRAP_PROBE_E2E_ROUTE_PATH,
	BOOTSTRAP_PROBE_CONTRACTS,
	BOOTSTRAP_PROBE_MEDIA,
	BOOTSTRAP_PROBE_OPENSEA_SLUGS,
	installBootstrapProbeApiMock
} from './helpers/bootstrap-probe-api';
import {
	BOOTSTRAP_RUN_DETAIL_E2E_ROUTE_PATH,
	installBootstrapRunDetailApiMock
} from './helpers/bootstrap-run-detail-api';

const diagnosticsByTest: PageDiagnosticsRegistry = new Map();

test.beforeEach(({ page }, testInfo) => {
	captureDiagnosticsForTest(diagnosticsByTest, page, testInfo);
});

test.afterEach(async ({}, testInfo) => {
	await attachDiagnosticsForTestFailure(diagnosticsByTest, testInfo);
});

test.describe('bootstrap contract probe UI', () => {
	test('starts with only the contract address input in the bootstrap form', async ({ page }) => {
		await page.goto(BOOTSTRAP_PROBE_E2E_ROUTE_PATH);

		await expect(page.locator('input[name="address"]')).toBeVisible();
		await expect(formLabel(page, 'Image source field')).toHaveCount(0);
		await expect(formLabel(page, 'Collection slug')).toHaveCount(0);
		await expect(formLabel(page, 'OpenSea slug')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'queue bootstrap' })).toHaveCount(0);
		await expect(page.locator(`[data-testid="${TEST_IDS.BootstrapProbeTokenCard}"]`)).toHaveCount(
			0
		);
	});

	test('renders non-enumerable probe data as locked probe-derived fields', async ({
		page
	}, testInfo) => {
		const api = await installBootstrapProbeApiMock(page);
		await openBootstrapProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);

		const card = tokenCard(page, '1');
		await expect(card).toBeVisible();
		await assertTokenBrowserCardScale(card);
		await expect(card.locator('.token-grid-meta')).toHaveCount(0);
		await expect(card.locator('img')).toHaveAttribute(
			'src',
			BOOTSTRAP_PROBE_MEDIA.NonEnumerableImage
		);
		await expect(page.locator('input[name="slug"]')).toHaveValue(
			BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable
		);
		await expect(rowControl(page, 'Image source field')).toHaveValue(
			TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image
		);
		await expect(formRow(page, 'Image source field')).toContainText('resolved');
		await expect(page.locator('input[name="slug"]')).toBeEnabled();
		await expect(page.locator('input[name="openseaSlug"]')).toHaveValue(
			BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable
		);
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		await expect(formRow(page, 'OpenSea slug').getByRole('button', { name: 'resolve' })).toHaveCount(
			0
		);
		await expect(page.getByText('Metadata size (1 token)')).toBeVisible();
		await expect(page.getByText('Original image source size (1 token)')).toBeVisible();
		await expect(formRow(page, 'Image cache plan')).toContainText('cache local files once');
		await expect(formLabel(page, 'Preview token')).toHaveCount(0);

		const startTokenInput = rowControl(page, 'Manual range start token ID');
		const totalSupplyInput = rowControl(page, 'Manual range total supply');
		await expect(startTokenInput).toHaveValue('1');
		await expect(totalSupplyInput).toHaveValue('1000');
		await expect(totalSupplyInput).toHaveAttribute('type', 'text');
		await expect(startTokenInput).toBeDisabled();
		await expect(totalSupplyInput).toBeDisabled();

		await page.locator(`[data-testid="${TEST_IDS.BootstrapAllowManualEditing}"]`).check();
		await expect(startTokenInput).toBeEnabled();
		await expect(totalSupplyInput).toBeEnabled();
		await expect(page.getByText('use only if you know what you are doing')).toBeVisible();

		await assertEveryBootstrapRowHasInfoTooltip(page);
		await assertTokenCardPlacement(page, testInfo);
		await assertTooltipText(page, 'OpenSea slug', 'Required for bidding');
		await expect(formLabel(page, 'Metadata mode')).toHaveCount(0);
		expect(api.probeRequests).toEqual([BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable]);
		expect(api.probeRequestImageSourceFields).toEqual([null]);
		expect(api.openSeaSlugProbeRequests).toEqual([BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable]);
	});

	test('requires manual image source overrides to probe again before showing the full form', async ({
		page
	}) => {
		const api = await installBootstrapProbeApiMock(page);
		await openBootstrapProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);

		const imageSourceInput = rowControl(page, 'Image source field');
		await expect(imageSourceInput).toHaveValue(TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image);
		await imageSourceInput.fill(TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData);

		await expect(formLabel(page, 'Collection slug')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'queue bootstrap' })).toHaveCount(0);
		await expect(
			formRow(page, 'Image source field').getByRole('button', { name: 'probe again' })
		).toBeEnabled();

		await imageSourceInput.press('Enter');
		await expect(rowControl(page, 'Image source field')).toHaveValue(
			TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData
		);
		await expect(formRow(page, 'Image source field')).toContainText('resolved');
		await expect(formLabel(page, 'Collection slug')).toBeVisible();
		await expect(page.getByRole('button', { name: 'queue bootstrap' })).toBeVisible();
		expect(api.probeRequests).toEqual([
			BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable,
			BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable
		]);
		expect(api.probeRequestImageSourceFields).toEqual([
			null,
			TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData
		]);
	});

	test('disables OpenSea slug input when the API key is unavailable', async ({ page }) => {
		const api = await installBootstrapProbeApiMock(page);
		await page.goto(`${BOOTSTRAP_PROBE_E2E_ROUTE_PATH}?opensea=disabled`);
		await page.locator('input[name="address"]').fill(BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);

		const openSeaSlugInput = page.locator('input[name="openseaSlug"]');
		await expect(openSeaSlugInput).toBeDisabled();
		await expect(formRow(page, 'OpenSea slug')).toContainText(OPENSEA_API_KEY_ENV);
		await expect(formRow(page, 'OpenSea slug')).toContainText('Admin UI');
		await expect(formRow(page, 'OpenSea slug')).toContainText('Fully restart the app');
		await assertOpenSeaDisabledNoteFitsSlugInput(page);
		expect(api.openSeaSlugProbeRequests).toEqual([]);
	});

	test('verifies manually edited OpenSea slugs before allowing submit', async ({ page }) => {
		const api = await installBootstrapProbeApiMock(page);
		await openBootstrapProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);

		const openSeaSlugInput = rowControl(page, 'OpenSea slug');
		const openSeaSlugSubmit = formRow(page, 'OpenSea slug').getByRole('button', {
			name: 'resolve'
		});
		await expect(openSeaSlugInput).toHaveValue(BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable);
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		await openSeaSlugInput.fill('missing-opensea-slug');
		await expect(openSeaSlugSubmit).toBeEnabled();
		await expect(formRow(page, 'OpenSea slug')).not.toContainText('resolved');
		expect(api.openSeaSlugVerificationRequests).toEqual([]);
		await openSeaSlugInput.press('Enter');
		await expect(formRow(page, 'OpenSea slug')).toContainText('incorrect');
		await openSeaSlugInput.fill(BOOTSTRAP_PROBE_OPENSEA_SLUGS.EnumerableOnchainSvg);
		await expect(openSeaSlugSubmit).toBeEnabled();
		await expect(formRow(page, 'OpenSea slug')).not.toContainText('incorrect');
		await openSeaSlugSubmit.click();
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		expect(api.openSeaSlugVerificationRequests).toEqual([
			'missing-opensea-slug',
			BOOTSTRAP_PROBE_OPENSEA_SLUGS.EnumerableOnchainSvg
		]);
	});

	test('uses the tokenURI image for enumerable raster previews instead of animation_url', async ({
		page
	}) => {
		const dynamicRequests: string[] = [];
		page.on('request', (request) => {
			const url = request.url();
			if (url.startsWith('https://dynamic.example/')) {
				dynamicRequests.push(url);
			}
		});

		const api = await installBootstrapProbeApiMock(page);
		await openBootstrapProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);

		const card = tokenCard(page, '0');
		await expect(card).toBeVisible();
		await expect(card.locator('img')).toHaveAttribute('src', BOOTSTRAP_PROBE_MEDIA.RasterImage);
		await expect(page.locator('input[name="slug"]')).toHaveValue(
			BOOTSTRAP_PROBE_OPENSEA_SLUGS.EnumerableRaster
		);
		await expect(rowControl(page, 'Image source field')).toHaveValue(
			TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image
		);
		await expect(page.locator('input[name="openseaSlug"]')).toHaveValue(
			BOOTSTRAP_PROBE_OPENSEA_SLUGS.EnumerableRaster
		);
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		await page.locator('input[name="slug"]').fill('custom-raster-slug');
		expect(api.probeRequests).toEqual([BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster]);
		expect(api.openSeaSlugProbeRequests).toEqual([BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster]);
		await expect(page.getByText('Manual token scope mode')).toHaveCount(0);
		await expect(rowControl(page, 'Cached image max dimension')).toBeEnabled();
		await expect(rowControl(page, 'Cached image max dimension')).toHaveValue(
			String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION)
		);
		await expect(rowControl(page, 'Cached image max dimension')).toHaveAttribute('type', 'text');
		await formRow(page, 'Cached image max dimension')
			.getByRole('button', { name: 'estimate' })
			.click();
		await expect(formRow(page, 'Cached image max dimension')).toContainText('estimated');
		await expect(formRow(page, 'Original image dimensions')).toContainText('2160 x 2160px');
		await expect(formRow(page, 'Cached image size (1 token)')).toContainText('24.0 KB');
		await expect(formRow(page, 'Cached image dimensions')).toContainText('1080 x 1080px');
		await expect(formRow(page, 'Est. cached images size (full collection)')).toContainText(
			'176 MB'
		);
		await rowControl(page, 'Cached image max dimension').fill('720');
		await expect(
			formRow(page, 'Cached image max dimension').getByRole('button', { name: 'estimate' })
		).toBeEnabled();
		await rowControl(page, 'Cached image max dimension').press('Enter');
		await expect.poll(() => api.imageCacheEstimateRequests.length).toBe(2);
		expect(api.mutations).toEqual([]);
		await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.Off);
		await expect(formLabel(page, 'Cached image max dimension')).toHaveCount(0);
		await expect(page.getByText('Original image source size (1 token)')).toBeVisible();
		await expect(formRow(page, 'Image cache plan')).toContainText('cards use image field');
		await page.getByRole('button', { name: 'queue bootstrap' }).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		await expect(page).toHaveURL(/\/e2e-harness\/bootstrap-runs\/1$/);
		expect(api.mutations[0]?.body).toMatchObject({
			slug: 'custom-raster-slug',
			metadataMode: DEFAULT_BOOTSTRAP_METADATA_MODE,
			imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
			openseaSlug: BOOTSTRAP_PROBE_OPENSEA_SLUGS.EnumerableRaster,
			imageCache: {
				selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
				imageCacheMode: IMAGE_CACHE_MODE.Off,
				maxDimension: null
			}
		});
		expect(api.imageCacheEstimateRequests).toEqual([
			expect.objectContaining({
				sampleTokenId: '0',
				sourceImageBytes: 98234,
				totalSupply: '7500',
				imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
				maxDimension: BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION
			}),
			expect.objectContaining({
				sampleTokenId: '0',
				sourceImageBytes: 98234,
				totalSupply: '7500',
				imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
				maxDimension: 720
			})
		]);
		expect(dynamicRequests).toEqual([]);
	});

	test('renders enumerable onchain SVG image data with extension image cache off', async ({
		page
	}) => {
		const api = await installBootstrapProbeApiMock(page);
		await openBootstrapProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableOnchainSvg);

		const card = tokenCard(page, '1');
		await expect(card).toBeVisible();
		await expect(card.locator('img')).toHaveAttribute('src', BOOTSTRAP_PROBE_MEDIA.OnchainSvgImage);
		await expect(page.locator('input[name="slug"]')).toHaveValue(
			BOOTSTRAP_PROBE_OPENSEA_SLUGS.EnumerableOnchainSvg
		);
		await expect(rowControl(page, 'Image source field')).toHaveValue(
			TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData
		);
		const imageCacheModeSelect = rowControl(page, 'Image cache mode');
		await expect(imageCacheModeSelect).toHaveValue(IMAGE_CACHE_MODE.Off);
		await expect(imageCacheModeSelect).toBeDisabled();
		await expect(formLabel(page, 'Cached image max dimension')).toHaveCount(0);
		await expect(formRow(page, 'Image cache policy source')).toContainText(
			`extension-defined (${TERRAFORMS_EXTENSION_KEY})`
		);
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		const manualEditing = page.locator(`[data-testid="${TEST_IDS.BootstrapAllowManualEditing}"]`);
		await manualEditing.check();
		await expect(imageCacheModeSelect).toBeEnabled();
		await manualEditing.uncheck();
		await expect(imageCacheModeSelect).toBeDisabled();
		await expect(page.getByText('Est. source images size (full collection)')).toBeVisible();

		const imageSizeRow = formRow(page, 'Original image source size (1 token)');
		await imageSizeRow.locator('.info-tooltip').hover();
		await expect(imageSizeRow.locator('.info-tooltip-popup')).toBeVisible();
		await expect(imageSizeRow.locator('.info-tooltip-popup')).toContainText(
			'Fetched image file size'
		);
		await page.getByRole('button', { name: 'queue bootstrap' }).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0]?.body).toMatchObject({
			metadataMode: DEFAULT_BOOTSTRAP_METADATA_MODE,
			imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData,
			imageCache: {
				selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension,
				imageCacheMode: IMAGE_CACHE_MODE.Off,
				maxDimension: null
			}
		});
	});
});

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

async function openBootstrapProbe(page: Page, address: string): Promise<void> {
	await page.goto(BOOTSTRAP_PROBE_E2E_ROUTE_PATH);
	await page.locator('input[name="address"]').fill(address);
	await expect(page.locator(`[data-testid="${TEST_IDS.BootstrapProbeTokenCard}"]`)).toBeVisible();
}

function tokenCard(page: Page, tokenId: string) {
	return page.locator(`[data-testid="${TEST_IDS.TokenCard}"][data-token-id="${tokenId}"]`);
}

function formRow(page: Page, label: string) {
	return page.locator('.bootstrap-form-fields .bootstrap-form-row').filter({ hasText: label });
}

function formLabel(page: Page, label: string) {
	return page
		.locator('.bootstrap-form-fields .bootstrap-form-label-cell > span:first-child')
		.filter({ hasText: new RegExp(`^${label}$`) });
}

function rowControl(page: Page, label: string) {
	return formRow(page, label).locator('input, select, textarea');
}

async function assertOpenSeaDisabledNoteFitsSlugInput(page: Page): Promise<void> {
	const openSeaSlugRow = formRow(page, 'OpenSea slug');
	const openSeaSlugInput = openSeaSlugRow.locator('input[name="openseaSlug"]');
	const disabledNote = openSeaSlugRow.locator('.bootstrap-opensea-slug-note');
	await expect(disabledNote).toBeVisible();
	const inputBox = await openSeaSlugInput.boundingBox();
	const noteBox = await disabledNote.boundingBox();
	expect(inputBox).not.toBeNull();
	expect(noteBox).not.toBeNull();
	if (!inputBox || !noteBox) return;
	expect(noteBox.width).toBeLessThanOrEqual(inputBox.width + 1);
}

async function assertEveryBootstrapRowHasInfoTooltip(page: Page): Promise<void> {
	const rows = page.locator('.bootstrap-form-fields .bootstrap-form-row');
	const tooltips = page.locator('.bootstrap-form-fields .bootstrap-form-row .info-tooltip');
	expect(await tooltips.count()).toBe(await rows.count());
}

async function assertTooltipText(page: Page, label: string, expectedText: string): Promise<void> {
	const row = formRow(page, label);
	await row.locator('.info-tooltip').hover();
	await expect(row.locator('.info-tooltip-popup')).toContainText(expectedText);
}

async function assertTokenBrowserCardScale(card: ReturnType<typeof tokenCard>): Promise<void> {
	await expect(card.locator('.token-grid-media')).toHaveCSS('height', '400px');
}

async function assertTokenCardPlacement(page: Page, testInfo: TestInfo): Promise<void> {
	const addressBox = await page.locator('.bootstrap-address-section').boundingBox();
	const previewBox = await page.locator('.bootstrap-token-preview-section').boundingBox();
	const cardBox = await page
		.locator(`[data-testid="${TEST_IDS.BootstrapProbeTokenCard}"]`)
		.boundingBox();
	const probeBox = await page.locator('.bootstrap-probe-section').boundingBox();
	expect(addressBox, `${testInfo.project.name} address box should be measurable`).not.toBeNull();
	expect(previewBox, `${testInfo.project.name} preview box should be measurable`).not.toBeNull();
	expect(cardBox, `${testInfo.project.name} token card box should be measurable`).not.toBeNull();
	expect(probeBox, `${testInfo.project.name} probe box should be measurable`).not.toBeNull();
	if (!addressBox || !previewBox || !cardBox || !probeBox) return;

	const viewportWidth = page.viewportSize()?.width ?? 0;
	if (viewportWidth >= 900) {
		expect(
			Math.abs(previewBox.x - addressBox.x),
			`${testInfo.project.name} preview surface should align under the address surface`
		).toBeLessThanOrEqual(2);
		expect(
			Math.abs(previewBox.width - addressBox.width),
			`${testInfo.project.name} preview surface should share the address surface width`
		).toBeLessThanOrEqual(2);
		expect(
			Math.abs(probeBox.width - addressBox.width),
			`${testInfo.project.name} probe surface should share the address surface width`
		).toBeLessThanOrEqual(2);
		expect(
			Math.abs(cardBox.x + cardBox.width / 2 - (previewBox.x + previewBox.width / 2)),
			`${testInfo.project.name} token card should be centered in the preview surface`
		).toBeLessThanOrEqual(2);
	}
	expect(
		previewBox.y,
		`${testInfo.project.name} preview surface should render below the address surface`
	).toBeGreaterThan(addressBox.y + addressBox.height - 1);
	expect(
		cardBox.y,
		`${testInfo.project.name} token card should live inside the preview surface`
	).toBeGreaterThanOrEqual(previewBox.y);

	expect(
		probeBox.y,
		`${testInfo.project.name} probe surface should follow the token card preview`
	).toBeGreaterThan(previewBox.y + previewBox.height - 1);
}
