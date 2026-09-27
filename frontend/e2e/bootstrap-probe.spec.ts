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
	BOOTSTRAP_PROBE_MEDIA,
	BOOTSTRAP_PROBE_OPENSEA_SLUGS,
	BOOTSTRAP_PROBE_PARTIALLY_MINTED_SCOPE,
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

test.describe('bootstrap setup', () => {
	test('retains the definition after queue submission fails and lets the user retry', async ({
		page
	}, testInfo) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await page.route(
			'**/collections/bootstrap',
			(route) =>
				route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'unavailable' })
				}),
			{ times: 1 }
		);
		await queueButton(page).click();
		await expect(
			page.getByText('Bootstrap could not be queued. Press queue bootstrap to retry.')
		).toBeVisible();
		await expect(queueButton(page)).toBeEnabled();
		await expect(rowControl(page, 'Token count')).toHaveValue('999');
		await expect(rowControl(page, 'Image source field')).toHaveValue('image');
		await page.screenshot({ path: testInfo.outputPath('queue-retry.png'), fullPage: true });
		let releaseQueue!: () => void;
		const queueGate = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		await page.route(
			'**/collections/bootstrap',
			async (route) => {
				await queueGate;
				await route.fallback();
			},
			{ times: 1 }
		);
		await queueButton(page).click();
		await expect(queueButton(page)).toHaveAttribute('aria-busy', 'true');
		await expect(queueButton(page).getByRole('img', { name: 'queueing bootstrap' })).toBeVisible();
		await expect(queueButton(page)).toBeDisabled();
		releaseQueue();
		await expect.poll(() => api.mutations.length).toBe(1);
	});

	test('queues the entered definition without a sample, probe or cache estimate', async ({
		page
	}, testInfo) => {
		const api = await installBootstrapProbeApiMock(page);
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await page.locator('input[name="sampleTokenId"]').clear();
		await rowControl(page, 'Animation source field (optional)').fill('generator_url');
		await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.CacheOnce);
		await expect(queueButton(page)).toBeEnabled();
		for (const title of ['1. Contract', '2. Token scope', '3. Collection details']) {
			await expect(page.getByRole('region', { name: new RegExp(title) })).toContainText('complete');
		}
		await page.screenshot({
			path: testInfo.outputPath('manual-ready-no-checks.png'),
			fullPage: true
		});
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).toMatchObject({
			address: BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable,
			slug: 'curated-collection',
			imageSourceField: 'image',
			animationSourceField: 'generator_url',
			supportsEnumerable: false,
			manualInput: {
				mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
				startTokenId: '1',
				totalSupply: 999
			},
			imageCache: { imageCacheMode: IMAGE_CACHE_MODE.CacheOnce, maxDimension: 1080 }
		});
		expect(api.probeRequests).toEqual([]);
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual([]);
		expect(api.imageCacheEstimateRequests).toEqual([]);
	});

	test('guides initial setup and keeps validation in its owning section', async ({
		page
	}, testInfo) => {
		const api = await installBootstrapProbeApiMock(page);
		await page.goto(BOOTSTRAP_PROBE_E2E_ROUTE_PATH);
		await expect(page.getByRole('navigation', { name: 'Bootstrap setup progress' })).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'New collection' })).toHaveCount(0);
		await expectFormLocked(page);
		await expect(probeButton(page)).toBeDisabled();
		await expect(queueButton(page)).toBeDisabled();
		await page.screenshot({ path: testInfo.outputPath('initial-setup.png'), fullPage: true });
		await contractAddressSafetyAcknowledgement(page).check();
		await expect(page.locator('input[name="address"]')).toBeEnabled();
		await page.locator('input[name="address"]').fill(BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
		await expect(probeButton(page)).toBeEnabled();
		await rowControl(page, 'Token count').fill('999');
		await page.locator('input[name="slug"]').fill('bad slug');
		await rowControl(page, 'Image source field').fill('image');
		await expect(page.getByRole('region', { name: /3. Collection details/ })).toContainText(
			'Use letters'
		);
		await expect(queueButton(page)).toBeDisabled();
		await page.locator('input[name="slug"]').fill('collection');
		await rowControl(page, 'Max dimension (px)').fill('1');
		await expect(page.getByRole('region', { name: /4. Image cache/ })).toContainText('Enter 64');
		await expect(queueButton(page)).toBeDisabled();
		await rowControl(page, 'Max dimension (px)').clear();
		await expect(queueButton(page)).toBeEnabled();
		await contractAddressSafetyAcknowledgement(page).uncheck();
		await expect(queueButton(page)).toBeDisabled();
		await expectFormLocked(page);
		await expect(page.locator('input[name="slug"]')).toHaveValue('collection');
		expect(api.probeRequests).toEqual([]);
		expect(api.imageCacheEstimateRequests).toEqual([]);
	});

	test('allows explicit whole-contract enumeration before probing and warns on unsupported evidence', async ({
		page
	}, testInfo) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await rowControl(page, 'Token scope').selectOption(BOOTSTRAP_ENUMERATION_MODE.Enumerable);
		await expect(rowControl(page, 'First token ID')).toHaveCount(0);
		await expect(queueButton(page)).toBeEnabled();
		await probeButton(page).click();
		await expect(page.getByRole('region', { name: /2. Token scope/ })).toContainText(
			'ERC721Enumerable support was not confirmed'
		);
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({
			path: testInfo.outputPath('enumerable-unconfirmed.png'),
			fullPage: true
		});
		await rowControl(page, 'Token scope').selectOption(BOOTSTRAP_ENUMERATION_MODE.ManualRange);
		await expect(rowControl(page, 'Token count')).toHaveValue('999');
		await rowControl(page, 'Token scope').selectOption(BOOTSTRAP_ENUMERATION_MODE.Enumerable);
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).toMatchObject({ supportsEnumerable: true });
		expect(api.mutations[0].body).not.toHaveProperty('manualInput');
	});

	test('does not expand a shared Enumerable contract to its full scope', async ({ page }) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
		await page.locator('input[name="sampleTokenId"]').fill(SHARED_ENUMERABLE_SAMPLE_TOKEN_ID);
		await rowControl(page, 'First token ID').fill(SHARED_ENUMERABLE_SAMPLE_TOKEN_ID);
		await rowControl(page, 'Token count').fill(SHARED_ENUMERABLE_RANGE_TOTAL_SUPPLY);
		await probeButton(page).click();
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		await expect(rowControl(page, 'Token scope')).toHaveValue(
			BOOTSTRAP_ENUMERATION_MODE.ManualRange
		);
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).toMatchObject({
			supportsEnumerable: false,
			manualInput: {
				startTokenId: SHARED_ENUMERABLE_SAMPLE_TOKEN_ID,
				totalSupply: Number(SHARED_ENUMERABLE_RANGE_TOTAL_SUPPLY)
			}
		});
	});

	test('keeps an unminted sample warning separate from the intended range', async ({
		page
	}, testInfo) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.PartiallyMinted);
		await page
			.locator('input[name="sampleTokenId"]')
			.fill(BOOTSTRAP_PROBE_PARTIALLY_MINTED_SCOPE.absentSampleTokenId);
		await probeButton(page).click();
		await expect(sampleTokenInputRow(page)).toContainText('no owner found');
		await expect(page.getByRole('region', { name: /1. Contract/ })).toContainText(
			'Sample token has no owner'
		);
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath('unminted-sample.png'), fullPage: true });
		await page
			.locator('input[name="sampleTokenId"]')
			.fill(BOOTSTRAP_PROBE_PARTIALLY_MINTED_SCOPE.sampleTokenId);
		await expect(page.getByText('inputs changed — probe again')).toBeVisible();
		await probeButton(page).click();
		await expect(sampleTokenInputRow(page)).toContainText('owner confirmed');
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		await expect(rowControl(page, 'First token ID')).toHaveValue('1');
		await expect(rowControl(page, 'Token count')).toHaveValue('999');
		expect(api.probeRequestSampleTokenIds).toEqual(['1', '2']);
	});

	test('applies each suggested value independently with aligned inputs and actions', async ({
		page
	}, testInfo) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
		await rowControl(page, 'Image source field').clear();
		await page.locator('input[name="sampleTokenId"]').clear();
		await probeButton(page).click();
		const suggestions = [
			[sampleTokenInputRow(page), '0'],
			[formRow(page, 'Image source field'), 'image'],
			[formRow(page, 'Animation source field (optional)'), 'animation_url']
		] as const;
		for (const [row, value] of suggestions) {
			const button = row.getByRole('button', { name: `apply "${value}"`, exact: true });
			await expect(button).toBeVisible();
			await expect(button).toHaveClass('action-button-positive');
			await expectSuggestionLabelFits(button);
		}
		await expectGridAlignment(page);
		await page.screenshot({ path: testInfo.outputPath('field-suggestions.png'), fullPage: true });
		await suggestions[1][0].getByRole('button', { name: 'apply "image"', exact: true }).click();
		await expect(rowControl(page, 'Image source field')).toHaveValue('image');
		await expect(page.locator('input[name="sampleTokenId"]')).toHaveValue('');
		await suggestions[0][0].getByRole('button', { name: 'apply "0"', exact: true }).click();
		await suggestions[2][0]
			.getByRole('button', { name: 'apply "animation_url"', exact: true })
			.click();
		const slugApply = formRow(page, 'Collection slug').getByRole('button', { name: /^apply "/ });
		const suggestedSlug = await slugApply.locator('code').textContent();
		await slugApply.click();
		await expect(page.locator('input[name="slug"]')).toHaveValue(suggestedSlug!.slice(1, -1));
		await expect(slugApply).toBeDisabled();
		await expect(rowControl(page, 'Token count')).toHaveValue('999');
		expect(api.probeRequests).toHaveLength(1);
		expect(api.imageCacheEstimateRequests).toEqual([]);
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual([]);
		await page.locator('input[name="sampleTokenId"]').fill('2');
		await expect(
			formRow(page, 'Image source field').getByRole('button', { name: /^apply / })
		).toHaveCount(0);
		await expect(queueButton(page)).toBeEnabled();
	});

	test('keeps long suggestions on one line and exposes their full value', async ({
		page
	}, testInfo) => {
		const imageField = 'ArtworkSourceWithCaseSensitivePropertyName';
		const contractName = 'A'.repeat(64);
		await installBootstrapProbeApiMock(page, (response) => ({
			...response,
			contractName,
			firstToken: { ...response.firstToken, imageSourceField: imageField }
		}));
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await rowControl(page, 'Image source field').clear();
		await probeButton(page).click();
		const imageApply = formRow(page, 'Image source field').getByRole('button', {
			name: `apply "${imageField}"`,
			exact: true
		});
		const slugApply = formRow(page, 'Collection slug').getByRole('button', {
			name: `apply "${contractName.toLowerCase()}"`,
			exact: true
		});
		for (const button of [imageApply, slugApply]) {
			await expect(button).toBeVisible();
			await expect(button.locator('code')).toHaveCSS('text-transform', 'none');
			await expect(button).toHaveAttribute('title', await button.innerText());
			await expectSuggestionLabelFits(button);
		}
		await expectGridAlignment(page);
		await page.screenshot({ path: testInfo.outputPath('long-suggestions.png'), fullPage: true });
		await imageApply.click();
		await expect(rowControl(page, 'Image source field')).toHaveValue(imageField);
	});

	test('offers AEON contract supply even when metadata returns 429 and queues the entered fields', async ({
		page
	}, testInfo) => {
		const api = await installBootstrapProbeApiMock(page, (response) => ({
			...response,
			contractName: 'Project AEON',
			firstToken: {
				...response.firstToken,
				tokenUriPayload: null,
				tokenUriPayloadBytes: null,
				image: null,
				imageSourceField: null,
				animationUrl: null,
				animationSourceField: null,
				tokenUriPayloadError:
					'Metadata download failed (HTTP 429). Check the IPFS gateway in Admin config, restart infra after changes, then press probe.'
			}
		}));
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await page.locator('input[name="sampleTokenId"]').fill('1');
		await rowControl(page, 'Token count').clear();
		await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.CacheOnce);
		await probeButton(page).click();
		await expect(sampleTokenInputRow(page)).toContainText('owner confirmed');
		const contract = page.getByRole('region', { name: /1. Contract/ });
		await expect(contract).toContainText('Metadata download failed (HTTP 429)');
		await expect(contract).toContainText('You can still queue bootstrap');
		await expect(rowControl(page, 'Token count')).toHaveValue('');
		await expect(queueButton(page)).toBeDisabled();
		await formRow(page, 'Token count').getByRole('button', { name: 'apply "3333"' }).click();
		await expect(rowControl(page, 'Token count')).toHaveValue('3333');
		await expect(rowControl(page, 'First token ID')).toHaveValue('1');
		await expect(page.getByRole('complementary', { name: 'tokenURI response' })).toContainText(
			'No response available'
		);
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath('metadata-429-ready.png'), fullPage: true });
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).toMatchObject({
			imageSourceField: 'image',
			manualInput: { startTokenId: '1', totalSupply: 3333 },
			imageCache: { imageCacheMode: IMAGE_CACHE_MODE.CacheOnce }
		});
	});

	test('keeps the grid at narrow and desktop widths', async ({ page }, testInfo) => {
		await installBootstrapProbeApiMock(page, (response) => ({
			...response,
			contractName: 'Project AEON'
		}));
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await page.locator('input[name="sampleTokenId"]').clear();
		await rowControl(page, 'Image source field').clear();
		await probeButton(page).click();
		for (const viewport of [
			{ width: 764, height: 1148 },
			{ width: 773, height: 1038 },
			{ width: 1200, height: 900 },
			{ width: 1440, height: 900 }
		]) {
			await page.setViewportSize(viewport);
			await expectGridAlignment(page);
			await page.screenshot({
				path: testInfo.outputPath(`form-width-${viewport.width}.png`),
				fullPage: true
			});
		}
	});

	test('allows queueing after a failed RPC probe and explicit retry', async ({
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
		await probeButton(page).click();
		await expect(page.getByRole('region', { name: /1. Contract/ })).toContainText('probe failed');
		await expect(queueButton(page)).toBeEnabled();
		await expect(rowControl(page, 'Token count')).toHaveValue('999');
		await page.screenshot({ path: testInfo.outputPath('rpc-failure.png'), fullPage: true });
		await probeButton(page).click();
		await expect(sampleTokenInputRow(page)).toContainText('owner confirmed');
		expect(api.probeRequests).toHaveLength(1);
	});

	for (const status of [502, 500]) {
		test(`queues and retries after cache estimate HTTP ${status}`, async ({ page }, testInfo) => {
			const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
			await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.CacheOnce);
			await probeButton(page).click();
			await expect(formRow(page, 'Image source field')).toContainText('found in sample');
			await page.route(
				'**/collections/bootstrap/image-cache-estimate',
				(route) =>
					route.fulfill({
						status,
						contentType: 'application/json',
						body: JSON.stringify({
							error: 'image_cache_estimate_failed',
							message:
								status === 502
									? 'Image download failed (HTTP 429). Press estimate to retry.'
									: 'Internal server error'
						})
					}),
				{ times: 1 }
			);
			const estimate = page.getByRole('button', { name: 'estimate', exact: true });
			await estimate.click();
			await expect(page.getByRole('region', { name: /4. Image cache/ })).toContainText(
				'Bootstrap can still be queued'
			);
			await expect(queueButton(page)).toBeEnabled();
			await expect(estimate).toBeEnabled();
			await page.screenshot({ path: testInfo.outputPath('estimate-failure.png'), fullPage: true });
			await estimate.click();
			await expect(formRow(page, 'Max dimension (px)')).toContainText('estimated');
			await expect(queueButton(page)).toBeEnabled();
			expect(api.imageCacheEstimateRequests).toHaveLength(1);
			await rowControl(page, 'Token count').fill('3333');
			await expect(formRow(page, 'Max dimension (px)')).toContainText('not estimated');
			await expect(queueButton(page)).toBeEnabled();
		});
	}

	test('shows pending checks inside their actions and discards stale responses', async ({
		page
	}, testInfo) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.CacheOnce);
		let releaseProbe!: () => void;
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		await page.route(
			'**/collections/bootstrap/probe?**',
			async (route) => {
				await probeGate;
				await route.fallback();
			},
			{ times: 1 }
		);
		await probeButton(page).click();
		await expect(probeButton(page)).toContainText('probing');
		await expect(probeButton(page)).toHaveAttribute('aria-busy', 'true');
		await expect(probeButton(page).getByRole('img', { name: 'probing contract' })).toBeVisible();
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath('probe-pending.png'), fullPage: true });
		await page.locator('input[name="sampleTokenId"]').fill('3');
		const staleProbe = page.waitForResponse('**/collections/bootstrap/probe?**');
		releaseProbe();
		await staleProbe;
		await expect(formRow(page, 'Image source field')).not.toContainText('found in sample');
		await expect(page.locator('input[name="sampleTokenId"]')).toHaveValue('3');
		await probeButton(page).click();
		await expect(formRow(page, 'Image source field')).toContainText('found in sample');
		let releaseEstimate!: () => void;
		const estimateGate = new Promise<void>((resolve) => {
			releaseEstimate = resolve;
		});
		await page.route(
			'**/collections/bootstrap/image-cache-estimate',
			async (route) => {
				await estimateGate;
				await route.fallback();
			},
			{ times: 1 }
		);
		await page.getByRole('button', { name: 'estimate', exact: true }).click();
		const estimate = page.getByRole('button', { name: 'estimate', exact: true });
		await expect(estimate).toContainText('estimating');
		await expect(estimate).toHaveAttribute('aria-busy', 'true');
		await expect(estimate.getByRole('img')).toBeVisible();
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath('estimate-pending.png'), fullPage: true });
		await rowControl(page, 'Token count').fill('3333');
		const staleEstimate = page.waitForResponse('**/collections/bootstrap/image-cache-estimate');
		releaseEstimate();
		await staleEstimate;
		await expect(formRow(page, 'Max dimension (px)')).toContainText('not estimated');
		await page.getByRole('button', { name: 'estimate', exact: true }).click();
		await expect(formRow(page, 'Max dimension (px)')).not.toContainText('not estimated');
		expect(api.imageCacheEstimateRequests).toMatchObject([
			{ totalSupply: '999' },
			{ totalSupply: '3333' }
		]);
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
		await installBootstrapProbeApiMock(page, (response) => ({
			...response,
			firstToken: {
				...response.firstToken,
				tokenUriPayload: payload,
				tokenUriPayloadBytes: Buffer.byteLength(payload)
			}
		}));
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
		await installBootstrapProbeApiMock(page, (response) => ({
			...response,
			firstToken: {
				...response.firstToken,
				tokenUriPayload: payload,
				tokenUriPayloadError: 'Token metadata is not valid JSON.'
			}
		}));
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await probeButton(page).click();
		const frame = page.frameLocator('iframe[title="tokenURI response"]');
		await expect(frame.getByText('Response is not valid JSON')).toBeVisible();
		await expect(frame.getByText(payload, { exact: true })).toBeVisible();
		await expect(queueButton(page)).toBeEnabled();
		await page.locator('input[name="sampleTokenId"]').fill('3');
		await expect(page.getByTitle('tokenURI response', { exact: true })).toHaveCount(0);
	});

	test('shows OpenSea progress inside resolve and replaces the action with a cyan resolved badge', async ({
		page
	}, testInfo) => {
		await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route(
			'**/collections/bootstrap/opensea-slug-probe?**',
			async (route) => {
				await gate;
				await route.fallback();
			},
			{ times: 1 }
		);
		const row = formRow(page, 'OpenSea slug');
		const resolve = row.getByRole('button', { name: 'resolve', exact: true });
		await resolve.click();
		await expect(resolve).toContainText('resolving');
		await expect(resolve).toHaveAttribute('aria-busy', 'true');
		await expect(resolve.getByRole('img', { name: 'resolving OpenSea slug' })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath('opensea-resolving.png'), fullPage: true });
		release();
		const resolved = row.getByText('resolved', { exact: true });
		await expect(resolved).toBeVisible();
		await expect(resolve).toHaveCount(0);
		await expect(resolved).toHaveClass(/bid-book-own-status-draw/);
		await page.screenshot({ path: testInfo.outputPath('opensea-resolved.png'), fullPage: true });
		await page.locator('input[name="openseaSlug"]').fill('different-collection');
		await expect(resolve).toBeEnabled();
		await expect(resolved).toHaveCount(0);
	});

	test('omits optional OpenSea when its sample is outside the selected scope', async ({ page }) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await probeButton(page).click();
		await expect(formRow(page, 'OpenSea slug')).toContainText('resolved');
		await rowControl(page, 'First token ID').fill('10');
		await expect(sampleTokenInputRow(page)).toContainText('outside the selected scope');
		await expect(queueButton(page)).toBeEnabled();
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).not.toHaveProperty('openseaSlug');
		expect(api.mutations[0].body).toMatchObject({
			manualInput: { startTokenId: '10', totalSupply: 999 }
		});
	});

	test('validates explicit token IDs without making a sample mandatory', async ({ page }) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await rowControl(page, 'Token scope').selectOption(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds);
		await expect(queueButton(page)).toBeDisabled();
		await rowControl(page, 'Token IDs').fill('1, invalid, 3');
		await expect(page.getByRole('region', { name: /2. Token scope/ })).toContainText(
			'Enter decimal token IDs'
		);
		await rowControl(page, 'Token IDs').fill('1, 3');
		await expect(queueButton(page)).toBeEnabled();
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).toMatchObject({
			manualInput: { mode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds, tokenIds: ['1', '3'] }
		});
		expect(api.probeRequests).toEqual([]);
	});

	test('keeps optional OpenSea failure local and recoverable', async ({ page }, testInfo) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await page.locator('input[name="openseaSlug"]').fill('another-project');
		await probeButton(page).click();
		await expect(formRow(page, 'OpenSea slug')).toContainText('incorrect');
		await expect(
			formRow(page, 'OpenSea slug').getByRole('button', { name: 'resolve' })
		).toBeEnabled();
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({
			path: testInfo.outputPath('opensea-optional-failure.png'),
			fullPage: true
		});
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).not.toHaveProperty('openseaSlug');
	});

	test('renders sample and cache previews only on request and preserves animation choice', async ({
		page
	}, testInfo) => {
		await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
		await rowControl(page, 'Animation source field (optional)').fill('animation_url');
		await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.CacheOnce);
		await page.route(BOOTSTRAP_PROBE_MEDIA.DynamicAnimationUrl, (route) =>
			route.fulfill({
				contentType: 'text/html',
				body: '<html><body>Sample animation</body></html>'
			})
		);
		await probeButton(page).click();
		await expect(page.getByTestId(TEST_IDS.BootstrapProbeTokenCard)).toHaveCount(0);
		await page.getByRole('button', { name: 'preview sample', exact: true }).click();
		await expect(page.getByTestId(TEST_IDS.BootstrapProbeTokenCard)).toBeVisible();
		await page.getByRole('button', { name: 'animation', exact: true }).click();
		await expect(page.getByTitle(/animation preview/)).toBeVisible();
		await expect(
			page.frameLocator('iframe[title$="animation preview"]').getByText('Sample animation')
		).toBeVisible();
		await page.getByRole('button', { name: 'estimate', exact: true }).click();
		await page.getByRole('button', { name: 'preview cached image', exact: true }).click();
		await expect(page.getByTestId(TEST_IDS.BootstrapCacheTokenCard)).toBeVisible();
		await expect(page.getByText('Source image (1 token)', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'view checks', exact: true }).click();
		await expect(page.getByText('Metadata (1 token)', { exact: true })).toBeVisible();
		await page.screenshot({
			path: testInfo.outputPath('previews-and-estimate.png'),
			fullPage: true
		});
		await expect(queueButton(page)).toBeEnabled();
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
			.locator('.bootstrap-form-label-cell > span:first-child')
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
