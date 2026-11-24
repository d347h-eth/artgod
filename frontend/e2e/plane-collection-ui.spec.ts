import { join } from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { COLLECTION_MEDIA_MODES, COLLECTION_MEDIA_MODE_OPTIONS } from '@artgod/shared/extensions';
import {
	NFT111K_EXTENSION_KEY,
	NFT111K_METADATA as META,
	NFT111K_STRUCTURED_BLOCK,
	nft111kTraitCatalog as mapper
} from '@artgod/shared/extensions/111k';
import { TRAIT_FILTER_DISPLAY_KIND } from '@artgod/shared/types';
import { TRAIT_CATALOG_QUERY, type CollectionViewStatus } from '@artgod/shared/types/trait-catalog';
import {
	buildBiddingE2eCollectionDetailData,
	buildBiddingE2eTokenDetailData
} from '../src/lib/e2e/bidding-automation-fixtures';
import { TEST_IDS } from '../src/lib/test-ids';
import { installBiddingAutomationApiMock } from './helpers/bidding-automation-api';

const PLANE = NFT111K_STRUCTURED_BLOCK.Plane;
const FILM = 'film clips';
const CHAOS = 'Chaos';
const MARK_CHAOS = 'Paint mark chaos';
const MARK_COUNT = 'Paint mark count';
const media = {
	selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
	defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
	availableModes: [COLLECTION_MEDIA_MODE_OPTIONS.Snapshot],
	preference: null
};

function artwork(block: string) {
	return [
		{ key: META.Type, value: 'painting' },
		{ key: META.CollectionBlock, value: block }
	];
}

function viewFor(pairs: { key: string; value: string }[], size: number): CollectionViewStatus {
	const view = mapper.classify(pairs);
	const version = mapper.availableVersion(view);
	return {
		...view,
		generation: 1,
		activeMapperVersion: version,
		availableMapperVersion: version,
		classified: size,
		ready: size,
		structure: mapper.structure?.(view, version)
	};
}

const plane = viewFor(artwork(PLANE), 2);
const film = viewFor(artwork(FILM), 1);
const typedViews = [META.Egg, 'crate', 'warehouse', 'relic'].map((value) =>
	viewFor([{ key: META.Type, value }], 1)
);
const tokens = [
	{
		id: '585',
		facts: [
			...artwork(PLANE),
			{ key: CHAOS, value: 'Calm' },
			{
				key: 'Character 1 - Little Swag World',
				value: 'cloth poncho batch 50 - 05 / 14 - Cloth Variant'
			}
		]
	},
	{
		id: '1880',
		facts: [
			...artwork(PLANE),
			{ key: CHAOS, value: 'Airy' },
			{ key: MARK_CHAOS, value: 'Airy' },
			{ key: MARK_COUNT, value: '7' },
			{ key: 'Character 1', value: 'Regular Constant fella' },
			{ key: 'Character 1 - Regular Constant fella / 3base', value: 'drifella' },
			{ key: 'Character 1 - Regular Constant fella / 4shirt', value: 'die dritte generation' },
			{ key: 'Character 1 - Regular Constant fella / 8eyes', value: 'nutmugs t' },
			{ key: 'Character 2', value: 'Constant fella' }
		]
	}
].map(({ id, facts }) => ({
	id,
	image: '/e2e-artwork/' + id,
	projected: mapper.project(plane, plane.activeMapperVersion, facts)
}));

