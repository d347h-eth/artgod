import { expect, test, type Locator, type Page } from 'playwright/test';
import { OPENSEA_COLLECTION_SLUG_PROBE_ERROR } from '@artgod/shared/opensea/collection-slug-probe';
import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from '@artgod/shared/types';
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
	BOOTSTRAP_PROBE_MEDIA,
	BOOTSTRAP_PROBE_OPENSEA_SLUGS,
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
import { BOOTSTRAP_PROBE_E2E_CHAIN_QUERY_PARAM } from '../src/lib/e2e/bootstrap-probe-fixtures';

const diagnosticsByTest: PageDiagnosticsRegistry = new Map();
// Confirms the late-sync slug field uses the wider shared slug-input control.
const COLLECTION_OPENSEA_SYNC_SLUG_INPUT_MIN_WIDTH_PX = 250;

test.beforeEach(({ page }, testInfo) => {
	captureDiagnosticsForTest(diagnosticsByTest, page, testInfo);
});

test.afterEach(async ({}, testInfo) => {
	await attachDiagnosticsForTestFailure(diagnosticsByTest, testInfo);
});

test.describe('bootstrap setup', () => {
	test('locks the entire form and retains entered values when acknowledgement is removed', async ({
		page
	}, info) => {
		const api = await installBootstrapProbeApiMock(page);
		await page.goto(BOOTSTRAP_PROBE_E2E_ROUTE_PATH);
		await expectFormLocked(page);
		await page.screenshot({ path: info.outputPath('locked.png'), fullPage: true });
		await contractAddressSafetyAcknowledgement(page).check();
		await page.locator('#bootstrap-address').fill(BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await page.locator('#bootstrap-slug').fill('aeon');
		await contractAddressSafetyAcknowledgement(page).uncheck();
		await expectFormLocked(page);
		await expect(page.locator('#bootstrap-slug')).toHaveValue('aeon');
		expect(api.probeRequests).toEqual([]);
	});

	test('queues a complete manual definition without probes, sample or estimate', async ({
		page
	}, info) => {
		const api = await installBootstrapProbeApiMock(page);
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await page.locator('#bootstrap-sample').fill('');
		await expect(queueButton(page)).toBeEnabled();
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('manual-ready.png'), fullPage: true });
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).toMatchObject({
			scope: { mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange, startTokenId: '1', tokenCount: 999 },
			imageSourceField: 'image'
		});
		expect(api.probeRequests).toEqual([]);
		expect(api.sampleRequests).toEqual([]);
	});

	test('keeps failed submissions editable and supports retry', async ({ page }) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await page.route(
			'**/collections/bootstrap',
			(route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
			{ times: 1 }
		);
		await queueButton(page).click();
		await expect(
			page.getByText('Bootstrap could not be queued. Press queue bootstrap to retry.')
		).toBeVisible();
		await expect(page.locator('#bootstrap-slug')).toHaveValue('curated-collection');
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
	});

	test('shows contract findings while sample metadata is still loading', async ({ page }, info) => {
		const api = await installBootstrapProbeApiMock(page);
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		await page.route(
			'**/collections/bootstrap/sample',
			async (route) => {
				await gate;
				await route.fallback();
			},
			{ times: 1 }
		);
		await probeButton(page).click();
		await expect(
			formRow(page, 'Token count').getByRole('button', { name: 'apply "3333"' })
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'inspect', exact: true })).toContainText(
			'inspecting'
		);
		await expect(
			page
				.getByRole('button', { name: 'inspect', exact: true })
				.getByRole('img', { name: 'inspecting sample' })
		).toBeVisible();
		await expect(page.getByText('contract checked', { exact: true })).toBeVisible();
		await page.screenshot({
			path: info.outputPath('contract-ready-sample-loading.png'),
			fullPage: true
		});
		release();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		expect(api.probeRequests).toHaveLength(1);
	});

	test('uses an automatic sample without applying it and applies scope suggestions independently', async ({
		page
	}, info) => {
		const api = await installBootstrapProbeApiMock(page);
		await page.goto(BOOTSTRAP_PROBE_E2E_ROUTE_PATH);
		await contractAddressSafetyAcknowledgement(page).check();
		await page.locator('#bootstrap-address').fill(BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
		await probeButton(page).click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		await expect(page.locator('#bootstrap-sample')).toHaveValue('');
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('1');
		await formRow(page, 'Token count').getByRole('button', { name: 'apply "10000"' }).click();
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('1');
		await formRow(page, 'First token ID').getByRole('button', { name: 'apply "0"' }).click();
		await formRow(page, 'Image source field')
			.getByRole('button', { name: 'apply "image"' })
			.click();
		await formRow(page, 'Collection slug').getByRole('button', { name: 'apply "milady"' }).click();
		await formRow(page, 'Animation source field (optional)')
			.getByRole('button', { name: 'apply "animation_url"' })
			.click();
		await expect(page.locator('#bootstrap-animation-field')).toHaveValue('animation_url');
		await formRow(page, 'Sample token ID').getByRole('button', { name: 'apply "0"' }).click();
		await expect(page.locator('#bootstrap-sample')).toHaveValue('0');
		await expect(page.locator('#bootstrap-range-count')).toHaveValue('10000');
		expect(api.sampleRequests).toHaveLength(1);
		await expect(page.getByRole('button', { name: 'estimate', exact: true })).toBeEnabled();
		await expect(page.locator('#bootstrap-scope-mode')).toHaveValue(
			BOOTSTRAP_ENUMERATION_MODE.ManualRange
		);
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('suggestions-ready.png'), fullPage: true });
		await formRow(page, 'Token scope')
			.getByRole('button', { name: 'apply "entire contract"' })
			.click();
		await expect(page.locator('#bootstrap-scope-mode')).toHaveValue(
			BOOTSTRAP_ENUMERATION_MODE.Enumerable
		);
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).toMatchObject({
			scope: { mode: BOOTSTRAP_ENUMERATION_MODE.Enumerable }
		});
	});

	test('keeps contract findings when a sample changes and field edits re-use downloaded metadata', async ({
		page
	}) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await probeButton(page).click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		await page.locator('#bootstrap-image-field').fill('image_url');
		await expect(formRow(page, 'Image source field')).toContainText('found in sample');
		await page.locator('#bootstrap-animation-field').fill('generator_url');
		await expect(formRow(page, 'Animation source field (optional)')).toContainText(
			'found in sample'
		);
		expect(api.sampleRequests).toHaveLength(1);
		await page.locator('#bootstrap-sample').fill('42');
		await expect(page.getByTitle('tokenURI response', { exact: true })).toHaveCount(0);
		await expect(formRow(page, 'Contract total supply')).toContainText('10000');
		await page.getByRole('button', { name: 'inspect', exact: true }).click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		expect(api.probeRequests).toHaveLength(1);
		expect(api.sampleRequests.map((r) => r.requestedTokenId)).toEqual(['2', '42']);
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('1');
		await expect(page.locator('#bootstrap-range-count')).toHaveValue('999');
	});

	test('preserves a Meridian range and resolves OpenSea through its effective sample', async ({
		page
	}, info) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
		await page.locator('#bootstrap-sample').fill('');
		await page.locator('#bootstrap-range-start').fill('163000000');
		await page.locator('#bootstrap-range-count').fill('1000');
		await probeButton(page).click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		await expect(page.locator('#bootstrap-opensea')).toContainText('resolved');
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('163000000');
		await expect(page.locator('#bootstrap-range-count')).toHaveValue('1000');
		await expect(formRow(page, 'Contract total supply')).toContainText('200000');
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual(['163000000']);
		await expect(page.getByRole('button', { name: 'resolve', exact: true })).toHaveCount(0);
		await page.screenshot({ path: info.outputPath('meridian-resolved.png'), fullPage: true });
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).toMatchObject({
			scope: {
				mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
				startTokenId: '163000000',
				tokenCount: 1000
			},
			openseaSlug: BOOTSTRAP_PROBE_OPENSEA_SLUGS.SharedManualScope
		});
	});

	test('keeps the sparse declared range when low IDs are absent', async ({ page }, info) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.PartiallyMinted);
		await page.locator('#bootstrap-range-start').fill('0');
		await page.locator('#bootstrap-range-count').fill('1000');
		await page.locator('#bootstrap-sample').fill('0');
		await probeButton(page).click();
		await expect(sampleTokenInputRow(page)).toContainText('no owner found');
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: info.outputPath('sparse-absent-sample.png'), fullPage: true });
		await page.locator('#bootstrap-sample').fill('10');
		await page.getByRole('button', { name: 'inspect', exact: true }).click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		await expect(page.locator('#bootstrap-range-count')).toHaveValue('1000');
		await expect(formRow(page, 'Contract total supply')).toContainText('704');
		expect(api.probeRequests).toHaveLength(1);
	});

	test('keeps AEON supply/start suggestions and manual queueing after metadata HTTP 429', async ({
		page
	}, info) => {
		const api = await installBootstrapProbeApiMock(page, {
			sample: (r) => ({
				...r,
				sample: {
					...r.sample,
					tokenUriPayload: null,
					tokenUriPayloadBytes: null,
					tokenUriPayloadError: 'Metadata download failed (HTTP 429). Press inspect to retry.'
				}
			})
		});
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await probeButton(page).click();
		await expect(page.getByRole('alert')).toContainText('HTTP 429');
		await expect(
			formRow(page, 'Token count').getByRole('button', { name: 'apply "3333"' })
		).toBeVisible();
		await expect(
			formRow(page, 'First token ID').getByRole('button', { name: 'apply "1"' })
		).toBeVisible();
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: info.outputPath('aeon-metadata-429.png'), fullPage: true });
		await page.getByRole('button', { name: 'inspect', exact: true }).click();
		await expect.poll(() => api.sampleRequests.length).toBe(2);
		expect(api.probeRequests).toHaveLength(1);
	});

	test('rejects malformed sample locally while allowing complete manual setup', async ({
		page
	}) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await page.locator('#bootstrap-sample').fill('-1');
		await probeButton(page).click();
		await expect(page.getByRole('alert')).toContainText('valid decimal sample token ID');
		await expect(formRow(page, 'Contract total supply')).toContainText('3333');
		expect(api.sampleRequests).toEqual([]);
		await expect(queueButton(page)).toBeEnabled();
	});

	test('retains measured images across count edits and suppresses totals/OpenSea outside scope', async ({
		page
	}, info) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.CacheOnce);
		await page.locator('#bootstrap-sample').fill('1000');
		await page.locator('#bootstrap-range-count').fill('10000');
		await probeButton(page).click();
		const estimate = page.getByRole('button', { name: 'estimate', exact: true });
		await expect(estimate).toBeEnabled();
		await estimate.click();
		await expect(formRow(page, 'Estimated cache (selected scope)')).toContainText('9.77 MB');
		await page.locator('#bootstrap-range-count').fill('2000');
		await expect(formRow(page, 'Estimated cache (selected scope)')).toContainText('1.95 MB');
		expect(api.imageCacheEstimateRequests).toHaveLength(1);
		expect(api.imageCacheEstimateRequests[0]).not.toHaveProperty('totalSupply');
		await page.locator('#bootstrap-range-count').fill('500');
		await expect(formRow(page, 'Estimated cache (selected scope)')).toContainText('not available');
		await expect(estimate).toBeDisabled();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		await expect(page.locator('#bootstrap-opensea')).toContainText('will be skipped');
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: info.outputPath('sample-outside-scope.png'), fullPage: true });
		await page.locator('#bootstrap-range-count').fill('2000');
		await expect(formRow(page, 'Estimated cache (selected scope)')).toContainText('1.95 MB');
		await expect(estimate).toBeEnabled();
		await expect(page.locator('#bootstrap-opensea')).toContainText('resolved');
		expect(api.imageCacheEstimateRequests).toHaveLength(1);
		expect(api.sampleRequests).toHaveLength(1);
		await page.locator('#bootstrap-range-count').fill('500');
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).not.toHaveProperty('openseaSlug');
	});

	for (const status of [400, 502])
		test('retries image processing failure ' + status, async ({ page }, info) => {
			const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
			await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.CacheOnce);
			await probeButton(page).click();
			const estimate = page.getByRole('button', { name: 'estimate', exact: true });
			await expect(estimate).toBeEnabled();
			await page.route(
				'**/collections/bootstrap/image-cache-estimate',
				(route) =>
					route.fulfill({
						status,
						contentType: 'application/json',
						body: JSON.stringify({ message: 'Image processing failed. Press estimate to retry.' })
					}),
				{ times: 1 }
			);
			await estimate.click();
			await expect(page.locator('#bootstrap-cache')).toContainText('Image processing failed');
			await expect(queueButton(page)).toBeEnabled();
			await page.screenshot({ path: info.outputPath('image-failure.png'), fullPage: true });
			await estimate.click();
			await expect(formRow(page, 'Cached image (1 token)')).toContainText('1.00 KB');
			expect(api.imageCacheEstimateRequests).toHaveLength(1);
		});

	test('drops late contract and sample responses after identity edits and re-locking', async ({
		page
	}, info) => {
		await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		let release!: () => void;
		let gate = new Promise<void>((resolve) => (release = resolve));
		await page.route(
			'**/collections/bootstrap/probe?**',
			async (route) => {
				await gate;
				await route.fallback();
			},
			{ times: 1 }
		);
		await probeButton(page).click();
		await expect(probeButton(page)).toContainText('probing');
		await page.screenshot({ path: info.outputPath('contract-loading.png'), fullPage: true });
		await page.locator('#bootstrap-address').fill(BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		release();
		await expect(formRow(page, 'Contract total supply')).toHaveCount(0);
		gate = new Promise<void>((resolve) => (release = resolve));
		await page.route(
			'**/collections/bootstrap/sample',
			async (route) => {
				await gate;
				await route.fallback();
			},
			{ times: 1 }
		);
		await probeButton(page).click();
		await expect(page.getByRole('button', { name: 'inspect', exact: true })).toContainText(
			'inspecting'
		);
		await contractAddressSafetyAcknowledgement(page).uncheck();
		release();
		await expectFormLocked(page);
		await expect(page.getByTitle('tokenURI response', { exact: true })).toHaveCount(0);
		await contractAddressSafetyAcknowledgement(page).check();
		await expect(page.locator('#bootstrap-slug')).toHaveValue('curated-collection');
		await expect(queueButton(page)).toBeEnabled();
	});

	test('ignores the previous chain response after navigation and a newer probe', async ({
		page
	}) => {
		const api = await installBootstrapProbeApiMock(page);
		await page.goto(
			`${BOOTSTRAP_PROBE_E2E_ROUTE_PATH}?${BOOTSTRAP_PROBE_E2E_CHAIN_QUERY_PARAM}=ethereum`
		);
		await contractAddressSafetyAcknowledgement(page).check();
		await page.locator('#bootstrap-address').fill(BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
		await page.locator('#bootstrap-slug').fill('retained-draft');
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		await page.route(
			'**/ethereum/collections/bootstrap/probe?**',
			async (route) => {
				await gate;
				await route.fallback();
			},
			{ times: 1 }
		);
		await probeButton(page).click();
		await expect(probeButton(page)).toContainText('probing');
		await page
			.getByRole('navigation', { name: 'Test chain' })
			.getByRole('link', { name: 'Arbitrum' })
			.click();
		await expect(page.getByText('Arbitrum (arbitrum / 42161)', { exact: true })).toBeVisible();
		await expect(page.locator('#bootstrap-slug')).toHaveValue('retained-draft');
		await expect(probeButton(page)).toBeEnabled();
		await probeButton(page).click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		const oldResponse = page.waitForResponse((response) =>
			response.url().includes('/ethereum/collections/bootstrap/probe?')
		);
		release();
		await (await oldResponse).finished();
		await expect.poll(() => api.probeRequests.length).toBe(2);
		await expect(page.getByText('contract checked', { exact: true })).toBeVisible();
		expect(api.sampleRequests).toHaveLength(1);
		await expect(page.locator('#bootstrap-slug')).toHaveValue('retained-draft');
	});

	test('offers a retry after RPC failure without blocking queueing', async ({ page }) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		let failing = true;
		await page.route('**/collections/bootstrap/probe?**', (route) =>
			failing
				? route.fulfill({ status: 502, contentType: 'application/json', body: '{}' })
				: route.fallback()
		);
		await probeButton(page).click();
		// GET reads exhaust the shared 12-second startup retry window before reporting failure.
		await expect(page.getByRole('alert')).toContainText('Contract checks failed', {
			timeout: 20_000
		});
		await expect(queueButton(page)).toBeEnabled();
		failing = false;
		await probeButton(page).click();
		await expect(formRow(page, 'Contract total supply')).toContainText('3333');
		expect(api.probeRequests).toHaveLength(1);
	});

	test('keeps OpenSea progress inside resolve and ignores a late result after sample and slug edits', async ({
		page
	}, info) => {
		await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		await page.route(
			'**/collections/bootstrap/opensea-slug-probe?**',
			async (route) => {
				await gate;
				await route.fallback();
			},
			{ times: 1 }
		);
		await probeButton(page).click();
		const resolve = page.getByRole('button', { name: 'resolve', exact: true });
		await expect(resolve).toContainText('resolving');
		await expect(resolve.getByRole('img', { name: 'resolving OpenSea slug' })).toBeVisible();
		await page.screenshot({ path: info.outputPath('opensea-loading.png'), fullPage: true });
		await page.locator('#bootstrap-sample').fill('3');
		await page.locator('#bootstrap-opensea-slug').fill('user-edited-slug');
		const oldResponse = page.waitForResponse((response) =>
			response.url().includes('opensea-slug-probe')
		);
		release();
		await oldResponse;
		await expect(page.locator('#bootstrap-opensea-slug')).toHaveValue('user-edited-slug');
		await expect(page.locator('#bootstrap-opensea .bootstrap-resolution-badge')).toHaveCount(0);
		await resolve.click();
		await expect(page.locator('#bootstrap-opensea')).toContainText('incorrect');
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: info.outputPath('opensea-incorrect.png'), fullPage: true });
		await page.locator('#bootstrap-opensea-slug').fill('');
		await resolve.click();
		await expect(page.locator('#bootstrap-opensea .bootstrap-resolution-badge')).toHaveText(
			'resolved'
		);
	});

	test('ignores an old image measurement after cache settings change and a newer estimate finishes', async ({
		page
	}, info) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.CacheOnce);
		await probeButton(page).click();
		const estimate = page.getByRole('button', { name: 'estimate', exact: true });
		await expect(estimate).toBeEnabled();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		await page.route(
			'**/collections/bootstrap/image-cache-estimate',
			async (route) => {
				await gate;
				await route.fallback();
			},
			{ times: 1 }
		);
		await estimate.click();
		await expect(estimate).toContainText('estimating');
		await expect(estimate.getByRole('img', { name: 'estimating image cache size' })).toBeVisible();
		await page.screenshot({ path: info.outputPath('image-loading.png'), fullPage: true });
		await rowControl(page, 'Max dimension (px)').fill('64');
		await estimate.click();
		await expect(formRow(page, 'Cached image (1 token)')).toContainText('64 x 64px');
		const oldResponse = page.waitForResponse(
			(response) =>
				response.url().includes('image-cache-estimate') &&
				response.request().postDataJSON().maxDimension === 1080
		);
		release();
		await oldResponse;
		await expect(formRow(page, 'Cached image (1 token)')).toContainText('64 x 64px');
		expect(api.imageCacheEstimateRequests).toHaveLength(2);
		await rowControl(page, 'Image source field').fill('image_url');
		await expect(formRow(page, 'Cached image (1 token)')).toHaveCount(0);
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
	});

	for (const sampleId of ['', '0', '42'])
		test(
			'preserves Enumerable facts with sample override ' + JSON.stringify(sampleId),
			async ({ page }) => {
				const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
				await page.locator('#bootstrap-sample').fill(sampleId);
				await probeButton(page).click();
				await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
				await expect(
					formRow(page, 'Token scope').getByRole('button', { name: 'apply "entire contract"' })
				).toBeVisible();
				await expect(page.locator('#bootstrap-scope-mode')).toHaveValue(
					BOOTSTRAP_ENUMERATION_MODE.ManualRange
				);
				await expect(page.locator('#bootstrap-range-start')).toHaveValue('1');
				await expect(page.locator('#bootstrap-range-count')).toHaveValue('999');
				await formRow(page, 'Token scope')
					.getByRole('button', { name: 'apply "entire contract"' })
					.click();
				await expect(page.locator('#bootstrap-scope-mode')).toHaveValue(
					BOOTSTRAP_ENUMERATION_MODE.Enumerable
				);
				await page
					.locator('#bootstrap-scope-mode')
					.selectOption(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds);
				await rowControl(page, 'Token IDs').fill('0, 42, 00042');
				await expect(queueButton(page)).toBeEnabled();
				await queueButton(page).click();
				await expect.poll(() => api.mutations.length).toBe(1);
				expect(api.mutations[0].body).toMatchObject({
					scope: { mode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, tokenIds: ['0', '42'] }
				});
			}
		);

	test('offers extension cache suggestions for only the inspected scope and applies each independently', async ({
		page
	}) => {
		const api = await installBootstrapProbeApiMock(page, {
			sample: (result) => ({
				...result,
				imageCacheSuggestion: {
					selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension,
					extensionKey: 'test-scope-extension',
					config: { imageCacheMode: IMAGE_CACHE_MODE.CacheOnce, maxDimension: 64 }
				}
			})
		});
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
		await probeButton(page).click();
		const mode = formRow(page, 'Image cache mode').getByRole('button', {
			name: 'apply "cache once"'
		});
		await expect(mode).toBeVisible();
		await mode.click();
		await expect(rowControl(page, 'Max dimension (px)')).toHaveValue('1080');
		await formRow(page, 'Max dimension (px)').getByRole('button', { name: 'apply "64"' }).click();
		await expect(rowControl(page, 'Max dimension (px)')).toHaveValue('64');
		await expect(rowControl(page, 'Image cache mode')).toHaveValue(IMAGE_CACHE_MODE.CacheOnce);
		await page.locator('#bootstrap-range-count').fill('1000');
		await expect(mode).toHaveCount(0);
		expect(api.sampleRequests).toHaveLength(1);
	});

	test('keeps manual queueing available when OpenSea is disabled', async ({ page }, info) => {
		const api = await installBootstrapProbeApiMock(page);
		await page.goto(BOOTSTRAP_PROBE_E2E_ROUTE_PATH + '?opensea=disabled');
		await contractAddressSafetyAcknowledgement(page).check();
		await page.locator('#bootstrap-address').fill(BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await page.locator('#bootstrap-slug').fill('remilio');
		await page.locator('#bootstrap-range-count').fill('10000');
		await rowControl(page, 'Image source field').fill('image');
		await probeButton(page).click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'resolve', exact: true })).toBeDisabled();
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual([]);
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: info.outputPath('opensea-disabled.png'), fullPage: true });
	});

	for (const status of [429, 502])
		test('recovers independently from OpenSea HTTP ' + status, async ({ page }, info) => {
			const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
			let failed = true;
			await page.route('**/collections/bootstrap/opensea-slug-probe?**', (route) =>
				failed
					? route.fulfill({ status, contentType: 'application/json', body: '{}' })
					: route.fallback()
			);
			await probeButton(page).click();
			await expect(page.locator('#bootstrap-opensea')).toContainText(
				'OpenSea lookup failed. Try resolve again.',
				{ timeout: 20_000 }
			);
			await expect(queueButton(page)).toBeEnabled();
			await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
			await page.screenshot({ path: info.outputPath('opensea-error.png'), fullPage: true });
			failed = false;
			await page.getByRole('button', { name: 'resolve', exact: true }).click();
			await expect(page.locator('#bootstrap-opensea .bootstrap-resolution-badge')).toHaveText(
				'resolved'
			);
			expect(api.probeRequests).toHaveLength(1);
			expect(api.sampleRequests).toHaveLength(1);
		});

	test('shows contract validation recovery instead of treating it as an RPC outage', async ({
		page
	}) => {
		await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await page.route('**/collections/bootstrap/probe?**', (route) =>
			route.fulfill({
				status: 422,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'address is not a contract' })
			})
		);
		await probeButton(page).click();
		await expect(page.getByRole('alert')).toContainText('address is not a contract');
		await expect(queueButton(page)).toBeEnabled();
	});

	test('keeps long suggestions on one line and aligns the complete form', async ({
		page
	}, info) => {
		const longField = 'a-very-long-custom-image-property-' + 'x'.repeat(80);
		await installBootstrapProbeApiMock(page, {
			sample: (r) => ({
				...r,
				sample: {
					...r.sample,
					tokenUriPayload: JSON.stringify({ [longField]: BOOTSTRAP_PROBE_MEDIA.RasterImage })
				}
			})
		});
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await probeButton(page).click();
		const suggestion = formRow(page, 'Image source field').getByRole('button', {
			name: 'apply "' + longField + '"'
		});
		await expect(suggestion).toBeVisible();
		await expectSuggestionLabelFits(suggestion);
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('long-suggestions.png'), fullPage: true });
	});

	test('inspects AEON metadata as inert formatted text with expandable large keys and values', async ({
		page
	}, testInfo) => {
		const embeddedArt = `data:image/svg+xml;base64,${'A'.repeat(60_000)}`;
		const largeKey = `large-key-${'k'.repeat(500)}`;
		const hostileText =
			'</script><script>parent.metadataExecuted=true</script><img src="https://metadata-payload.example/image">';
		const payload = JSON.stringify(
			{
				name: 'AEON #1',
				description: hostileText,
				image: embeddedArt,
				[largeKey]: 'large key value',
				attributes: [{ trait_type: 'Palette', value: 'blue' }]
			},
			null,
			2
		);
		const externalRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('metadata-payload.example')) externalRequests.push(request.url());
		});
		await installBootstrapProbeApiMock(page, {
			sample: (response) => ({
				...response,
				sample: {
					...response.sample,
					tokenUriPayload: payload,
					tokenUriPayloadBytes: Buffer.byteLength(payload)
				}
			})
		});
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await page.locator('input[name="sampleTokenId"]').fill('1');
		await probeButton(page).click();
		const iframe = page.getByTitle('tokenURI response', { exact: true });
		await expect(iframe).toBeVisible();
		await expect(iframe).toHaveAttribute('sandbox', '');
		await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
		const frame = page.frameLocator('iframe[title="tokenURI response"]');
		await expect(frame.getByText('"AEON #1"', { exact: true })).toBeVisible();
		await expect(frame.getByText(JSON.stringify(hostileText), { exact: true })).toBeVisible();
		await expect(frame.locator('script, img, a')).toHaveCount(0);
		await expect(frame.locator('details')).toHaveCount(2);
		for (const detail of await frame.locator('details').all()) {
			await expect(detail).not.toHaveAttribute('open');
			await expect(detail.locator('code')).not.toBeVisible();
		}
		await expectGridAlignment(page);
		await iframe.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: testInfo.outputPath('aeon-metadata-masked.png'),
			fullPage: true
		});
		const valueMask = frame
			.locator('details')
			.filter({ has: frame.locator('summary').filter({ hasText: 'data:image/svg+xml;base64,' }) });
		await valueMask.locator('summary').click();
		await expect(valueMask.locator('code')).toHaveText(JSON.stringify(embeddedArt));
		await expect(valueMask.locator('code')).toBeVisible();
		await valueMask.locator('summary').click();
		const keyMask = frame
			.locator('details')
			.filter({ has: frame.locator('summary').filter({ hasText: 'large-key-' }) });
		await keyMask.locator('summary').focus();
		await page.keyboard.press('Enter');
		await expect(keyMask.locator('code')).toBeVisible();
		expect(
			await iframe.evaluate((element) => (element as HTMLIFrameElement).contentDocument)
		).toBeNull();
		expect(await page.evaluate(() => Object.hasOwn(window, 'metadataExecuted'))).toBe(false);
		expect(externalRequests).toEqual([]);
		await contractAddressSafetyAcknowledgement(page).uncheck();
		await expectFormLocked(page);
		await expect(iframe).toHaveCount(0);
		await expect(rowControl(page, 'Token count')).toHaveValue('999');
		await contractAddressSafetyAcknowledgement(page).check();
		await expect(queueButton(page)).toBeEnabled();
		await expect(iframe).toHaveCount(0);
	});

	test('retains a malformed tokenURI response for inspection and clears stale metadata', async ({
		page
	}) => {
		const payload = '<html>metadata unavailable</html>';
		await installBootstrapProbeApiMock(page, {
			sample: (response) => ({
				...response,
				sample: {
					...response.sample,
					tokenUriPayload: payload,
					tokenUriPayloadError: 'Token metadata is not valid JSON.'
				}
			})
		});
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await probeButton(page).click();
		const frame = page.frameLocator('iframe[title="tokenURI response"]');
		await expect(frame.getByText('Response is not valid JSON')).toBeVisible();
		await expect(frame.getByText(payload, { exact: true })).toBeVisible();
		await expect(queueButton(page)).toBeEnabled();
		await page.locator('input[name="sampleTokenId"]').fill('3');
		await expect(page.getByTitle('tokenURI response', { exact: true })).toHaveCount(0);
	});
});
function probeButton(page: Page) {
	return page.getByRole('button', { name: 'probe', exact: true });
}
function queueButton(page: Page) {
	return page.getByRole('button', { name: 'queue bootstrap', exact: true });
}

