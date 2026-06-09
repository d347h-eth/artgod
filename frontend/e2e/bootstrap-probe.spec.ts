import { expect, test, type Page, type TestInfo } from 'playwright/test';
import { TEST_IDS } from '../src/lib/test-ids';
import {
	attachDiagnosticsForTestFailure,
	captureDiagnosticsForTest,
	type PageDiagnosticsRegistry
} from './attached-app';
import {
	BOOTSTRAP_PROBE_E2E_ROUTE_PATH,
	BOOTSTRAP_PROBE_CONTRACTS,
	BOOTSTRAP_PROBE_MEDIA,
	installBootstrapProbeApiMock
} from './helpers/bootstrap-probe-api';

const diagnosticsByTest: PageDiagnosticsRegistry = new Map();

test.beforeEach(({ page }, testInfo) => {
	captureDiagnosticsForTest(diagnosticsByTest, page, testInfo);
});

test.afterEach(async ({}, testInfo) => {
	await attachDiagnosticsForTestFailure(diagnosticsByTest, testInfo);
});

test.describe('bootstrap contract probe UI', () => {
	test('renders non-enumerable probe data as locked probe-derived fields', async ({
		page
	}, testInfo) => {
		const api = await installBootstrapProbeApiMock(page);
		await openBootstrapProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);

		const card = tokenCard(page, '1');
		await expect(card).toBeVisible();
		await expect(card.locator('img')).toHaveAttribute(
			'src',
			BOOTSTRAP_PROBE_MEDIA.NonEnumerableImage
		);
		await expect(page.getByText('Metadata/tokenURI payload size')).toBeVisible();
		await expect(page.getByText('Original image file size')).toBeVisible();

		const startTokenInput = rowControl(page, 'Manual range start token ID');
		const totalSupplyInput = rowControl(page, 'Manual range total supply');
		await expect(startTokenInput).toHaveValue('1');
		await expect(totalSupplyInput).toHaveValue('1000');
		await expect(startTokenInput).toBeDisabled();
		await expect(totalSupplyInput).toBeDisabled();

		await page.locator(`[data-testid="${TEST_IDS.BootstrapAllowManualEditing}"]`).check();
		await expect(startTokenInput).toBeEnabled();
		await expect(totalSupplyInput).toBeEnabled();
		await expect(page.getByText('use only if you know what you are doing')).toBeVisible();

		await assertEveryBootstrapRowHasInfoTooltip(page);
		await assertTokenCardPlacement(page, testInfo);
		expect(api.probeRequests).toEqual([BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable]);
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

		await installBootstrapProbeApiMock(page);
		await openBootstrapProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);

		const card = tokenCard(page, '0');
		await expect(card).toBeVisible();
		await expect(card.locator('img')).toHaveAttribute('src', BOOTSTRAP_PROBE_MEDIA.RasterImage);
		await expect(page.getByText('Manual token scope mode')).toHaveCount(0);
		await expect(rowControl(page, 'Cached image max dimension')).toBeEnabled();
		expect(dynamicRequests).toEqual([]);
	});

	test('renders enumerable onchain SVG image data and concise field help', async ({ page }) => {
		await installBootstrapProbeApiMock(page);
		await openBootstrapProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableOnchainSvg);

		const card = tokenCard(page, '1');
		await expect(card).toBeVisible();
		await expect(card.locator('img')).toHaveAttribute('src', BOOTSTRAP_PROBE_MEDIA.OnchainSvgImage);
		await expect(page.getByText('Projected original image total size')).toBeVisible();

		const imageSizeRow = formRow(page, 'Original image file size');
		await imageSizeRow.locator('.info-tooltip').hover();
		await expect(imageSizeRow.locator('.info-tooltip-popup')).toBeVisible();
		await expect(imageSizeRow.locator('.info-tooltip-popup')).toContainText(
			'tokenURI image property'
		);
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

function rowControl(page: Page, label: string) {
	return formRow(page, label).locator('input, select, textarea');
}

async function assertEveryBootstrapRowHasInfoTooltip(page: Page): Promise<void> {
	const rows = page.locator('.bootstrap-form-fields .bootstrap-form-row');
	const tooltips = page.locator('.bootstrap-form-fields .bootstrap-form-row .info-tooltip');
	expect(await tooltips.count()).toBe(await rows.count());
}

async function assertTokenCardPlacement(page: Page, testInfo: TestInfo): Promise<void> {
	const formBox = await page.locator('.bootstrap-form-fields').boundingBox();
	const cardBox = await page
		.locator(`[data-testid="${TEST_IDS.BootstrapProbeTokenCard}"]`)
		.boundingBox();
	expect(formBox, `${testInfo.project.name} form box should be measurable`).not.toBeNull();
	expect(cardBox, `${testInfo.project.name} token card box should be measurable`).not.toBeNull();
	if (!formBox || !cardBox) return;

	const viewportWidth = page.viewportSize()?.width ?? 0;
	if (viewportWidth >= 900) {
		expect(
			cardBox.x,
			`${testInfo.project.name} token card should sit beside the form`
		).toBeGreaterThan(formBox.x + formBox.width - 1);
		return;
	}

	expect(
		cardBox.y,
		`${testInfo.project.name} token card should stack below the form`
	).toBeGreaterThan(formBox.y);
}