async function installPlaneFixture(page: Page) {
	const sample = buildBiddingE2eCollectionDetailData(new URLSearchParams());
	const collection = {
		...sample.collection,
		slug: NFT111K_EXTENSION_KEY + '-ui-fixture',
		extensions: [{ key: NFT111K_EXTENSION_KEY }],
		activityEventFeeds: []
	};
	const path = '/' + sample.chain.slug + '/' + collection.slug;
	const apiPath = '/api' + path;
	const requests: string[] = [];
	await page.route('**/api/**', (route) =>
		route.fulfill({ status: 404, json: { message: 'Unexpected fixture request' } })
	);
	await installBiddingAutomationApiMock(page);
	await page.route('**/api/runtime/config', (route) =>
		route.fulfill({ json: { bidding: { trustOpenSeaSignedZoneTraitOffers: true } } })
	);
	await page.route('**/e2e-artwork/*', (route) => {
		const id = new URL(route.request().url()).pathname.split('/').pop()!;
		const dir = process.env.ARTGOD_E2E_PLANE_MEDIA_DIR;
		if (dir) return route.fulfill({ path: join(dir, id + '.webp'), contentType: 'image/webp' });
		// Two distinct stand-ins keep the normal suite offline. An explicit media directory provides real artwork for visual review.
		const fill = id === tokens[0].id ? 'darkslateblue' : 'cadetblue';
		return route.fulfill({
			contentType: 'image/svg+xml',
			body:
				'<svg xmlns="http://www.w3.org/2000/svg" width="500" height="540"><rect width="500" height="540" fill="' +
				fill +
				'"/><circle cx="250" cy="270" r="100" fill="ivory"/></svg>'
		});
	});
	await page.route('**/collection-views*', (route) =>
		route.fulfill({
			json: {
				chain: sample.chain,
				collection,
				required: true,
				selectedViewId: new URL(route.request().url()).searchParams.get(TRAIT_CATALOG_QUERY.View),
				views: [film, plane, ...typedViews]
			}
		})
	);
	await page.route(
		(url) => url.pathname === apiPath,
		(route) => {
			const params = new URL(route.request().url()).searchParams;
			const view = params.get(TRAIT_CATALOG_QUERY.View) ?? '';
			requests.push(view);
			const { selectedTraits } = buildBiddingE2eCollectionDetailData(params);
			const items = (view === plane.id ? tokens : [])
				.filter(({ projected }) =>
					selectedTraits.every((pair) =>
						projected.values.some(
							(field) => field.fieldId === pair.key && field.value === pair.value
						)
					)
				)
				.map(({ id, image, projected }) => ({
					...sample.tokens.items[0],
					tokenId: id,
					name: '#' + id,
					image,
					traitSummary: null,
					attributes: projected.values.map(({ fieldId, value }) => ({ key: fieldId, value }))
				}));
			const facets = [CHAOS, MARK_CHAOS, MARK_COUNT].map((key) => ({
				key,
				nativeKey: key,
				values: tokens.flatMap(({ projected }) =>
					projected.values
						.filter((field) => field.fieldId === key)
						.map(({ native, value }) => ({
							native,
							value,
							tokenCount: 1,
							marketplaceBiddingSupported: true
						}))
				),
				displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
				minValue: null,
				maxValue: null
			}));
			return route.fulfill({
				json: {
					chain: sample.chain,
					collection,
					media,
					tokens: {
						...sample.tokens,
						items,
						totalItems: items.length,
						marketplaceBiddingSupportedTotalItems: items.length,
						rangeStart: items.length ? 1 : 0,
						rangeEnd: items.length,
						prevCursor: null,
						nextCursor: null,
						totalPages: items.length ? 1 : 0
					},
					traits: {
						selected: selectedTraits,
						selectedRanges: [],
						facets: view === plane.id ? facets : []
					}
				}
			});
		}
	);
	const token = tokens[1];
	await page.route(
		(url) => url.pathname === apiPath + '/' + token.id,
		(route) => {
			const params = new URL(route.request().url()).searchParams;
			expect(params.get(TRAIT_CATALOG_QUERY.View)).toBe(plane.id);
			const detail = buildBiddingE2eTokenDetailData(token.id, params);
			return route.fulfill({
				json: {
					...detail,
					collection,
					media: { ...media, selectedVariant: null, defaultVariant: null, availableVariants: [] },
					token: {
						...detail.token,
						tokenId: token.id,
						name: '#' + token.id,
						image: token.image,
						traitTree: token.projected.tree,
						attributes: token.projected.values.map(({ fieldId, value, native }) => ({
							key: fieldId,
							value,
							native,
							marketplaceBiddingSupported: true,
							tokenCount: 1,
							rarityPercent: 50
						}))
					}
				}
			});
		}
	);
	return { path, requests };
}

