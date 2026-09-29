import { expect, test, type Locator, type Page } from 'playwright/test';
import { writeFile } from 'node:fs/promises';
import { OPENSEA_COLLECTION_SLUG_PROBE_ERROR } from '@artgod/shared/opensea/collection-slug-probe';
import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
import { BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION } from '@artgod/shared/config/bootstrap';
import {
	BOOTSTRAP_ACTION_LABEL as Action,
	BOOTSTRAP_OPERATION as Operation,
	BOOTSTRAP_OUTPUT_STEP as Step,
	BOOTSTRAP_OUTPUT_STATUS as OutputStatus,
	BOOTSTRAP_OUTPUT_MAX_ENTRIES
} from '@artgod/shared/bootstrap/operation-output';
import {
	bootstrapTestContract,
	BOOTSTRAP_TEST_PROJECT_SCOPE
} from '@artgod/shared/testing/bootstrap-probe';
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
	installBootstrapProbeApiMock,
	pauseBootstrapSampleMetadata,
	fulfillBootstrapOutput
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
	test('offers the sampled Art Blocks project range after a pasted URL without changing entered scope', async ({
		page
	}, info) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
		await pasteBootstrapAddress(
			page,
			`https://opensea.io/item/ethereum/${BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope}/163000485`
		);
		const release = await pauseBootstrapSampleMetadata(page);
		await probeButton(page).click();
		await expect(page.getByRole('button', { name: Action.Inspect, exact: true })).toContainText(
			'inspecting'
		);
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('1');
		await expect(page.locator('#bootstrap-range-count')).toHaveValue('999');
		await expect(formRow(page, 'Token count').getByRole('button', { name: /^apply/ })).toHaveCount(
			0
		);
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('project-inspecting.png'), fullPage: true });
		await release.evaluate((resume) => resume());
		const applyStart = formRow(page, 'First token ID').getByRole('button', {
			name: 'apply "163000000"',
			exact: true
		});
		const applyCount = formRow(page, 'Token count').getByRole('button', {
			name: 'apply "1000"',
			exact: true
		});
		await expect(applyStart).toBeVisible();
		await expect(applyCount).toBeVisible();
		await expect(formRow(page, 'Token scope')).toContainText('Meridian · project #163.');
		await expect(page.getByRole('button', { name: 'apply "entire contract"' })).toHaveCount(0);
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('1');
		await expect(page.locator('#bootstrap-range-count')).toHaveValue('999');
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('project-suggestions.png'), fullPage: true });
		await applyCount.click();
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('1');
		await applyStart.click();
		await expect(applyCount).toBeDisabled();
		await expect(applyStart).toBeDisabled();
		await expect(formRow(page, 'Token count')).toContainText(
			'Specified token IDs range: 163000000–163000999'
		);
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('project-applied.png'), fullPage: true });
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).toMatchObject({
			scope: {
				mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
				startTokenId: '163000000',
				tokenCount: 1000
			}
		});
	});
	test('offers minted and maximum project counts despite unavailable metadata and preserves explicit scope choices', async ({
		page
	}, info) => {
		await installBootstrapProbeApiMock(page, {
			sample: (response) => ({
				...response,
				projectScope: { ...BOOTSTRAP_TEST_PROJECT_SCOPE, mintedTokenCount: 486 },
				sample: {
					...response.sample,
					tokenUriPayload: null,
					tokenUriPayloadError: 'Metadata download failed (HTTP 429). Press inspect token to retry.'
				}
			})
		});
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
		await page.locator('#bootstrap-sample').fill('163000485');
		await page.locator('#bootstrap-scope-mode').selectOption(BOOTSTRAP_ENUMERATION_MODE.Enumerable);
		await page.getByRole('button', { name: Action.Inspect, exact: true }).click();
		await expect(formRow(page, 'Sample token ID')).toContainText('HTTP 429');
		await expect(page.locator('#bootstrap-scope-mode')).toHaveValue(
			BOOTSTRAP_ENUMERATION_MODE.Enumerable
		);
		await formRow(page, 'Token scope')
			.getByRole('button', { name: 'apply "token range"', exact: true })
			.click();
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('1');
		const counts = formRow(page, 'Token count');
		const minted = counts.getByRole('button', { name: 'apply "486" minted', exact: true });
		const maximum = counts.getByRole('button', { name: 'apply "1000" maximum', exact: true });
		await expect(minted).toBeVisible();
		await expect(maximum).toBeVisible();
		await expect(counts).toContainText('includes unminted token IDs');
		await expectGridAlignment(page);
		await page.screenshot({
			path: info.outputPath('project-partially-minted.png'),
			fullPage: true
		});
		await minted.click();
		await expect(page.locator('#bootstrap-range-count')).toHaveValue('486');
		await maximum.click();
		await expect(page.locator('#bootstrap-range-count')).toHaveValue('1000');
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('1');
		await expect(queueButton(page)).toBeEnabled();
		await page.locator('#bootstrap-sample').fill('164000001');
		await expect(minted).toHaveCount(0);
		await expect(maximum).toHaveCount(0);
		await expect(formRow(page, 'Token scope')).not.toContainText('Meridian');
		await expect(page.locator('#bootstrap-range-count')).toHaveValue('1000');
	});
	test('discards a late project suggestion after the sample changes', async ({ page }) => {
		await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
		await page.locator('#bootstrap-sample').fill('163000485');
		const release = await pauseBootstrapSampleMetadata(page);
		await probeButton(page).click();
		await expect(page.getByRole('button', { name: Action.Inspect, exact: true })).toContainText(
			'inspecting'
		);
		await page.locator('#bootstrap-sample').fill('164000001');
		await release.evaluate((resume) => resume());
		await expect(page.getByRole('button', { name: Action.Inspect, exact: true })).toBeEnabled();
		await expect(page.getByRole('button', { name: 'apply "163000000"' })).toHaveCount(0);
		await expect(formRow(page, 'Token count').getByRole('button', { name: /^apply/ })).toHaveCount(
			0
		);
		await expect(page.locator('#bootstrap-sample')).toHaveValue('164000001');
	});
	for (const prefix of [
		'https://opensea.io/item/ethereum',
		'https://gallery.example/any/chain/path'
	])
		test(`pastes an NFT URL into the contract and sample inputs from ${prefix}`, async ({
			page
		}, info) => {
			const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
			const address = BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope;
			await pasteBootstrapAddress(page, `${prefix}/${address}/163000681?ref=shared#media`);
			await expect(page.locator('#bootstrap-address')).toHaveValue(address);
			await expect(page.locator('#bootstrap-sample')).toHaveValue('163000681');
			await expect(page.locator('#bootstrap-range-start')).toHaveValue('1');
			await expect(page.locator('#bootstrap-range-count')).toHaveValue('999');
			await expect(page.locator('#bootstrap-slug')).toHaveValue('curated-collection');
			await expect(page.getByText('Ethereum (ethereum / 1)', { exact: true })).toBeVisible();
			await expect(probeButton(page)).toBeEnabled();
			await expect(queueButton(page)).toBeEnabled();
			expect(api.probeRequests).toEqual([]);
			expect(api.sampleRequests).toEqual([]);
			expect(api.openSeaSlugProbeSampleTokenIds).toEqual([]);
			const addressRow = formRow(page, 'Contract address or NFT URL');
			await addressRow.getByRole('button', { name: 'Help' }).press('Enter');
			await expect(addressRow.getByRole('tooltip')).toContainText(
				'A URL fills this address and Sample token ID.'
			);
			await expect(addressRow.getByRole('tooltip')).toBeInViewport({ ratio: 1 });
			await page.screenshot({ path: info.outputPath('nft-url-help.png') });
			await page.mouse.wheel(0, 100);
			await expect(addressRow.getByRole('tooltip')).toBeInViewport({ ratio: 1 });
			const viewport = page.viewportSize()!;
			await page.setViewportSize({
				width: viewport.width > 640 ? 1290 : 320,
				height: viewport.height
			});
			await expect(addressRow.getByRole('tooltip')).toBeInViewport({ ratio: 1 });
			await page.screenshot({ path: info.outputPath('nft-url-help-resized.png') });
			await page.setViewportSize(viewport);
			await addressRow.getByRole('button', { name: 'Help' }).press('Escape');
			await expect(addressRow.getByRole('tooltip')).toBeHidden();
			await expectGridAlignment(page);
			await page.screenshot({ path: info.outputPath('nft-url-ready.png') });
			await probeButton(page).click();
			await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
			expect(api.probeRequests).toEqual([address]);
			expect(api.sampleRequests).toHaveLength(1);
			expect(api.sampleRequests[0]).toMatchObject({
				address,
				requestedTokenId: '163000681',
				scope: { mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange, startTokenId: '1', tokenCount: 999 }
			});
			await expect(page.locator('#bootstrap-sample')).toHaveValue('163000681');
			await expectGridAlignment(page);
			await page.screenshot({ path: info.outputPath('nft-url-inspected.png'), fullPage: true });
		});

	test('keeps invalid NFT URLs editable and preserves the sample until a valid paste', async ({
		page
	}, info) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		const address = BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope;
		const invalidUrl = `https://gallery.example/${address}/123abc`;
		await pasteBootstrapAddress(page, invalidUrl);
		await expect(page.locator('#bootstrap-address')).toHaveValue(invalidUrl);
		await expect(page.locator('#bootstrap-address')).toHaveAttribute('aria-invalid', 'true');
		await expect(page.locator('#bootstrap-sample')).toHaveValue('2');
		await expect(page.locator('#bootstrap-address-help')).toContainText(
			'<contract address>/<decimal token ID>'
		);
		await expect(probeButton(page)).toBeDisabled();
		await expect(queueButton(page)).toBeDisabled();
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('nft-url-invalid.png') });
		await pasteBootstrapAddress(page, `https://another.example/${address}/163000681`);
		await expect(page.locator('#bootstrap-address')).toHaveValue(address);
		await expect(page.locator('#bootstrap-sample')).toHaveValue('163000681');
		await expect(page.locator('#bootstrap-address-help')).toHaveCount(0);
		await expect(probeButton(page)).toBeEnabled();
		expect(api.probeRequests).toEqual([]);
		expect(api.sampleRequests).toEqual([]);
	});

	test('pastes a plain address without replacing the entered sample', async ({ page }) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await pasteBootstrapAddress(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await expect(page.locator('#bootstrap-address')).toHaveValue(
			BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable
		);
		await expect(page.locator('#bootstrap-sample')).toHaveValue('2');
		await expect(probeButton(page)).toBeEnabled();
		expect(api.probeRequests).toEqual([]);
	});

	test('waits for a typed NFT URL to finish before extracting its token ID', async ({ page }) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		const addressInput = page.locator('#bootstrap-address');
		const address = BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope;
		const url = `https://gallery.example/${address}/163000681`;
		await addressInput.fill(`https://gallery.example/${address}/`);
		await addressInput.pressSequentially('163000681');
		await expect(addressInput).toHaveValue(url);
		await expect(page.locator('#bootstrap-sample')).toHaveValue('2');
		await addressInput.press('Tab');
		await expect(addressInput).toHaveValue(address);
		await expect(page.locator('#bootstrap-sample')).toHaveValue('163000681');
		expect(api.probeRequests).toEqual([]);
	});

	test('discards an old inspection when an NFT URL selects another token on the same contract', async ({
		page
	}) => {
		const address = BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope;
		const api = await stageManualProbe(page, address);
		await page.locator('#bootstrap-sample').fill('163000000');
		const release = await pauseBootstrapSampleMetadata(page);
		await probeButton(page).click();
		await expect(page.getByRole('button', { name: Action.Inspect, exact: true })).toHaveAttribute(
			'aria-busy',
			'true'
		);
		await pasteBootstrapAddress(page, `https://gallery.example/${address}/163000681`);
		await release.evaluate((resume) => resume());
		await expect(page.locator('#bootstrap-address')).toHaveValue(address);
		await expect(page.locator('#bootstrap-sample')).toHaveValue('163000681');
		await expect(formRow(page, 'Contract checks')).toHaveCount(0);
		await expect(page.getByTitle('tokenURI response', { exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: Action.Inspect, exact: true })).toBeEnabled();
		await page.getByRole('button', { name: Action.Inspect, exact: true }).click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		await expect(page.locator('#bootstrap-sample')).toHaveValue('163000681');
		expect(api.sampleRequests.map((request) => request.requestedTokenId)).toEqual([
			'163000000',
			'163000681'
		]);
	});

	test('retains the exact Meridian resolution while the user corrects the token range', async ({
		page
	}, info) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
		await page.locator('#bootstrap-sample').fill('163000681');
		await page.locator('#bootstrap-range-count').fill('1000');
		await probeButton(page).click();
		await expect(page.getByTestId(TEST_IDS.BootstrapProbeTokenCard)).toBeVisible();
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('1');
		await page.getByRole('button', { name: 'resolve #163000681', exact: true }).click();
		await expect(
			formRow(page, 'Collection slug').getByRole('button', {
				name: `apply "${BOOTSTRAP_PROBE_OPENSEA_SLUGS.SharedManualScope}"`,
				exact: true
			})
		).toBeVisible();
		const scopeLink = page.locator('#bootstrap-opensea').getByRole('link', { name: 'check scope' });
		await expect(scopeLink).toBeVisible();
		await scopeLink.hover();
		await scopeLink.focus();
		const colors = await scopeLink.evaluate((element) => {
			const style = getComputedStyle(element);
			return { text: style.color, background: style.backgroundColor };
		});
		expect(colors.text).not.toBe(colors.background);
		await expect(page.locator('#bootstrap-opensea-slug')).toHaveValue(
			BOOTSTRAP_PROBE_OPENSEA_SLUGS.SharedManualScope
		);
		await expect(
			page.locator('#bootstrap-opensea').getByText('resolved', { exact: true })
		).toHaveCount(0);
		await expect(formRow(page, 'Token scope')).toContainText(
			'Sample #163000681 is outside this scope'
		);
		await expect(formRow(page, 'Token scope')).toContainText('skipped when queueing');
		await scopeLink.click();
		await expect(page.locator('#bootstrap-scope-mode')).toBeInViewport();
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('meridian-scope-conflict.png'), fullPage: true });
		await page.locator('#bootstrap-range-start').fill('163000000');
		await expect(scopeLink).toHaveCount(0);
		await expect(
			page.locator('#bootstrap-opensea').getByText('resolved', { exact: true })
		).toBeVisible();
		await expect(page.locator('#bootstrap-scope-sample-help')).toHaveCount(0);
		await expect(page.locator('#bootstrap-sample')).toHaveValue('163000681');
		expect(api.sampleRequests).toHaveLength(1);
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual(['163000681']);
		await page.screenshot({
			path: info.outputPath('meridian-scope-corrected.png'),
			fullPage: true
		});
		await queueButton(page).click();
		await expect.poll(() => api.mutations.length).toBe(1);
		expect(api.mutations[0].body).toMatchObject({
			openseaSlug: BOOTSTRAP_PROBE_OPENSEA_SLUGS.SharedManualScope,
			scope: {
				mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
				startTokenId: '163000000',
				tokenCount: 1000
			}
		});
	});

	test('uses the same square viewport for image and sandboxed animation previews', async ({
		page
	}, info) => {
		await page.route(BOOTSTRAP_PROBE_MEDIA.DynamicAnimationUrl, (route) =>
			route.fulfill({
				contentType: 'text/html',
				body: '<!doctype html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M20 90h80L60 20z" fill="cyan"/></svg></body>'
			})
		);
		await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await probeButton(page).click();
		await page.locator('#bootstrap-animation-field').fill('animation_url');
		const image = page.getByTestId(TEST_IDS.BootstrapProbeTokenCard).locator('.token-grid-media');
		await expect(image).toBeVisible();
		const imageBox = await image.boundingBox();
		expect(Math.abs(imageBox!.width - imageBox!.height)).toBeLessThan(1);
		const sectionBox = await page.locator('#bootstrap-details').boundingBox();
		expect(Math.abs(imageBox!.width - Math.min(400, sectionBox!.width))).toBeLessThan(1);
		await page.screenshot({ path: info.outputPath('sample-image-size.png'), fullPage: true });
		await page
			.getByLabel('Sample token preview source')
			.getByRole('button', { name: 'animation', exact: true })
			.click();
		const frame = page.getByTitle('token 2 animation preview', { exact: true });
		await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
		await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
		const animationBox = await frame.boundingBox();
		for (const dimension of ['width', 'height'] as const)
			expect(Math.abs(animationBox![dimension] - imageBox![dimension])).toBeLessThan(1);
		await page.screenshot({ path: info.outputPath('sample-animation-size.png'), fullPage: true });
		await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.CacheOnce);
		await page.getByRole('button', { name: 'estimate', exact: true }).click();
		const cached = page.getByTestId(TEST_IDS.BootstrapCacheTokenCard);
		await expect(cached).toBeVisible();
		const cachedBox = await cached.boundingBox();
		expect(Math.abs(cachedBox!.width - imageBox!.width)).toBeLessThan(1);
		const note = page.locator('#bootstrap-cache .bootstrap-setup-preview p');
		const noteBox = await note.boundingBox();
		expect(noteBox!.y - (cachedBox!.y + cachedBox!.height)).toBeGreaterThanOrEqual(
			(await note.evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight))) -
				1
		);
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('cached-image-size.png'), fullPage: true });
	});

	test('warns about non-enumerable shared contracts with unavailable supply without blocking manual setup', async ({
		page
	}, info) => {
		await installBootstrapProbeApiMock(page, {
			contract: (result) => ({
				...result,
				enumerable: { supported: false, error: null },
				totalSupply: {
					...result.totalSupply,
					value: null,
					safeIntegerValue: null,
					bootstrapRangeValue: null
				}
			})
		});
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
		await probeButton(page).click();
		await expect(formRow(page, 'Token scope')).toContainText('Likely shared contract.');
		await expect(formRow(page, 'Token scope')).toContainText('Contract token count unavailable.');
		await expect(page.getByRole('button', { name: 'apply "entire contract"' })).toHaveCount(0);
		await expect(queueButton(page)).toBeEnabled();
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('shared-non-enumerable.png'), fullPage: true });
	});

	test('warns about recognized shared contracts, hides the entire-contract suggestion and preserves manual control', async ({
		page
	}, info) => {
		await installBootstrapProbeApiMock(page, {
			contract: (result) => ({
				...result,
				totalSupply: {
					...result.totalSupply,
					value: '198051',
					safeIntegerValue: 198051,
					bootstrapRangeValue: 198051
				}
			})
		});
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
		await page.locator('#bootstrap-range-start').fill('163000000');
		await page.locator('#bootstrap-range-count').fill('1000');
		await probeButton(page).click();
		const scopeRow = formRow(page, 'Token scope');
		await expect(scopeRow).toContainText('Likely shared contract.');
		await expect(scopeRow).toContainText('198051 tokens across all projects');
		await expect(scopeRow.getByRole('button', { name: 'apply "entire contract"' })).toHaveCount(0);
		await expect(page.locator('#bootstrap-range-count')).toHaveValue('1000');
		await expect(formRow(page, 'ERC721Enumerable interface')).toContainText('yes');
		await expectGridAlignment(page);
		await page.screenshot({
			path: info.outputPath('shared-contract-suggestion.png'),
			fullPage: true
		});
		await page.locator('#bootstrap-scope-mode').selectOption(BOOTSTRAP_ENUMERATION_MODE.Enumerable);
		await expect(scopeRow).toContainText('Likely shared contract.');
		await expect(scopeRow).toContainText('198051 tokens across all projects');
		await page.screenshot({
			path: info.outputPath('shared-contract-selected.png'),
			fullPage: true
		});
		// A new target must not inherit the previous contract's count.
		await page.locator('#bootstrap-address').fill(BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await page.locator('#bootstrap-scope-mode').selectOption(BOOTSTRAP_ENUMERATION_MODE.Enumerable);
		await expect(scopeRow).not.toContainText('198051');
		await expect(scopeRow).not.toContainText('Likely shared contract.');
		await expect(scopeRow).toContainText('Contract token count unavailable.');
	});

	test('flashes new and changed suggestions while leaving edited inputs alone', async ({
		page
	}, info) => {
		// Pause the production animation so both viewports can inspect the real cyan flash.
		await page.addInitScript(() => {
			const animate = Element.prototype.animate;
			Element.prototype.animate = function (...args) {
				const animation = animate.apply(this, args);
				if (this.getAttribute('title')?.startsWith('apply "')) {
					animation.pause();
					animation.currentTime = 0;
				}
				return animation;
			};
		});
		let imageField = 'image';
		await installBootstrapProbeApiMock(page, {
			sample: (result) => ({
				...result,
				sample: {
					...result.sample,
					tokenUriPayload: JSON.stringify({ [imageField]: BOOTSTRAP_PROBE_MEDIA.RasterImage })
				}
			})
		});
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
		await probeButton(page).click();
		const suggestion = formRow(page, 'Image source field').getByRole('button', {
			name: 'apply "image"',
			exact: true
		});
		await expect(suggestion).toBeVisible();
		await expect
			.poll(() => suggestion.evaluate((element) => element.getAnimations().length))
			.toBe(1);
		await page.screenshot({ path: info.outputPath('cyan-suggestion-flash.png'), fullPage: true });
		await suggestion.evaluate((element) =>
			element.getAnimations().forEach((animation) => animation.finish())
		);
		await rowControl(page, 'Image source field').fill('custom_image');
		await expect
			.poll(() => suggestion.evaluate((element) => element.getAnimations().length))
			.toBe(0);
		imageField = 'image_url';
		await page.getByRole('button', { name: Action.Inspect, exact: true }).click();
		const changed = formRow(page, 'Image source field').getByRole('button', {
			name: 'apply "image_url"',
			exact: true
		});
		await expect(changed).toBeVisible();
		await expect.poll(() => changed.evaluate((element) => element.getAnimations().length)).toBe(1);
		await expect(rowControl(page, 'Image source field')).toHaveValue('custom_image');
	});

	test('shows the exact selectable failed URL and preserves earlier attempts', async ({
		page
	}, info) => {
		const failedUrl =
			'https://ipfs.filebase.io/ipfs/bafybeie63jlvjy46pnltbkkytjsi5r6fsmimvlmdmtxhyntprjhsjdrqvi/1000?format=json';
		await installBootstrapProbeApiMock(page, {
			sample: (response) => ({
				...response,
				sample: {
					...response.sample,
					tokenUri: failedUrl,
					tokenUriPayload: null,
					tokenUriPayloadError: 'Metadata download failed (HTTP 504). Press inspect token to retry.'
				}
			})
		});
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await page.locator('#bootstrap-sample').fill('1000');
		await page.locator('#bootstrap-range-count').fill('3333');
		await probeButton(page).click();
		const log = page.getByRole('log', { name: 'bootstrap checks' });
		await expect(log).toContainText('HTTP 504');
		await expect(log.locator('code').last()).toHaveText(failedUrl);
		await expect(log).toHaveCSS('user-select', 'text');
		await expect(log.getByRole('button', { name: /copy url/ })).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'setup output' })).toHaveCount(0);
		await page.getByRole('button', { name: Action.Inspect, exact: true }).click();
		await expect(
			log.getByText('Metadata download failed (HTTP 504). Press inspect token to retry.', {
				exact: true
			})
		).toHaveCount(2);
		await expect(queueButton(page)).toBeEnabled();
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('output-metadata-failure.png'), fullPage: true });
		if (info.project.name === 'desktop-1080p') {
			await page.setViewportSize({ width: 1290, height: 900 });
			await expectGridAlignment(page);
			await page.screenshot({ path: info.outputPath('output-1290.png'), fullPage: true });
		}
	});

	test('bounds output history and stops following while earlier lines are being read', async ({
		page
	}, info) => {
		await installBootstrapProbeApiMock(page);
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await page.evaluate(() => window.scrollTo(0, 0));
		const terminal = page.getByRole('complementary', { name: 'setup output' });
		await expect
			.poll(async () => {
				const box = await terminal.boundingBox();
				const viewportHeight = page.viewportSize()!.height;
				return info.project.name === 'desktop-1080p'
					? viewportHeight - (box!.y + box!.height)
					: viewportHeight - box!.height;
			})
			.toBeGreaterThanOrEqual(0);
		const initialBox = (await terminal.boundingBox())!;
		const viewportHeight = page.viewportSize()!.height;
		expect(
			info.project.name === 'desktop-1080p'
				? viewportHeight - (initialBox.y + initialBox.height)
				: viewportHeight - initialBox.height
		).toBeLessThanOrEqual(24);
		await page.screenshot({ path: info.outputPath('output-first-screen.png') });
		await page.route('**/collections/bootstrap/probe?**', (route) =>
			fulfillBootstrapOutput(
				route,
				Operation.Probe,
				Array.from({ length: BOOTSTRAP_OUTPUT_MAX_ENTRIES + 20 }, (_, index) => ({
					step: Step.Ownership,
					status: OutputStatus.Succeeded,
					message: `Token #${index} owner confirmed`
				})),
				bootstrapTestContract()
			)
		);
		await probeButton(page).click();
		const log = page.getByRole('log', { name: 'bootstrap checks' });
		await expect(log).toContainText('earlier entries removed');
		await expect(log.locator('.bootstrap-output-entry')).toHaveCount(BOOTSTRAP_OUTPUT_MAX_ENTRIES);
		await expect
			.poll(async () => Math.abs((await terminal.boundingBox())!.height - initialBox.height))
			.toBeLessThan(1);
		await expect
			.poll(() => log.evaluate((element) => element.scrollHeight - element.clientHeight))
			.toBeGreaterThan(0);
		await log.evaluate((element) => {
			element.scrollTop = 0;
			element.dispatchEvent(new Event('scroll'));
		});
		await expect(page.getByRole('button', { name: 'latest', exact: true })).toBeVisible();
		await page.getByRole('button', { name: Action.Inspect, exact: true }).click();
		await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBeLessThan(50);
		await page.getByRole('button', { name: 'latest', exact: true }).click();
		await expect
			.poll(() =>
				log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
			)
			.toBeLessThan(32);
		await page.screenshot({ path: info.outputPath('output-bounded.png'), fullPage: true });
		if (info.project.name === 'desktop-1080p') {
			await page.setViewportSize({ width: 1290, height: 600 });
			await page.evaluate(() => window.scrollTo(0, 0));
			await expect
				.poll(async () => {
					const bounds = (await terminal.boundingBox())!;
					return Math.abs(bounds.y + bounds.height - 588);
				})
				.toBeLessThan(1);
			await page.screenshot({ path: info.outputPath('output-short-viewport.png') });
		}
	});

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

	test('keeps field validation and action prerequisites in the aligned right column', async ({
		page
	}, info) => {
		await installBootstrapProbeApiMock(page);
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await page.locator('#bootstrap-address').fill('0x123');
		await page.locator('#bootstrap-range-start').fill('-1');
		await page.locator('#bootstrap-range-count').fill('0');
		await page.locator('#bootstrap-slug').fill('invalid slug!');
		await rowControl(page, 'Image cache mode').selectOption(IMAGE_CACHE_MODE.CacheOnce);
		await page.locator('#bootstrap-cache-dimension').fill('1');
		for (const id of ['address', 'range-start', 'range-count', 'slug', 'cache-dimension']) {
			const input = page.locator(`#bootstrap-${id}`);
			await expect(input).toHaveAttribute('aria-invalid', 'true');
			const descriptionId = await input.getAttribute('aria-describedby');
			await expect(page.locator(`#${descriptionId}`)).toBeVisible();
		}
		await expect(queueButton(page)).toBeDisabled();
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('field-validation.png'), fullPage: true });
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
			page
				.locator('.bootstrap-create-form')
				.getByText('Queue response unavailable. Check bootstrap runs before retrying.')
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
		await expect(page.getByRole('button', { name: Action.Inspect, exact: true })).toContainText(
			'inspecting'
		);
		await expect(
			page
				.getByRole('button', { name: Action.Inspect, exact: true })
				.getByRole('img', { name: 'inspecting sample' })
		).toBeVisible();
		await expect(formRow(page, 'Contract checks')).toBeVisible();
		await expectGridAlignment(page);
		await page.screenshot({
			path: info.outputPath('contract-ready-sample-loading.png'),
			fullPage: true
		});
		release();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		expect(api.probeRequests).toHaveLength(1);
	});

	for (const enteredSample of ['', '163000681'])
		test(`shows the selected sample before metadata finishes with override ${JSON.stringify(enteredSample)}`, async ({
			page
		}, info) => {
			const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope);
			await page.locator('#bootstrap-sample').fill(enteredSample);
			await page.locator('#bootstrap-range-start').fill('163000000');
			await page.locator('#bootstrap-range-count').fill('1000');
			const release = await pauseBootstrapSampleMetadata(page);
			await probeButton(page).click();
			const selectedId = enteredSample || '163000000';
			await expect(page.locator('#bootstrap-sample')).toHaveValue(selectedId);
			await expect(page.getByRole('button', { name: Action.Inspect, exact: true })).toHaveAttribute(
				'aria-busy',
				'true'
			);
			await expect(page.getByTitle('tokenURI response', { exact: true })).toHaveCount(0);
			await expect(
				page.getByRole('button', { name: `resolve #${selectedId}`, exact: true })
			).toBeEnabled();
			await expectGridAlignment(page);
			await page.screenshot({
				path: info.outputPath('selected-sample-loading.png'),
				fullPage: true
			});
			await release.evaluate((resume) => resume());
			await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
			await expect(page.locator('#bootstrap-sample')).toHaveValue(selectedId);
			expect(api.sampleRequests[0].requestedTokenId).toBe(enteredSample);
			expect(api.openSeaSlugProbeSampleTokenIds).toEqual([selectedId]);
		});

	test('recovers from automatic inspection failure before a sample is selected', async ({
		page
	}, info) => {
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
		await page.locator('#bootstrap-sample').fill('');
		await page.route(
			'**/collections/bootstrap/sample',
			(route) =>
				route.fulfill({
					status: 502,
					contentType: 'application/json',
					body: '{}'
				}),
			{ times: 1 }
		);
		await probeButton(page).click();
		await expect(page.locator('#bootstrap-sample-help')).toContainText(
			`Press ${Action.Probe} to retry or enter a sample token ID.`
		);
		const inspect = page.getByRole('button', { name: Action.Inspect, exact: true });
		await expect(inspect).toBeDisabled();
		await expect(probeButton(page)).toBeEnabled();
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('sample-selection-failed.png'), fullPage: true });
		await page.locator('#bootstrap-sample').fill('42');
		await expect(inspect).toBeEnabled();
		await inspect.click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		await expect(page.locator('#bootstrap-sample')).toHaveValue('42');
		expect(api.sampleRequests[0].requestedTokenId).toBe('42');
		expect(api.probeRequests).toHaveLength(1);
	});

	test('fills the automatic sample and applies scope suggestions independently', async ({
		page
	}, info) => {
		const api = await installBootstrapProbeApiMock(page);
		await page.goto(BOOTSTRAP_PROBE_E2E_ROUTE_PATH);
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('');
		await contractAddressSafetyAcknowledgement(page).check();
		await page.locator('#bootstrap-address').fill(BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster);
		await expect(page.getByRole('button', { name: Action.Inspect, exact: true })).toBeDisabled();
		await probeButton(page).click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		await expect(page.locator('#bootstrap-sample')).toHaveValue('0');
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('');
		await formRow(page, 'Token count').getByRole('button', { name: 'apply "10000"' }).click();
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('');
		await expect(queueButton(page)).toBeDisabled();
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('range-start-empty.png'), fullPage: true });
		await formRow(page, 'First token ID').getByRole('button', { name: 'apply "0"' }).click();
		await expect(page.locator('#bootstrap-range-start')).toHaveValue('0');
		await formRow(page, 'Image source field')
			.getByRole('button', { name: 'apply "image"' })
			.click();
		await formRow(page, 'Collection slug').getByRole('button', { name: 'apply "milady"' }).click();
		await formRow(page, 'Animation source field (optional)')
			.getByRole('button', { name: 'apply "animation_url"' })
			.click();
		await expect(page.locator('#bootstrap-animation-field')).toHaveValue('animation_url');
		await expect(page.locator('#bootstrap-sample')).toHaveValue('0');
		await expect(page.locator('#bootstrap-range-count')).toHaveValue('10000');
		expect(api.sampleRequests).toHaveLength(1);
		await expect(page.getByRole('button', { name: 'estimate', exact: true })).toBeEnabled();
		await expect(page.locator('#bootstrap-scope-mode')).toHaveValue(
			BOOTSTRAP_ENUMERATION_MODE.ManualRange
		);
		await page.getByRole('button', { name: 'resolve #0', exact: true }).click();
		await expect(page.locator('#bootstrap-opensea .bootstrap-resolution-badge')).toHaveText(
			'resolved'
		);
		// Both sources suggest the same local slug; one apply control is enough.
		await expect(
			formRow(page, 'Collection slug').getByRole('button', { name: /^apply / })
		).toHaveCount(1);
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
		await expect(page.getByTestId(TEST_IDS.BootstrapProbeTokenCard).locator('img')).toHaveAttribute(
			'src',
			BOOTSTRAP_PROBE_MEDIA.NonEnumerableImage
		);
		await page.locator('#bootstrap-animation-field').fill('missing_field');
		const animationTab = page
			.getByLabel('Sample token preview source')
			.getByRole('button', { name: 'animation', exact: true });
		await expect(animationTab).toHaveCount(0);
		await page.locator('#bootstrap-animation-field').fill('generator_url');
		await expect(animationTab).toBeVisible();
		expect(api.sampleRequests).toHaveLength(1);
		await page.locator('#bootstrap-sample').fill('42');
		await expect(page.getByTitle('tokenURI response', { exact: true })).toHaveCount(1);
		await expect(formRow(page, 'Contract total supply')).toContainText('10000');
		await page.getByRole('button', { name: Action.Inspect, exact: true }).click();
		await expect(page.getByTitle('tokenURI response', { exact: true }).last()).toBeVisible();
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
		await expect(page.getByRole('button', { name: 'resolve #163000000', exact: true })).toHaveCount(
			0
		);
		await expectGridAlignment(page);
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
		await expect(sampleTokenInputRow(page)).toContainText('Choose another sample token ID.');
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: info.outputPath('sparse-absent-sample.png'), fullPage: true });
		await page.locator('#bootstrap-sample').fill('10');
		await page.getByRole('button', { name: Action.Inspect, exact: true }).click();
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
					tokenUriPayloadError: 'Metadata download failed (HTTP 429). Press inspect token to retry.'
				}
			})
		});
		await stageManualProbeInputs(page, BOOTSTRAP_PROBE_CONTRACTS.Aeon);
		await probeButton(page).click();
		await expect(page.getByRole('alert')).toContainText('HTTP 429');
		await expectGridAlignment(page);
		await expect(
			formRow(page, 'Token count').getByRole('button', { name: 'apply "3333"' })
		).toBeVisible();
		await expect(
			formRow(page, 'First token ID').getByRole('button', { name: 'apply "1"' })
		).toBeVisible();
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: info.outputPath('aeon-metadata-429.png'), fullPage: true });
		await page.getByRole('button', { name: Action.Inspect, exact: true }).click();
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
		await page.screenshot({ path: info.outputPath('cache-estimate-total.png'), fullPage: true });
		await page.locator('#bootstrap-range-count').fill('500');
		await expect(formRow(page, 'Estimated cache (selected scope)')).toContainText('not available');
		await expect(estimate).toBeDisabled();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		await expect(
			page.locator('#bootstrap-opensea').getByRole('link', { name: 'check scope' })
		).toBeVisible();
		await expect(formRow(page, 'Token scope')).toContainText('skipped when queueing');
		await expectGridAlignment(page);
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
			await expectGridAlignment(page);
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
		await expect(page.getByRole('button', { name: Action.Inspect, exact: true })).toContainText(
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
		const oldRequestFailed = page.waitForEvent('requestfailed', (request) =>
			request.url().includes('/ethereum/collections/bootstrap/probe?')
		);
		await page
			.getByRole('navigation', { name: 'Test chain' })
			.getByRole('link', { name: 'Arbitrum' })
			.click();
		await expect(page.getByText('Arbitrum (arbitrum / 42161)', { exact: true })).toBeVisible();
		await expect(page.locator('#bootstrap-slug')).toHaveValue('retained-draft');
		await expect(probeButton(page)).toBeEnabled();
		await probeButton(page).click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		release();
		await oldRequestFailed;
		await expect(formRow(page, 'Contract checks')).toBeVisible();
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
		// Streaming operations report transport failure once; retry is an explicit action.
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
		const api = await stageManualProbe(page, BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
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
		const resolve = page.locator('#bootstrap-opensea').getByRole('button', { name: /^resolve #/ });
		const slugRow = formRow(page, 'Collection slug');
		const openSeaSuggestion = slugRow.getByRole('button', {
			name: `apply "${BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable}"`,
			exact: true
		});
		await expect(openSeaSuggestion).toHaveCount(0);
		await expect(resolve).toHaveAccessibleName('resolve #2');
		await expect(resolve).toContainText('resolving #2');
		await expect(resolve).toHaveClass('action-button-positive');
		await expect(resolve.getByRole('img', { name: 'resolving OpenSea slug' })).toBeVisible();
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('opensea-loading.png'), fullPage: true });
		const oldRequestFailed = page.waitForEvent('requestfailed', (request) =>
			request.url().includes('opensea-slug-probe')
		);
		await page.locator('#bootstrap-sample').fill('3');
		await expect(resolve).toHaveAccessibleName('resolve #3');
		await page.locator('#bootstrap-opensea-slug').fill('user-edited-slug');
		release();
		await oldRequestFailed;
		await expect(page.locator('#bootstrap-opensea-slug')).toHaveValue('user-edited-slug');
		await expect(page.locator('#bootstrap-opensea .bootstrap-resolution-badge')).toHaveCount(0);
		await resolve.click();
		await expect(page.locator('#bootstrap-opensea')).toContainText(
			'OpenSea did not confirm this collection slug'
		);
		await expect(openSeaSuggestion).toHaveCount(0);
		await expectGridAlignment(page);
		await expect(queueButton(page)).toBeEnabled();
		await page.screenshot({ path: info.outputPath('opensea-incorrect.png'), fullPage: true });
		await page.locator('#bootstrap-opensea-slug').fill('');
		await resolve.click();
		await expect(page.locator('#bootstrap-opensea .bootstrap-resolution-badge')).toHaveText(
			'resolved'
		);
		await expect(slugRow.getByRole('button', { name: /^apply / })).toHaveCount(2);
		await expect(
			page
				.locator('#bootstrap-opensea')
				.getByRole('link', { name: '[collection page]', exact: true })
		).toHaveAttribute(
			'href',
			`https://opensea.io/collection/${BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable}`
		);
		await expect(
			page
				.locator('#bootstrap-opensea')
				.getByRole('link', { name: '[sample token #3]', exact: true })
		).toHaveAttribute(
			'href',
			`https://opensea.io/item/ethereum/${BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable}/3`
		);
		await expect(page.locator('#bootstrap-slug')).toHaveValue('curated-collection');
		await expect(openSeaSuggestion).toBeEnabled();
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('opensea-slug-suggestion.png'), fullPage: true });
		await openSeaSuggestion.click();
		await expect(page.locator('#bootstrap-slug')).toHaveValue(
			BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable
		);
		await expect(page.locator('#bootstrap-opensea-slug')).toHaveValue(
			BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable
		);
		await expect(page.locator('#bootstrap-opensea .bootstrap-resolution-badge')).toHaveText(
			'resolved'
		);
		await expect(openSeaSuggestion).toBeDisabled();
		await page.screenshot({ path: info.outputPath('opensea-slug-applied.png'), fullPage: true });
		await page.locator('#bootstrap-opensea-slug').fill('another-slug');
		await expect(openSeaSuggestion).toHaveCount(0);
		await expect(page.locator('#bootstrap-slug')).toHaveValue(
			BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable
		);
		expect(api.openSeaSlugProbeSampleTokenIds.at(-1)).toBe('3');
		await page.locator('#bootstrap-sample').fill('');
		await expect(page.getByRole('button', { name: Action.Inspect, exact: true })).toBeDisabled();
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
		await expectGridAlignment(page);
		await page.screenshot({ path: info.outputPath('image-loading.png'), fullPage: true });
		const oldRequestFailed = page.waitForEvent(
			'requestfailed',
			(request) =>
				request.url().includes('image-cache-estimate') &&
				request.postDataJSON().maxDimension === BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION
		);
		await rowControl(page, 'Max dimension (px)').fill('64');
		await estimate.click();
		await expect(formRow(page, 'Cached image (1 token)')).toContainText('64 x 64px');
		await expect(page.getByTestId(TEST_IDS.BootstrapCacheTokenCard)).toBeVisible();
		release();
		await oldRequestFailed;
		await expect(formRow(page, 'Cached image (1 token)')).toContainText('64 x 64px');
		expect(api.imageCacheEstimateRequests).toEqual(
			expect.arrayContaining([expect.objectContaining({ maxDimension: 64 })])
		);
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
				await page.screenshot({
					path: test.info().outputPath('scope-entire-contract.png'),
					fullPage: true
				});
				await page
					.locator('#bootstrap-scope-mode')
					.selectOption(BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds);
				await rowControl(page, 'Token IDs').fill('0, 42, 00042');
				await expect(page.getByText('2 token IDs selected.', { exact: true })).toBeVisible();
				await expectGridAlignment(page);
				await page.screenshot({
					path: test.info().outputPath('scope-explicit-list.png'),
					fullPage: true
				});
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
		await expect(rowControl(page, 'Max dimension (px)')).toHaveValue(
			String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION)
		);
		await formRow(page, 'Max dimension (px)').getByRole('button', { name: 'apply "64"' }).click();
		await expect(rowControl(page, 'Max dimension (px)')).toHaveValue('64');
		await expect(rowControl(page, 'Image cache mode')).toHaveValue(IMAGE_CACHE_MODE.CacheOnce);
		await expectGridAlignment(page);
		await page.screenshot({
			path: test.info().outputPath('extension-cache-suggestions.png'),
			fullPage: true
		});
		await page.locator('#bootstrap-range-count').fill('1000');
		await expect(mode).toHaveCount(0);
		expect(api.sampleRequests).toHaveLength(1);
	});

	test('keeps manual queueing available when OpenSea is disabled', async ({ page }, info) => {
		const api = await installBootstrapProbeApiMock(page);
		await page.goto(BOOTSTRAP_PROBE_E2E_ROUTE_PATH + '?opensea=disabled');
		const openSeaSection = page.locator('#bootstrap-opensea');
		const collectionLink = openSeaSection.getByRole('link', {
			name: '[collection page]',
			exact: true
		});
		const sampleLink = openSeaSection.getByRole('link', { name: /^\[sample token #/ });
		const slugInput = page.locator('#bootstrap-opensea-slug');
		await expect(openSeaSection.getByRole('link')).toHaveCount(0);
		await contractAddressSafetyAcknowledgement(page).check();
		await page.locator('#bootstrap-address').fill(BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable);
		await expect(slugInput).toBeEnabled();
		await slugInput.fill(BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable);
		await expect(collectionLink).toHaveAttribute(
			'href',
			`https://opensea.io/collection/${BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable}`
		);
		await page.locator('#bootstrap-sample').fill('0');
		await expect(sampleLink).toHaveAttribute(
			'href',
			`https://opensea.io/item/ethereum/${BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable}/0`
		);
		await expect(sampleLink).toHaveAttribute('target', '_blank');
		await expect(collectionLink).toHaveAttribute('rel', 'noreferrer noopener');
		expect(api.probeRequests).toEqual([]);
		expect(api.openSeaSlugProbeSampleTokenIds).toEqual([]);
		await expectGridAlignment(page);
		await page.screenshot({
			path: info.outputPath('opensea-links-without-key.png'),
			fullPage: true
		});
		await contractAddressSafetyAcknowledgement(page).uncheck();
		await expect(openSeaSection.getByRole('link')).toHaveCount(0);
		await expect(slugInput).toBeDisabled();
		await contractAddressSafetyAcknowledgement(page).check();
		await expect(collectionLink).toBeVisible();
		await page.locator('#bootstrap-sample').fill('-1');
		await expect(sampleLink).toHaveCount(0);
		await page.locator('#bootstrap-sample').fill('');
		await page.locator('#bootstrap-slug').fill('remilio');
		await page.locator('#bootstrap-range-start').fill('1');
		await page.locator('#bootstrap-range-count').fill('10000');
		await rowControl(page, 'Image source field').fill('image');
		await probeButton(page).click();
		await expect(page.getByTitle('tokenURI response', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'resolve #1', exact: true })).toBeDisabled();
		await expect(sampleLink).toHaveAttribute(
			'href',
			`https://opensea.io/item/ethereum/${BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable}/1`
		);
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
			await page.getByRole('button', { name: 'resolve #2', exact: true }).click();
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

	test('retains earlier malformed metadata in operation history after the sample changes', async ({
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
		await expect(page.getByTitle('tokenURI response', { exact: true })).toHaveCount(1);
	});
});
function probeButton(page: Page) {
	return page.getByRole('button', { name: Action.Probe, exact: true });
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

async function pasteBootstrapAddress(page: Page, value: string) {
	const input = page.locator('#bootstrap-address');
	await input.selectText();
	const useDefault = await input.evaluate((element, text) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', text);
		return element.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
		);
	}, value);
	// Synthetic clipboard events do not perform the browser's default text insertion.
	if (useDefault) await page.keyboard.insertText(value);
}

async function expectGridAlignment(page: Page) {
	const controls = page.locator(
		'.bootstrap-create-form .bootstrap-form-row input, .bootstrap-create-form .bootstrap-form-row select, .bootstrap-create-form .bootstrap-form-row textarea'
	);
	const boxes = await controls.evaluateAll((elements) =>
		elements.map((element) => {
			const rect = element.getBoundingClientRect();
			return { x: rect.x, width: rect.width, multiline: element.tagName === 'TEXTAREA' };
		})
	);
	for (const box of boxes) {
		expect(Math.abs(box.x - boxes[0].x)).toBeLessThan(2);
		if (!box.multiline) expect(box.width).toBeLessThanOrEqual(boxes[0].width + 2);
	}
	const countControl = rowControl(page, 'Token count');
	if (await countControl.count()) {
		const countBox = await countControl.boundingBox();
		expect(countBox!.width).toBeLessThan(boxes[0].width);
	}
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
	const notes = await page
		.locator('.bootstrap-create-form .bootstrap-row-note')
		.evaluateAll((elements) =>
			elements
				.filter((element) => element.getClientRects().length > 0)
				.map((element) => {
					const rect = element.getBoundingClientRect();
					return { text: element.textContent, x: rect.x, width: rect.width };
				})
		);
	for (const note of notes) {
		expect(Math.abs(note.x - actions[0].x), `message in action column: ${note.text}`).toBeLessThan(
			2
		);
		expect(note.width).toBeLessThanOrEqual(actions[0].width + 2);
	}
	if (page.viewportSize()!.width >= 1200) {
		const inspectorBox = await page
			.getByRole('complementary', { name: 'setup output' })
			.boundingBox();
		expect(Math.abs(inspectorBox!.width - formBox!.width)).toBeLessThan(2);
		expect(inspectorBox!.x).toBeGreaterThan(formBox!.x + formBox!.width);
	}
	if (page.viewportSize()!.width > 640) {
		const rows = await page
			.locator('.bootstrap-create-form .bootstrap-form-row')
			.evaluateAll((elements) =>
				elements.flatMap((row) => {
					const control = row.querySelector('input, select, textarea');
					// Align the actual first action or standalone badge, not its wrapper plus status text.
					const action = Array.from(row.querySelectorAll('.bootstrap-row-actions > *')).find(
						(element) => element.getClientRects().length > 0
					);
					if (!control || !action) return [];
					const inputBox = control.getBoundingClientRect();
					const actionBox = action.getBoundingClientRect();
					return [
						{
							name: control.getAttribute('id'),
							offset: inputBox.y + inputBox.height / 2 - actionBox.y - actionBox.height / 2
						}
					];
				})
			);
		const alignmentPath = test.info().outputPath('bootstrap-control-alignment.json');
		await writeFile(alignmentPath, JSON.stringify(rows, null, 2));
		await test.info().attach('bootstrap-control-alignment', {
			path: alignmentPath,
			contentType: 'application/json'
		});
		for (const row of rows) {
			expect(Math.abs(row.offset), `${row.name}: input/action vertical center`).toBeLessThan(2);
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
