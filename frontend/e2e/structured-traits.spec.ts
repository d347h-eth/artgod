import { expect, test } from 'playwright/test';
import { COLLECTION_MEDIA_MODES, COLLECTION_MEDIA_MODE_OPTIONS } from '@artgod/shared/extensions';
import {
	NFT111K_METADATA,
	NFT111K_STRUCTURED_BLOCK,
	NFT111K_EXTENSION_KEY,
	nft111kTraitCatalog as mapper
} from '@artgod/shared/extensions/111k';
import { TRAIT_CATALOG_QUERY } from '@artgod/shared/types/trait-catalog';
import { buildBiddingE2eTokenDetailData } from '../src/lib/e2e/bidding-automation-fixtures';
import { installBiddingAutomationApiMock } from './helpers/bidding-automation-api';

test('opens every Backrooms painting and mounts its fields on expansion', async ({
	page
}, info) => {
	const tokenId = '42';
	const fixture = buildBiddingE2eTokenDetailData(tokenId, new URLSearchParams());
	const path = '/' + fixture.chain.slug + '/' + fixture.collection.slug + '/' + tokenId;
	const pairs = [
		{ key: NFT111K_METADATA.CollectionBlock, value: NFT111K_STRUCTURED_BLOCK.Backrooms }
	];
	for (let slot = 1; slot <= 1447; slot++) {
		pairs.push(
			{ key: `Painting ${slot}`, value: 'Untitled' },
			{ key: `Painting ${slot} Artist`, value: `Artist number ${slot}` }
		);
	}
	const view = mapper.classify(pairs);
	const version = mapper.availableVersion(view);
	const output = mapper.project(view, version, pairs);
	let dataReads = 0;
	await page.route('**/api/**', (route) =>
		route.fulfill({ status: 404, json: { message: 'Unexpected fixture request' } })
	);
	await installBiddingAutomationApiMock(page);
	await page.route('**/api/runtime/config', (route) =>
		route.fulfill({ json: { bidding: { trustOpenSeaSignedZoneTraitOffers: true } } })
	);
	await page.route('**/collection-views*', (route) =>
		route.fulfill({
			json: {
				required: true,
				selectedViewId: view.id,
				collection: {
					...fixture.collection,
					extensions: [{ key: NFT111K_EXTENSION_KEY }],
					activityEventFeeds: []
				},
				views: [
					{
						...view,
						classified: 1,
						ready: 1,
						generation: 1,
						activeMapperVersion: version,
						availableMapperVersion: version
					}
				]
			}
		})
	);
	await page.route(
		(url) => url.pathname === '/api' + path,
		(route) => {
			dataReads++;
			const q = new URL(route.request().url()).searchParams;
			expect(q.get(TRAIT_CATALOG_QUERY.View)).toBe(view.id);
			expect(q.get(TRAIT_CATALOG_QUERY.Generation)).toBe('1');
			return route.fulfill({
				json: {
					...fixture,
					collection: { ...fixture.collection, extensions: [{ key: NFT111K_EXTENSION_KEY }] },
					media: {
						selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
						defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
						availableModes: [COLLECTION_MEDIA_MODE_OPTIONS.Snapshot],
						preference: null,
						selectedVariant: null,
						defaultVariant: null,
						availableVariants: []
					},
					token: {
						...fixture.token,
						name: 'Backrooms fixture',
						attributes: output.values.map((field) => ({
							key: field.fieldId,
							value: field.value,
							native: field.native,
							marketplaceBiddingSupported: field.native !== null,
							tokenCount: 1,
							rarityPercent: 100
						})),
						traitTree: output.tree
					}
				}
			});
		}
	);
	await page.goto('/e2e-harness/collection');
	await expect(page.locator('html')).toHaveAttribute('data-artgod-hydrated', '1');
	await page.evaluate((href) => {
		const link = document.createElement('a');
		link.href = href;
		document.body.append(link);
		link.click();
		link.remove();
	}, path);
	const heading = page.getByText('Paintings', { exact: true });
	const paintings = page.getByText(/^Painting [0-9]+$/);
	const lastPainting = page.getByText('Painting 1447', { exact: true });
	const lastArtist = page.getByText('Artist number 1447', { exact: true });
	await expect(heading).toBeVisible();
	expect(dataReads).toBeGreaterThan(0);
	await expect(paintings).toHaveCount(1447);
	await expect(lastArtist).toHaveCount(0);
	await lastPainting.click();
	await lastArtist.scrollIntoViewIfNeeded();
	await expect(lastArtist).toBeInViewport();
	await page.screenshot({ path: info.outputPath('backrooms-paintings-unpaged.png') });
	await heading.click();
	await expect(paintings).toHaveCount(0);
	await expect(lastArtist).toHaveCount(0);
	await page.screenshot({ path: info.outputPath('backrooms-paintings-collapsed.png') });
	const expandAll = page.getByRole('button', { name: 'Expand all', exact: true });
	await expandAll.click();
	await expect(paintings).toHaveCount(1447);
	const traits = page.locator('.token-detail-traits-wrap');
	await expect(traits.getByText('Artist', { exact: true })).toHaveCount(1447);
	await expect(traits.getByRole('textbox')).toHaveCount(0);
	await lastArtist.scrollIntoViewIfNeeded();
	await expect(lastArtist).toBeInViewport();
	await page.screenshot({ path: info.outputPath('backrooms-all-paintings-expanded.png') });
});