async function stageManualProbe(page: Page, address: string) {
	const api = await installBootstrapProbeApiMock(page);
	await stageManualProbeInputs(page, address);
	return api;
}

async function stageManualProbeInputs(page: Page, address: string) {
	await page.goto(BOOTSTRAP_PROBE_E2E_ROUTE_PATH);
	await contractAddressSafetyAcknowledgement(page).check();
	await page.locator('input[name="address"]').fill(address);
	await page.locator('input[name="sampleTokenId"]').fill('2');
	await rowControl(page, 'Image source field').fill(TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image);
	await rowControl(page, 'First token ID').fill('1');
	await rowControl(page, 'Token count').fill('999');
	await page.locator('input[name="slug"]').fill('curated-collection');
	await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.Off);
}

async function expectGridAlignment(page: Page) {
	const controls = page.locator(
		'.bootstrap-create-form .bootstrap-form-row input, .bootstrap-create-form .bootstrap-form-row select'
	);
	const boxes = await controls.evaluateAll((elements) =>
		elements.map((element) => {
			const rect = element.getBoundingClientRect();
			return { x: rect.x, width: rect.width };
		})
	);
	for (const box of boxes) {
		expect(Math.abs(box.x - boxes[0].x)).toBeLessThan(2);
		expect(box.width).toBeLessThanOrEqual(boxes[0].width + 2);
	}
	const countBox = await rowControl(page, 'Token count').boundingBox();
	expect(countBox!.width).toBeLessThan(boxes[0].width);
	const formBox = await page.locator('.bootstrap-create-form').boundingBox();
	expect(formBox!.x).toBeLessThan(50);
	const overflow = await page
		.locator('.bootstrap-create-form')
		.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
	expect(overflow).toBe(false);
	const actions = await page.locator('.bootstrap-row-actions > button').evaluateAll((elements) =>
		elements.map((element) => {
			const rect = element.getBoundingClientRect();
			return { x: rect.x, width: rect.width };
		})
	);
	for (const box of actions) {
		expect(Math.abs(box.x - actions[0].x)).toBeLessThan(2);
		expect(Math.abs(box.width - actions[0].width)).toBeLessThan(2);
	}
	if (page.viewportSize()!.width > 640)
		expect(actions[0].x).toBeGreaterThan(boxes[0].x + boxes[0].width);
	if (page.viewportSize()!.width >= 1200) {
		const inspectorBox = await page
			.getByRole('complementary', { name: 'tokenURI response' })
			.boundingBox();
		expect(Math.abs(inspectorBox!.width - formBox!.width)).toBeLessThan(2);
		expect(inspectorBox!.x).toBeGreaterThan(formBox!.x + formBox!.width);
	}
	if (page.viewportSize()!.width > 640) {
		for (const label of ['Token scope', 'First token ID', 'Image cache mode']) {
			const row = formRow(page, label);
			const control = await row.locator('input, select').boundingBox();
			const hint = await row.locator('.bootstrap-row-actions').boundingBox();
			expect(Math.abs(control!.y + control!.height / 2 - hint!.y - hint!.height / 2)).toBeLessThan(
				2
			);
		}
	}
}