test('keeps collection navigation and artwork filters usable through block, kind and token changes', async ({
	page
}, info) => {
	const { path, requests } = await installPlaneFixture(page);
	const kind = page.getByRole('group', { name: 'Token kind' });
	const block = page.getByRole('combobox', { name: 'Collection block' });
	const cards = page.getByTestId(TEST_IDS.TokenCard);
	const shots = (name: string) => page.screenshot({ path: info.outputPath(name + '.png') });
	const offers = page.getByRole('link', { name: 'offers', exact: true });
	async function checkChrome() {
		await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('111k');
		await expect(offers).toBeVisible();
		await expect(page.getByRole('textbox', { name: /Jump to token/ })).toBeVisible();
		await expect(page.getByRole('button', { name: 'keyboard shortcuts' })).toBeVisible();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
			)
		).toBe(true);
	}
	// Start with a hydrated, isolated client. Real collection links then go through SvelteKit's production loaders.
	await page.goto('/e2e-harness/collection');
	await expect(page.locator('html')).toHaveAttribute('data-artgod-hydrated', '1');
	await page.evaluate((href) => {
		const link = document.createElement('a');
		link.href = href;
		document.body.append(link);
		link.click();
		link.remove();
	}, path);
	await expect(kind).toBeVisible();
	await checkChrome();
	const origin = await offers.boundingBox();
	await shots('01-collection-kinds');
	await kind.getByRole('link', { name: 'Artworks' }).click();
	await expect(block).toHaveValue('');
	await checkChrome();
	expect(await offers.boundingBox()).toEqual(origin);
	await expect(cards).toHaveCount(0);
	expect(requests).toEqual([]);
	await shots('02-artworks-blocks');

	await block.focus();
	await block.press('f');
	await expect(page.getByText('0 listed', { exact: true })).toBeVisible();
	await expect(block).toHaveValue(film.id);
	await expect(block).toBeFocused();
	await expect(page.getByText(/^collection block\s*=\s*film clips$/i)).toHaveCount(0);
	await checkChrome();
	expect(await offers.boundingBox()).toEqual(origin);
	await shots('03-film-clips');

	await block.selectOption({ label: PLANE });
	await expect(cards).toHaveCount(2);
	await expect(page.getByText(/^collection block\s*=\s*plane of existence$/i)).toHaveCount(0);
	await checkChrome();
	await expect
		.poll(() =>
			cards
				.locator('img')
				.evaluateAll((images) =>
					images.every((image) => (image as HTMLImageElement).naturalWidth > 1)
				)
		)
		.toBe(true);
	await shots('04-plane-gallery');
	await page.getByRole('button', { name: 'expand traits panel' }).click();
	const chaos = page.locator('summary').getByText(CHAOS, { exact: true });
	const reference = page.getByText('Token detail fields', { exact: true });
	await expect(chaos).toBeVisible();
	await expect(reference).toBeVisible();
	await expect(page.getByText('Mini drif', { exact: true })).toBeHidden();

	await shots('04-plane-facets');
	await reference.click();
	await expect(page.getByText('Mini drif', { exact: true })).toBeVisible();
	await shots('05-token-field-reference');
	const rootSearch = page.getByRole('searchbox', { name: 'search all traits' });
	await rootSearch.fill('Calm');
	await block.selectOption({ label: FILM });
	await expect(page.getByText('0 listed', { exact: true })).toBeVisible();
	await block.selectOption({ label: PLANE });
	await expect(cards).toHaveCount(2);
	await expect(rootSearch).toHaveValue('');
	await expect(page.getByText('Mini drif', { exact: true })).toBeHidden();
	await chaos.click();
	await page.getByRole('checkbox', { name: /Airy/ }).check();
	await expect(cards).toHaveCount(1);
	await expect(cards.getByRole('link', { name: '1880', exact: true })).toBeVisible();
	await checkChrome();
	await shots('06-filtered-plane');

	await kind.getByRole('link', { name: 'Eggs' }).click();
	await expect(kind.locator('[aria-current="true"]')).toHaveText('Eggs');
	await expect(block).toHaveCount(0);
	await expect(cards).toHaveCount(0);
	await checkChrome();
	await shots('07-eggs');
	await page.goBack();
	await expect(block).toHaveValue(plane.id);
	await expect(cards).toHaveCount(1);
	await cards.getByRole('link', { name: '1880', exact: true }).click();
	await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('#1880');
	await checkChrome();
	await shots('08-token-detail');
	await page.getByText('Characters', { exact: true }).click();
	await page.getByText('Regular Constant fella', { exact: true }).click();
	await expect(page.getByText('die dritte generation', { exact: true })).toBeVisible();
	await expect(page.getByText('nutmugs t', { exact: true })).toBeVisible();
	await page.getByText('die dritte generation', { exact: true }).scrollIntoViewIfNeeded();
	await shots('09-character-fields');
	expect(requests).not.toContain('');
});