async function expectFormLocked(page: Page) {
	for (const control of await page
		.locator(
			'.bootstrap-form-fields input, .bootstrap-form-fields select, .bootstrap-form-fields textarea, .bootstrap-form-fields button'
		)
		.all()) {
		await expect(control).toBeDisabled();
	}
	await expect(contractAddressSafetyAcknowledgement(page)).toBeEnabled();
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
	// Render the UTC API wire format in a non-UTC browser timezone.
	test.use({ timezoneId: 'Europe/Berlin' });

	test('shows and toggles the latest OpenSea snapshot time', async ({ page }, testInfo) => {
		await page.clock.setFixedTime(new Date('2026-07-24T12:39:56Z'));
		await page.goto(COLLECTION_OPENSEA_SYNC_E2E_ROUTE_PATH);

		await expect(page.getByRole('columnheader', { name: 'OpenSea snapshot' })).toBeVisible();
		const snapshotTime = page.getByRole('button', {
			name: `toggle ${COLLECTION_OPENSEA_SNAPSHOT_E2E_COLLECTION.slug} OpenSea snapshot time mode`
		});
		await expect(snapshotTime).toBeVisible();
		await expect(snapshotTime).toHaveText('5m');
		await expect(snapshotTime).toHaveAttribute('title', COLLECTION_OPENSEA_SNAPSHOT_E2E_TIMESTAMP);
		await page.screenshot({
			path: testInfo.outputPath('collections-opensea-snapshot-relative.png'),
			fullPage: true
		});
		await snapshotTime.click();
		await expect(snapshotTime).toHaveText(COLLECTION_OPENSEA_SNAPSHOT_E2E_TIMESTAMP);

		const screenshotPath = testInfo.outputPath('collections-opensea-snapshot-time.png');
		await page.screenshot({ path: screenshotPath, fullPage: true });
		await testInfo.attach('collections-opensea-snapshot-time.png', {
			path: screenshotPath,
			contentType: 'image/png'
		});
		await snapshotTime.click();
		await expect(snapshotTime).toHaveText('5m');
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
			.locator('.bootstrap-form-label-cell > span:first-child, span.bootstrap-form-label-cell')
			.filter({ hasText: new RegExp('^' + label.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '$') })
	});
}
function rowControl(page: Page, label: string) {
	return formRow(page, label).locator('input, select, textarea');
}

function sampleTokenInputRow(page: Page) {
	// The diagnostic panel repeats the label; badges belong to the editable sample row.
	return formRow(page, 'Sample token ID').filter({
		has: page.locator('input[name="sampleTokenId"]')
	});
}

async function expectSuggestionLabelFits(button: Locator) {
	const geometry = await button.evaluate((element) => {
		const label = element.querySelector('.action-button-value')!;
		const labelBox = label.getBoundingClientRect();
		const buttonBox = element.getBoundingClientRect();
		return {
			height: labelBox.height,
			lineHeight: Number.parseFloat(getComputedStyle(label).lineHeight),
			top: labelBox.top - buttonBox.top,
			bottom: buttonBox.bottom - labelBox.bottom,
			whiteSpace: getComputedStyle(label).whiteSpace
		};
	});
	expect(geometry.whiteSpace).toBe('nowrap');
	expect(geometry.top).toBeGreaterThanOrEqual(0);
	expect(geometry.bottom).toBeGreaterThanOrEqual(0);
}
