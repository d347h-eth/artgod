import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from 'playwright/test';
import { COLLECTION_MEDIA_MODES, COLLECTION_MEDIA_MODE_OPTIONS } from '@artgod/shared/extensions';
import {
	NFT111K_EXTENSION_KEY,
	NFT111K_METADATA as META,
	NFT111K_STRUCTURED_BLOCK,
	nft111kTraitCatalog as mapper
} from '@artgod/shared/extensions/111k';
import {
	COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER,
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
	COLLECTION_BIDDING_BID_SCOPE_FILTER,
	TRAIT_FILTER_DISPLAY_KIND,
	TRAIT_FILTER_QUERY_PARAMS,
	TRADING_BIDDING_BID_SCOPE_KIND,
	TRADING_BIDDING_BID_BOOK_PRICE_KIND,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	formatTradingBiddingBidScopeLabel
} from '@artgod/shared/types';
import { biddingTraitScopeMatchesFilters } from '@artgod/shared/trading/offer-trait-criteria';
import { parseEther } from 'viem';
import type { ApiBiddingMarketBidBookRow, TokenPreviewApiResponse } from '../src/lib/api-types';
import {
	BID_SCOPE_QUERY_PARAM,
	parseCollectionBiddingTraitFilterJoinMode
} from '../src/lib/bidding-query';
import { parseSelectedTraits } from '../src/lib/trait-filters';
import { BID_BOOK_FILTER_LABEL } from '../src/lib/bid-book-view-models';
import { PRICE_HISTORY_QUERY } from '@artgod/shared/http/collection-routes';
import {
	TRAIT_CATALOG_QUERY,
	VIEW_OFFER_APPLICABILITY,
	type CollectionViewStatus
} from '@artgod/shared/types/trait-catalog';
import { buildTokenDetailHref } from '../src/lib/token-browser-query';
import { MEDIA_MODE_QUERY_PARAM } from '../src/lib/media-mode';
import { selectCollectionViewHref } from '../src/lib/collection-view';
import { COLLECTION_CUSTOMIZATION_SECTION } from '../src/lib/customization-query';
import { COLLECTION_PAGE_TOP_ACTIONS_DOM } from '../src/lib/components/collection-page-layout-dom';
import {
	buildBiddingE2eCollectionBiddingData,
	buildBiddingE2eCollectionDetailData,
	buildBiddingE2eTokenDetailData
} from '../src/lib/e2e/bidding-automation-fixtures';
import { TEST_IDS } from '../src/lib/test-ids';
import { installBiddingAutomationApiMock } from './helpers/bidding-automation-api';

const PLANE = NFT111K_STRUCTURED_BLOCK.Plane;
const FILM = 'film clips';
const FILM_TOKEN = '31815';
const FILM_ARTIST = 'evil biscuit';
const CHAOS = 'Chaos';
const MARK_CHAOS = 'Paint mark chaos';
const MARK_COUNT = 'Paint mark count';
const DETAIL_TOKEN = '34273';
const BACKGROUND_FILE = '00248_seed1074358483_psi1.8357.png';
const COVERAGE_FIELD = 'Paint GAN box face 1 / coverage';
const media = {
	selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
	defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
	availableModes: [COLLECTION_MEDIA_MODE_OPTIONS.Snapshot],
	preference: null
};

function artwork(block: string, type = 'painting') {
	return [
		{ key: META.Type, value: type },
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
		ready: size
	};
}

const plane = viewFor(artwork(PLANE), 2);
const film = viewFor(artwork(FILM, 'video'), 1);
const drimi = viewFor(artwork('DriMi'), 1);
const driluhh = viewFor(artwork('DRILUHH'), 1);
const backrooms = viewFor(artwork(NFT111K_STRUCTURED_BLOCK.Backrooms), 1);
const typedViews = ['crate', META.Egg, 'relic', 'warehouse'].map((value) =>
	viewFor([{ key: META.Type, value }], 1)
);
const publishedViews = [plane, drimi, film, backrooms, driluhh, ...typedViews];
const tokens = [
	{
		id: '585',
		facts: [
			...artwork(PLANE),
			{ key: CHAOS, value: 'Calm' },
			{ key: MARK_CHAOS, value: 'airy' },
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
	},
	{
		id: FILM_TOKEN,
		facts: [...artwork(FILM, 'video'), { key: 'artist', value: FILM_ARTIST }]
	},
	{ id: '490', facts: [{ key: META.Type, value: 'crate' }] }
].map(projectToken);

function projectToken({ id, facts }: { id: string; facts: { key: string; value: string }[] }) {
	const view = mapper.classify(facts);
	return {
		id,
		view,
		image: '/e2e-artwork/' + id,
		projected: mapper.project(view, mapper.availableVersion(view), facts)
	};
}

function previewResponse(token: (typeof tokens)[number]): TokenPreviewApiResponse {
	const view = publishedViews.find((view) => view.id === token.view.id)!;
	return {
		media: { ...media, selectedVariant: null, defaultVariant: null, availableVariants: [] },
		token: {
			tokenId: token.id,
			image: token.image,
			animationUrl: null,
			catalogScope: { id: view.id, generation: view.generation },
			attributes: token.projected.values.map(({ fieldId: key, value }) => ({ key, value })),
			traitSummary: null
		}
	};
}

function detailToken() {
	const dir = process.env.ARTGOD_E2E_PLANE_MEDIA_DIR;
	const snapshot = dir && join(dir, DETAIL_TOKEN + '.json');
	const facts =
		snapshot && existsSync(snapshot)
			? JSON.parse(readFileSync(snapshot, 'utf8'))
			: [
					...artwork(PLANE),
					{ key: 'Background bottom', value: BACKGROUND_FILE },
					{ key: 'Background top', value: '01170_seed2834625333_psi0.9065.png' },
					{ key: 'Chain connected objects', value: '34' },
					{ key: 'Chain network', value: 'extending chain' },
					{ key: 'Chain shape', value: 'Slack' },
					{ key: 'Chain shape', value: 'Taut' },
					{ key: 'Paint GAN box face 1', value: '00614_seed1519198600_psi1.2260' },
					{ key: COVERAGE_FIELD, value: 'Full box wrap' },
					{ key: 'Paint GAN box face 1 / panel', value: 'front' },
					{ key: 'Character 1', value: 'Drifella II' },
					{ key: 'Character 1 - Drifella II / 3drifellabody', value: 'sketch2' },
					{ key: 'architecture 1', value: 'SR-71 Blackbird' },
					{ key: CHAOS, value: 'Dense' }
				];
	return projectToken({ id: DETAIL_TOKEN, facts });
}

function setFacet(key: string, values: [string, number][]) {
	return {
		key,
		nativeKey: key,
		displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
		minValue: null,
		maxValue: null,
		values: values.map(([value, tokenCount]) => ({
			native: { key, value },
			value,
			tokenCount,
			marketplaceBiddingSupported: true
		}))
	};
}

function aggregateFacets(members: typeof tokens) {
	return [META.Type, META.CollectionBlock].map((key) => {
		const counts = new Map<string, number>();
		for (const { projected } of members) {
			for (const { native } of projected.values) {
				if (native?.key === key) counts.set(native.value, (counts.get(native.value) ?? 0) + 1);
			}
		}
		return setFacet(key, [...counts]);
	});
}

const facetsByView = new Map([
	[
		plane.id,
		[
			setFacet(CHAOS, [
				['Calm', 1],
				['Airy', 1]
			]),
			setFacet(MARK_CHAOS, [
				['Airy', 1],
				['airy', 1]
			]),
			setFacet(
				MARK_COUNT,
				Array.from({ length: 167 }, (_, i) => [String(i + 1), 1])
			),
			setFacet(META.CollectionBlock, [[PLANE, 2]]),
			setFacet(META.Type, [['painting', 2]])
		]
	],
	[
		film.id,
		[
			setFacet('artist', [[FILM_ARTIST, 1]]),
			setFacet(META.CollectionBlock, [[FILM, 1]]),
			setFacet(META.Type, [['video', 1]])
		]
	]
]);

async function installPlaneFixture(
	page: Page,
	collectionBidBookFixture?: typeof buildBiddingE2eCollectionBiddingData
) {
	const detailTokens = [...tokens, detailToken()];
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
	await installBiddingAutomationApiMock(page, {
		bidBookCollection: collection,
		collectionBidBookFixture
	});
	await page.route('**/api/runtime/config', (route) =>
		route.fulfill({ json: { bidding: { trustOpenSeaSignedZoneTraitOffers: true } } })
	);
	await page.route('**/e2e-artwork/*', (route) => {
		const id = new URL(route.request().url()).pathname.split('/').pop()!;
		const dir = process.env.ARTGOD_E2E_PLANE_MEDIA_DIR;
		const file = dir && join(dir, id + '.webp');
		if (file && existsSync(file)) {
			return route.fulfill({ path: file, contentType: 'image/webp' });
		}
		// Keep ordinary runs offline and preserve the film still's landscape aspect ratio.
		if (id === FILM_TOKEN) {
			return route.fulfill({
				contentType: 'image/svg+xml',
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="midnightblue"/></svg>'
			});
		}
		const fill = id === tokens[0].id ? 'darkslateblue' : 'cadetblue';
		return route.fulfill({
			contentType: 'image/svg+xml',
			body:
				'<svg xmlns="http://www.w3.org/2000/svg" width="500" height="540"><rect width="500" height="540" fill="' +
				fill +
				'"/><circle cx="250" cy="270" r="100" fill="ivory"/></svg>'
		});
	});
	await page.route('**/collection-views*', (route) => {
		const params = new URL(route.request().url()).searchParams;
		const tokenId = params.get(PRICE_HISTORY_QUERY.TokenId);
		const viewId = params.get(TRAIT_CATALOG_QUERY.View);
		const groupId = params.get(TRAIT_CATALOG_QUERY.Group);
		const token = detailTokens.find((entry) => entry.id === tokenId);
		if (tokenId && !token) return route.fulfill({ status: 404 });
		if (token && viewId && viewId !== token.view.id) {
			return route.fulfill({ status: 400, json: { message: 'Token belongs to a different view' } });
		}
		return route.fulfill({
			json: {
				chain: sample.chain,
				collection,
				required: true,
				selectedViewId: token?.view.id ?? viewId,
				...(!token && groupId && { selectedGroupId: groupId }),
				views: publishedViews
			}
		});
	});
	await page.route(
		(url) => url.pathname === apiPath,
		(route) => {
			const params = new URL(route.request().url()).searchParams;
			const view = params.get(TRAIT_CATALOG_QUERY.View) ?? '';
			const group = params.get(TRAIT_CATALOG_QUERY.Group);
			requests.push(group ?? view);
			const { selectedTraits } = buildBiddingE2eCollectionDetailData(params);
			const scopedTokens = tokens.filter((token) =>
				view ? token.view.id === view : !group || token.view.parent?.id === group
			);
			const items = scopedTokens
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
						facets: view ? (facetsByView.get(view) ?? []) : aggregateFacets(scopedTokens)
					}
				}
			});
		}
	);
	for (const token of detailTokens) {
		await page.route(
			(url) => url.pathname === apiPath + '/' + token.id + '/preview',
			(route) => route.fulfill({ json: previewResponse(token) })
		);
		await page.route(
			(url) => url.pathname === apiPath + '/' + token.id,
			(route) => {
				const params = new URL(route.request().url()).searchParams;
				expect(params.get(TRAIT_CATALOG_QUERY.View)).toBe(token.view.id);
				const detail = buildBiddingE2eTokenDetailData(token.id, params);
				return route.fulfill({
					json: {
						...detail,
						collection,
						media: { ...media, selectedVariant: null, defaultVariant: null, availableVariants: [] },
						token: {
							...detail.token,
							tokenId: token.id,
							name:
								token.id === FILM_TOKEN || token.id === DETAIL_TOKEN ? token.id : '#' + token.id,
							...(token.id === FILM_TOKEN && { listingPrice: '89000000000000000' }),
							...(token.id === DETAIL_TOKEN && {
								listingPrice: '1500000000000000',
								currentHolder: '0x11ebaa109a0a0388f82c5bdea6fafc0ec78cb4d1'
							}),
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
	}
	return { path, requests, chain: sample.chain, collection };
}

// Enter through the hydrated client so all API traffic uses the isolated browser fixture.
async function enter(page: Page, path: string) {
	await page.goto('/e2e-harness/collection');
	await expect(page.locator('html')).toHaveAttribute('data-artgod-hydrated', '1');
	await page.evaluate((href) => {
		const link = document.createElement('a');
		link.href = href;
		document.body.append(link);
		link.click();
		link.remove();
	}, path);
}

async function openPlaneTraits(page: Page) {
	const { path } = await installPlaneFixture(page);
	await enter(page, selectCollectionViewHref(path, new URLSearchParams(), plane));
	await page.getByRole('button', { name: 'expand traits panel' }).click();
	return page
		.getByRole('complementary')
		.filter({ has: page.getByRole('heading', { name: 'traits' }) });
}

test('trait sidebar selects the exact value from its label, checkbox and keyboard', async ({
	page
}, info) => {
	const sidebar = await openPlaneTraits(page);
	const bucket = sidebar
		.locator('details')
		.filter({ has: page.locator('summary').getByText(MARK_CHAOS, { exact: true }) });
	await bucket.locator('summary').click();
	const lower = bucket.getByRole('checkbox', { name: /^airy\s+1$/ });
	const upper = bucket.getByRole('checkbox', { name: /^Airy\s+1$/ });
	const cards = page.getByTestId(TEST_IDS.TokenCard);

	async function expectSelection(value: string, token: string) {
		await expect
			.poll(() => new URL(page.url()).searchParams.getAll(TRAIT_FILTER_QUERY_PARAMS.Traits))
			.toEqual([MARK_CHAOS + ':' + value]);
		await expect(cards).toHaveCount(1);
		await expect(cards.getByRole('link', { name: token, exact: true })).toBeVisible();
	}

	await bucket.getByText('airy', { exact: true }).click();
	await expect(lower).toBeChecked();
	await expect(upper).not.toBeChecked();
	await expectSelection('airy', '585');
	await bucket.getByText('Airy', { exact: true }).click({ modifiers: ['Control'] });
	await expectSelection('Airy', '1880');
	await expect(upper).toBeChecked();
	await expect(lower).not.toBeChecked();
	await page.screenshot({ path: info.outputPath('trait-label-selected.png'), scale: 'css' });

	await upper.press('Space');
	await expect(upper).not.toBeChecked();
	await expect(cards).toHaveCount(2);
	await lower.click();
	await expectSelection('airy', '585');
	await upper.click({ modifiers: ['Control'] });
	await expectSelection('Airy', '1880');
	await expect(upper).toBeChecked();
	await upper.click({ modifiers: ['Control'] });
	await expect(upper).toBeChecked();
	await lower.click({ modifiers: ['Control'] });
	await expectSelection('airy', '585');
	await expect(lower).toBeChecked();
	await bucket.getByText('airy', { exact: true }).click();
	await expect(lower).not.toBeChecked();
	await expect(cards).toHaveCount(2);
});

test('trait sidebar clears only the chosen search and returns focus to it', async ({
	page
}, info) => {
	const sidebar = await openPlaneTraits(page);
	const rootSearch = sidebar.getByRole('searchbox', { name: 'search all traits' });
	const clearRoot = sidebar.getByRole('button', { name: 'clear trait search' });
	const chaosSearch = sidebar.getByRole('searchbox', { name: 'search ' + CHAOS + ' values' });
	const clearChaos = sidebar.getByRole('button', { name: 'clear ' + CHAOS + ' search' });
	const markSearch = sidebar.getByRole('searchbox', { name: 'search ' + MARK_CHAOS + ' values' });
	const clearMark = sidebar.getByRole('button', { name: 'clear ' + MARK_CHAOS + ' search' });
	await sidebar.locator('summary').getByText(CHAOS, { exact: true }).click();
	await sidebar.getByText('Calm', { exact: true }).click();
	const selected = sidebar.getByRole('checkbox', { name: /^Calm\s+1$/ });
	await expect(selected).toBeChecked();
	await sidebar.locator('summary').getByText(MARK_CHAOS, { exact: true }).click();
	await expect(clearRoot).toHaveCount(0);
	await expect(clearChaos).toHaveCount(0);
	await expect(clearMark).toHaveCount(0);

	await chaosSearch.fill('c');
	await markSearch.fill('Air');
	await rootSearch.fill('a');
	await expect(clearRoot).toBeVisible();
	await expect(clearChaos).toBeVisible();
	await expect(clearMark).toBeVisible();
	await page.screenshot({ path: info.outputPath('trait-search-clear.png'), scale: 'css' });

	await clearChaos.press('Enter');
	await expect(chaosSearch).toBeFocused();
	await expect(chaosSearch).toHaveValue('');
	await expect(clearChaos).toHaveCount(0);
	await expect(rootSearch).toHaveValue('a');
	await expect(markSearch).toHaveValue('Air');
	await expect(selected).toBeChecked();

	await rootSearch.fill('nonexistent');
	await expect(sidebar.getByText('no matches', { exact: true })).toBeVisible();
	await clearRoot.click();
	await expect(rootSearch).toBeFocused();
	await expect(rootSearch).toHaveValue('');
	await expect(clearRoot).toHaveCount(0);
	await expect(selected).toBeChecked();
	await expect(markSearch).toHaveValue('Air');
	await clearMark.click();
	await expect(markSearch).toBeFocused();
	await expect(markSearch).toHaveValue('');
	await expect(clearMark).toHaveCount(0);
	await expect(selected).toBeChecked();
});

test('trait sidebar scrolls its full list and a shorter search result before the page moves', async ({
	page
}, info) => {
	const sidebar = await openPlaneTraits(page);
	const bucket = sidebar
		.locator('details')
		.filter({ has: page.locator('summary').getByText(MARK_COUNT, { exact: true }) });
	await bucket.locator('summary').click();
	const last = bucket.getByRole('checkbox').last();

	async function wheelToEnd() {
		const box = (await sidebar.boundingBox())!;
		expect(await page.evaluate(() => window.scrollY)).toBe(0);
		await page.mouse.move(box.x + 10, box.y + 10);
		await page.mouse.wheel(0, 10000);
		await expect.poll(() => sidebar.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
		await expect
			.poll(() => sidebar.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
			.toBeLessThanOrEqual(1);
		await expect(last).toBeInViewport({ ratio: 1 });
		await page.mouse.wheel(0, 180);
		await page.evaluate(
			() =>
				new Promise<void>((done) => {
					requestAnimationFrame(() => requestAnimationFrame(() => done()));
				})
		);
		expect(await page.evaluate(() => window.scrollY)).toBe(0);
	}

	await expect(bucket.getByRole('checkbox')).toHaveCount(167);
	await wheelToEnd();
	await page.screenshot({ path: info.outputPath('trait-sidebar-scrolled.png'), scale: 'css' });
	await page.mouse.wheel(0, -10000);
	await expect.poll(() => sidebar.evaluate((el) => el.scrollTop)).toBe(0);

	// The shorter list fits a full viewport, but cannot fit below the collection controls.
	await bucket.getByRole('searchbox').fill('11');
	await expect(bucket.getByRole('checkbox')).toHaveCount(11);
	const contentHeight = await sidebar.evaluate((el) => el.scrollHeight);
	await page.setViewportSize({ width: page.viewportSize()!.width, height: contentHeight + 48 });
	await expect
		.poll(() => sidebar.evaluate((el) => el.scrollHeight - el.clientHeight))
		.toBeGreaterThan(0);
	await wheelToEnd();

	// A wheel gesture over the collection chrome still scrolls the results page.
	await page.mouse.move(4, 4);
	await page.mouse.wheel(0, 240);
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('keeps collection navigation and artwork filters usable through block, kind and token changes', async ({
	page,
	isMobile
}, info) => {
	const { path, requests } = await installPlaneFixture(page);
	const kind = page.getByRole('group', { name: 'Token kind' });
	const block = page.getByRole('combobox', { name: 'Collection block' });
	const cards = page.getByTestId(TEST_IDS.TokenCard);
	const shots = (name: string) => page.screenshot({ path: info.outputPath(name + '.png') });
	const offers = page.getByRole('link', { name: 'offers', exact: true });
	async function waitForGallery() {
		await expect
			.poll(() =>
				cards
					.locator('img')
					.evaluateAll(
						(images) =>
							images.length > 0 &&
							images.every((image) => (image as HTMLImageElement).naturalWidth > 1)
					)
			)
			.toBe(true);
	}
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
	async function checkTokenDetail(tokenId: string, blockName: string) {
		const heading = page.getByRole('heading', {
			level: 1,
			name: new RegExp('^#?' + tokenId + '$')
		});
		await expect(heading).toBeVisible();
		const frame = page.getByTitle('token ' + tokenId, { exact: true });
		await expect(frame).toBeVisible();
		await expect
			.poll(() =>
				frame
					.contentFrame()
					.locator('img')
					.evaluate((img: HTMLImageElement) => img.naturalWidth)
			)
			.toBeGreaterThan(1);
		await page.evaluate(() => window.scrollTo(0, 0));
		await expect(frame).toBeInViewport();
		await expect(kind).toHaveCount(0);
		await expect(page.getByRole('combobox', { name: 'Token kind' })).toHaveCount(0);
		await expect(block).toHaveCount(0);
		await expect(
			page.getByText(META.CollectionBlock + ' = ' + blockName, { exact: true })
		).toHaveCount(0);
		await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
		await expect(offers).toHaveCount(0);
		return heading;
	}
	await enter(page, path);
	await expect(kind).toBeVisible();
	await expect(kind.locator('[aria-current="true"]')).toHaveText('All');
	await expect(cards).toHaveCount(tokens.length);
	await expect(cards.getByRole('link', { name: '490', exact: true })).toBeVisible();
	await expect(kind.locator(':scope > *').first()).toHaveText('All');
	await checkChrome();
	const origin = await offers.boundingBox();
	await waitForGallery();
	await shots('01-collection-kinds');
	await kind.getByRole('link', { name: 'Artworks' }).click();
	await expect(block).toHaveValue('');
	await expect(block.getByRole('option')).toHaveText([
		'All blocks',
		backrooms.label,
		driluhh.label,
		drimi.label,
		film.label,
		plane.label
	]);
	const kindsBox = (await kind.boundingBox())!;
	const blockLabelBox = (await page.getByText('Block', { exact: true }).boundingBox())!;
	if (isMobile) {
		expect(blockLabelBox.y).toBeGreaterThan(kindsBox.y + kindsBox.height);
		expect(blockLabelBox.x).toBeCloseTo(kindsBox.x, 0);
	} else {
		expect(blockLabelBox.x - (kindsBox.x + kindsBox.width)).toBeGreaterThanOrEqual(16);
		expect(blockLabelBox.y).toBeLessThan(kindsBox.y + kindsBox.height);
	}
	await checkChrome();
	if (!isMobile) expect(await offers.boundingBox()).toEqual(origin);
	await expect(cards).toHaveCount(3);
	await expect(cards.getByRole('link', { name: '490', exact: true })).toHaveCount(0);
	await expect(page).toHaveURL(
		(url) => url.searchParams.get(TRAIT_CATALOG_QUERY.Group) === plane.parent!.id
	);
	await shots('02-artworks-blocks');
	await offers.click();
	await expect(page.getByLabel('Bid scope filter')).toBeVisible();
	await expect(block).toHaveValue('');
	await expect(page).toHaveURL(
		(url) => url.searchParams.get(TRAIT_CATALOG_QUERY.Group) === plane.parent!.id
	);
	await page.getByRole('link', { name: 'asks', exact: true }).click();
	await expect(cards).toHaveCount(3);
	await expect(block).toHaveValue('');

	await block.focus();
	await block.press('f');
	await expect(page.getByText('1 listed', { exact: true })).toBeVisible();
	await expect(block).toHaveValue(film.id);
	await expect(block).toBeFocused();
	await expect(page.getByText(/^collection block\s*=\s*film clips$/i)).toHaveCount(0);
	await checkChrome();
	if (!isMobile) expect(await offers.boundingBox()).toEqual(origin);
	await shots('03-film-clips');
	await page.getByRole('button', { name: 'expand traits panel' }).click();
	await page.locator('summary').getByText('artist', { exact: true }).click();
	await page.getByRole('checkbox', { name: new RegExp(FILM_ARTIST) }).check();
	await cards.getByRole('link', { name: FILM_TOKEN, exact: true }).click();
	const filmTitle = await checkTokenDetail(FILM_TOKEN, FILM);
	await shots('03-film-token-media');
	await filmTitle.evaluate((heading) => heading.scrollIntoView({ block: 'center' }));
	await expect(page.getByRole('link', { name: '0.089 ETH [OS]', exact: true })).toBeVisible();
	await expect(page.getByText('current holder:', { exact: true })).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: FILM_ARTIST })).toBeVisible();
	await shots('03-film-token-identity');
	await page.getByRole('link', { name: 'back to collection' }).click();
	await expect(block).toHaveValue(film.id);
	await expect(page).toHaveURL((url) =>
		url.searchParams.getAll(TRAIT_FILTER_QUERY_PARAMS.Traits).includes('artist:' + FILM_ARTIST)
	);
	await page.getByRole('button', { name: 'collapse traits panel' }).click();

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
	const sidebar = page
		.getByRole('complementary')
		.filter({ has: page.getByRole('heading', { name: 'traits' }) });
	const buckets = sidebar.locator('summary');
	const chaos = buckets.getByText(CHAOS, { exact: true });
	await expect(buckets).toHaveCount(4);
	for (const key of [CHAOS, MARK_CHAOS, MARK_COUNT, META.Type]) {
		await expect(buckets.getByText(key, { exact: true })).toBeVisible();
	}
	for (const text of [
		'Token detail fields',
		'Mini drif',
		'Regular Constant fella',
		META.CollectionBlock
	]) {
		await expect(sidebar.getByText(text, { exact: true })).toHaveCount(0);
	}
	await shots('04-plane-facets');
	const rootSearch = sidebar.getByRole('searchbox', { name: 'search all traits' });
	await rootSearch.fill('Calm');
	await expect(buckets).toHaveCount(1);
	await expect(sidebar.getByRole('checkbox', { name: /Calm/ })).toBeVisible();
	await shots('05-searchable-values');
	await block.selectOption({ label: FILM });
	await expect(page.getByText('1 listed', { exact: true })).toBeVisible();
	await block.selectOption({ label: PLANE });
	await expect(cards).toHaveCount(2);
	await expect(rootSearch).toHaveValue('');
	await expect(buckets).toHaveCount(4);
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
	await checkTokenDetail('1880', PLANE);
	await shots('08-token-detail');
	await expect(page.getByText('Regular Constant fella', { exact: true })).toBeVisible();
	await page.getByText('Regular Constant fella', { exact: true }).click();
	await expect(page.getByText('die dritte generation', { exact: true })).toBeVisible();
	await expect(page.getByText('nutmugs t', { exact: true })).toBeVisible();
	await page.getByText('die dritte generation', { exact: true }).scrollIntoViewIfNeeded();
	await shots('09-character-fields');
	await page.goBack();
	await expect(block).toHaveValue(plane.id);
	await expect(page).toHaveURL((url) =>
		url.searchParams.getAll(TRAIT_FILTER_QUERY_PARAMS.Traits).includes(CHAOS + ':Airy')
	);
	await expect(cards).toHaveCount(1);
	await checkChrome();
	await page.getByRole('button', { name: 'remove Chaos=Airy' }).click();
	await expect(cards).toHaveCount(2);
	await expect(block).toHaveValue(plane.id);
	await expect(page).toHaveURL((url) => !url.searchParams.has(TRAIT_FILTER_QUERY_PARAMS.Traits));
	await block.selectOption({ label: 'All blocks' });
	await expect(cards).toHaveCount(3);
	await kind.getByRole('link', { name: 'All', exact: true }).click();
	await expect(cards).toHaveCount(tokens.length);
	expect(requests).toContain('');
	expect(requests).toContain(plane.parent!.id);
	await cards.getByRole('link', { name: FILM_TOKEN, exact: true }).click();
	await checkTokenDetail(FILM_TOKEN, FILM);
	await page.getByRole('link', { name: 'back to collection' }).click();
	await expect(kind.locator('[aria-current="true"]')).toHaveText('All');
	await expect(cards).toHaveCount(tokens.length);
	if (info.project.name === 'desktop-1267') {
		await page.setViewportSize({ width: 1172, height: 712 });
		await waitForGallery();
		await shots('collection-all-1172');
	}
});

test('shows native trait offer targets in All when the catalog has no matching filter', async ({
	page
}, info) => {
	const subBlock = { type: 'sub block', value: 'cruciswag' };
	const pose = { type: 'Pose', value: 'Curled sleeping' };
	const type = { type: META.Type, value: 'painting' };
	const sample = buildBiddingE2eCollectionBiddingData(
		new URLSearchParams({ [BID_SCOPE_QUERY_PARAM]: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits })
	).bidBook.bids.find(
		(bid): bid is ApiBiddingMarketBidBookRow =>
			bid.materialization.kind === TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid
	)!;
	const marketOffer = (
		index: number,
		maker: number,
		quantity: number,
		eth: string,
		traits: (typeof subBlock)[]
	) => {
		const scope = { ...sample.scope, encodedTokenIds: FILM_TOKEN + ',' + DETAIL_TOKEN, traits };
		const address = '0x' + String(maker).repeat(40);
		return {
			...sample,
			orderId: 'trait-offer-' + index,
			maker: { ...sample.maker, address, label: address },
			quantity: String(quantity),
			price: {
				kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact,
				wei: parseEther(eth).toString(),
				eth
			},
			scope: { ...scope, label: formatTradingBiddingBidScopeLabel(scope) }
		};
	};
	const offers = [
		marketOffer(1, 1, 2, '0.033', [subBlock]),
		marketOffer(2, 2, 1, '0.03', [subBlock]),
		marketOffer(3, 2, 2, '0.03', [subBlock]),
		marketOffer(4, 3, 5, '0.02', [subBlock]),
		marketOffer(5, 4, 3, '0.0069', [subBlock]),
		// Match the lower collection median so the fifth sub-block offer is visible.
		marketOffer(6, 4, 1, '0.013', [type, pose]),
		marketOffer(7, 3, 1, '0.012', [type, pose]),
		marketOffer(8, 2, 1, '0.011', [type, pose]),
		marketOffer(9, 1, 1, '0.010', [type, pose])
	];
	const { path } = await installPlaneFixture(page, (params) => {
		const data = buildBiddingE2eCollectionBiddingData(params);
		if (data.bidScope !== COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits) return data;
		const bids =
			data.ownershipFilter === COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own
				? []
				: offers.filter((bid) =>
						biddingTraitScopeMatchesFilters(
							bid.scope.traits,
							data.selectedTraits,
							data.selectedTraitRanges,
							data.traitJoinMode
						)
					);
		return {
			...data,
			facets: aggregateFacets(tokens),
			bidBook: {
				...data.bidBook,
				bids,
				state: { ...data.bidBook.state, rowCount: bids.length }
			}
		};
	});
	await enter(page, path);
	await expect(
		page.getByRole('group', { name: 'Token kind' }).locator('[aria-current]')
	).toHaveText('All');
	await page.getByRole('link', { name: 'offers', exact: true }).click();
	await page.getByLabel('Own bid filter').getByRole('link', { name: 'all bids' }).click();
	await page
		.getByLabel('Bid scope filter')
		.getByRole('link', { name: 'traits', exact: true })
		.click();

	const headings = page.locator('.bid-book-demand-group-row');
	const unmapped = headings.filter({ hasText: /sub block\s*=\s*cruciswag/ });
	const mixed = headings.filter({ hasText: /Pose\s*=\s*Curled sleeping/ });
	await expect(unmapped).toBeVisible();
	const summary = page.locator('.bid-book-demand-group-meta-row').filter({ hasText: '0.2767' });
	await expect(summary.locator('.runtime-v')).toHaveText(['0.2767', '5', '4']);
	await expect(mixed.getByRole('link', { name: type.value })).toBeVisible();
	await expect(mixed.getByRole('link', { name: pose.value })).toBeVisible();
	await expect(mixed.getByTestId(TEST_IDS.BidBookTraitBucketFilter)).toBeVisible();
	const buckets = page.getByRole('group', { name: BID_BOOK_FILTER_LABEL.Traits });
	await page.screenshot({ path: info.outputPath('all-trait-offers.png'), fullPage: true });
	await buckets.getByRole('button', { name: /sub block/i }).click();
	await expect(unmapped).toBeVisible();
	await expect(mixed).toHaveCount(0);
	await buckets.getByRole('button', { name: /All/i }).click();
	await unmapped.getByRole('link', { name: subBlock.value }).click();
	await expect
		.poll(() => parseSelectedTraits(new URL(page.url()).searchParams))
		.toEqual([{ key: subBlock.type, value: subBlock.value }]);
	await expect(unmapped).toBeVisible();
	await expect(mixed).toHaveCount(0);
	await page.getByRole('button', { name: 'remove sub block=cruciswag' }).click();
	await expect(mixed).toBeVisible();
	await mixed.getByTestId(TEST_IDS.BidBookTraitBucketFilter).click();
	await expect
		.poll(() => parseSelectedTraits(new URL(page.url()).searchParams))
		.toEqual([
			{ key: pose.type, value: pose.value },
			{ key: type.type, value: type.value }
		]);
	expect(parseCollectionBiddingTraitFilterJoinMode(new URL(page.url()).searchParams)).toBe(
		COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or
	);
	await expect(mixed).toBeVisible();
	await expect(unmapped).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'remove Pose=Curled sleeping' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'remove type=painting' })).toBeVisible();
	await page.screenshot({ path: info.outputPath('all-trait-offers-filtered.png'), fullPage: true });
});

test('marks only unresolved orders in a scoped trait offer bucket', async ({ page }, info) => {
	const query = new URLSearchParams({
		[BID_SCOPE_QUERY_PARAM]: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits
	});
	const base = buildBiddingE2eCollectionBiddingData(query).bidBook.bids.find(
		(bid): bid is ApiBiddingMarketBidBookRow =>
			!bid.maker.isOwn &&
			bid.materialization.kind === TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid
	)!;
	const offers = ['0.03', '0.025', '0.001'].map((eth, index) => {
		const scope = {
			...base.scope,
			traits: [{ type: CHAOS, value: 'Calm' }],
			encodedTokenIds: index === 0 ? tokens[0].id : '99999',
			viewApplicability:
				index === 0 ? VIEW_OFFER_APPLICABILITY.Matched : VIEW_OFFER_APPLICABILITY.Unresolved
		};
		return {
			...base,
			orderId: 'scoped-' + index,
			scope: { ...scope, label: formatTradingBiddingBidScopeLabel(scope) },
			price: {
				kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact,
				eth,
				wei: parseEther(eth).toString()
			}
		};
	});
	const { path } = await installPlaneFixture(page, (params) => {
		const data = buildBiddingE2eCollectionBiddingData(params);
		if (data.bidScope !== COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits) return data;
		const bids =
			data.ownershipFilter === COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own ? [] : offers;
		return {
			...data,
			bidBook: { ...data.bidBook, bids, state: { ...data.bidBook.state, rowCount: bids.length } }
		};
	});
	await enter(page, selectCollectionViewHref(path + '/bidding', query, plane));
	await page.getByLabel('Own bid filter').getByRole('link', { name: 'all bids' }).click();
	const heading = page.locator('.bid-book-demand-group-row');
	await expect(heading).toHaveCount(1);
	await expect(heading).toContainText(/Chaos\s*=\s*Calm/);
	const warning = 'View match unknown';
	const order = (index: number) =>
		page.locator(`tr:has([data-open-sea-order-hash="scoped-${index}"])`);
	await expect(heading).not.toContainText(warning);
	await expect(order(0)).toBeVisible();
	await expect(order(0)).not.toContainText(warning);
	await expect(order(1).getByText(warning, { exact: true })).toBeVisible();
	await expect(order(2)).toBeHidden();
	await expect(page.getByText(warning, { exact: true }).filter({ visible: true })).toHaveCount(1);
	await page.screenshot({ path: info.outputPath('scoped-offer-match.png'), fullPage: true });
});

test('separates the collection scope from Offers and Asks controls', async ({ page }, info) => {
	const { path } = await installPlaneFixture(page);
	await enter(page, path);
	const kind = page.getByRole('group', { name: 'Token kind' });
	const block = page.getByRole('combobox', { name: 'Collection block' });
	const actions = page.locator('.' + COLLECTION_PAGE_TOP_ACTIONS_DOM.classes.stack);
	const rows = actions.locator(':scope > .' + COLLECTION_PAGE_TOP_ACTIONS_DOM.classes.row);
	const sections = page
		.locator('.panel-header')
		.filter({ has: page.getByRole('link', { name: 'chart', exact: true }) });
	const picker = page.locator('.collection-view-picker');
	await kind.getByRole('link', { name: 'Artworks' }).click();
	await expect(block).toBeVisible();
	const sectionBox = (await sections.boundingBox())!;
	const scopeBox = (await picker.boundingBox())!;
	expect(sectionBox.y).toBeGreaterThanOrEqual(scopeBox.y + scopeBox.height);

	await block.selectOption({ label: driluhh.label });
	await expect(page).toHaveURL(
		(url) => url.searchParams.get(TRAIT_CATALOG_QUERY.View) === driluhh.id
	);
	const filter = page.getByRole('button', { name: 'expand traits panel' });
	await expect(filter).toBeVisible();
	const asksPickerBox = (await picker.boundingBox())!;
	const filterBox = (await filter.boundingBox())!;
	expect(filterBox.y - (asksPickerBox.y + asksPickerBox.height)).toBeGreaterThanOrEqual(16);
	await actions.screenshot({ path: info.outputPath('driluhh-asks-toolbar.png') });

	await page.getByRole('link', { name: 'offers', exact: true }).click();
	const maker = page.getByRole('textbox', { name: /Filter bids by maker address/ });
	const owner = page.getByLabel('Own bid filter');
	const scope = page.getByLabel('Bid scope filter');
	await expect(maker).toBeVisible();
	const allBids = owner.getByRole('link', { name: 'all bids' });
	await allBids.click();
	await scope.getByRole('link', { name: 'traits', exact: true }).click();
	await expect(owner.getByRole('button', { name: 'all bids' })).toBeDisabled();
	await expect(scope.getByRole('button', { name: 'traits', exact: true })).toBeDisabled();
	await expect(block).toHaveValue(driluhh.id);
	const pickerBox = (await picker.boundingBox())!;
	const makerRowBox = (await rows.filter({ has: maker }).boundingBox())!;
	const scopeRowBox = (await rows.filter({ has: scope }).boundingBox())!;
	const sectionGap = makerRowBox.y - (pickerBox.y + pickerBox.height);
	const controlGap = scopeRowBox.y - (makerRowBox.y + makerRowBox.height);
	expect(sectionGap).toBeGreaterThanOrEqual(16);
	expect(controlGap).toBeGreaterThan(0);
	expect(controlGap).toBeLessThan(sectionGap / 2);
	await actions.screenshot({ path: info.outputPath('driluhh-offers-toolbar.png') });
	await page.screenshot({ path: info.outputPath('driluhh-offers.png') });

	function restingBorder(field: Locator) {
		return field.evaluate((element) => {
			const css = getComputedStyle(element);
			return { color: css.borderColor, width: css.borderWidth };
		});
	}
	async function expectSingleBorder(field: Locator, width: string) {
		await expect(field).toHaveCSS('border-width', width);
		await expect(field).toHaveCSS('outline-style', 'none');
		await expect(field).toHaveCSS('box-shadow', 'none');
	}
	const restingBlock = await restingBorder(block);
	const restingMaker = await restingBorder(maker);
	await kind.getByRole('link').last().focus();
	await page.keyboard.press('Tab');
	await expect(block).toBeFocused();
	await expectSingleBorder(block, restingBlock.width);
	await expect(block).not.toHaveCSS('border-color', restingBlock.color);
	await actions.screenshot({ path: info.outputPath('driluhh-block-focused.png') });
	await page.keyboard.press('Tab');
	await expect(sections.locator(':focus')).toHaveCount(1);
	await maker.focus();
	await expect(maker).toBeFocused();
	await page.keyboard.type('maker.eth');
	await expect(maker).toHaveValue('maker.eth');
	await expectSingleBorder(maker, restingMaker.width);
	await actions.screenshot({ path: info.outputPath('driluhh-maker-focused.png') });
	await maker.fill('invalid maker');
	await maker.press('Enter');
	await expect(maker).toHaveAttribute('aria-invalid', 'true');
	await maker.focus();
	const invalidTextColor = await maker.evaluate((element) => getComputedStyle(element).color);
	await expect(maker).toHaveCSS('border-color', invalidTextColor);
	await expect(maker).not.toHaveCSS('border-color', restingMaker.color);
	await expectSingleBorder(maker, restingMaker.width);
	await block.focus();
	await expect(block).toBeFocused();
	await page.keyboard.press('f');
	await expect(block).toHaveValue(film.id);
	await expect(block).toBeFocused();
});

test('jumps across blocks and restores a bookmarked token in its current block', async ({
	page
}) => {
	const { path } = await installPlaneFixture(page);
	const filmHref = selectCollectionViewHref(path, new URLSearchParams(), film);
	await enter(page, filmHref);
	const block = page.getByRole('combobox', { name: 'Collection block' });
	await expect(block).toHaveValue(film.id);
	const jump = page.getByRole('textbox', { name: /Jump to token/ });
	await jump.fill('1880');
	await jump.press('Enter');
	const heading = page.getByRole('heading', { level: 1, name: '#1880', exact: true });
	await expect(heading).toBeVisible();
	await expect(page).toHaveURL(
		(url) => url.searchParams.get(TRAIT_CATALOG_QUERY.View) === plane.id
	);
	const back = page.getByRole('link', { name: 'back to collection' });
	const backHref = new URL((await back.getAttribute('href'))!, page.url());
	expect(backHref.pathname).toBe(path);
	expect(backHref.searchParams.get(TRAIT_CATALOG_QUERY.View)).toBe(plane.id);
	await page.goBack();
	await expect(block).toHaveValue(film.id);
	const returnQuery = filmHref.split('?')[1];
	await enter(
		page,
		buildTokenDetailHref({
			basePath: path,
			tokenId: '1880',
			catalogScope: film,
			mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			returnPath: path,
			returnQuery
		})
	);
	await expect(heading).toBeVisible();
	await expect(page).toHaveURL(
		(url) =>
			url.searchParams.get(TRAIT_CATALOG_QUERY.View) === plane.id &&
			url.searchParams.get(TRAIT_CATALOG_QUERY.Generation) === String(plane.generation) &&
			url.searchParams.get(MEDIA_MODE_QUERY_PARAM) === COLLECTION_MEDIA_MODES.Snapshot
	);
	await back.click();
	await expect(block).toHaveValue(film.id);
});

test('fits adjacent landscape and portrait images in fullscreen', async ({ page }, info) => {
	const { path } = await installPlaneFixture(page);
	await enter(page, path);
	const trigger = page.getByRole('button', { name: 'preview token ' + FILM_TOKEN, exact: true });
	await trigger.scrollIntoViewIfNeeded();
	await trigger.locator('img').evaluate((image: HTMLImageElement) => image.decode());
	await trigger.click();
	const dialog = page.getByRole('dialog', { name: 'Token Preview' });
	const portraitId = tokens[1].id;

	async function checkImage(tokenId: string, orientation: 'landscape' | 'portrait') {
		const frame = dialog.getByTitle('token ' + tokenId, { exact: true });
		const image = frame.contentFrame().getByRole('img', { name: 'token ' + tokenId, exact: true });
		const ratio = await image.evaluate(async (node: HTMLImageElement) => {
			await node.decode();
			return node.naturalWidth / node.naturalHeight;
		});
		expect(ratio > 1).toBe(orientation === 'landscape');
		await expect
			.poll(async () => {
				const bounds = await frame.boundingBox();
				return bounds && bounds.width / bounds.height;
			})
			.toBeCloseTo(ratio, 2);

		const viewport = (await dialog.boundingBox())!;
		const frameBox = (await frame.boundingBox())!;
		const pixels = (await image.boundingBox())!;
		expect(
			Math.abs(frameBox.x + frameBox.width / 2 - (viewport.x + viewport.width / 2))
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(frameBox.y + frameBox.height / 2 - (viewport.y + viewport.height / 2))
		).toBeLessThanOrEqual(1);
		expect(frameBox.width).toBeLessThanOrEqual(viewport.width + 1);
		expect(frameBox.height).toBeLessThanOrEqual(viewport.height + 1);
		expect(pixels.width / pixels.height).toBeCloseTo(ratio, 2);
		expect(pixels.x).toBeGreaterThanOrEqual(frameBox.x - 1);
		expect(pixels.y).toBeGreaterThanOrEqual(frameBox.y - 1);
		expect(pixels.x + pixels.width).toBeLessThanOrEqual(frameBox.x + frameBox.width + 1);
		expect(pixels.y + pixels.height).toBeLessThanOrEqual(frameBox.y + frameBox.height + 1);
	}

	await checkImage(FILM_TOKEN, 'landscape');
	await page.mouse.move(0, 0);
	await page.screenshot({ path: info.outputPath('fullscreen-landscape.png') });
	await page.keyboard.press('ArrowLeft');
	await checkImage(portraitId, 'portrait');
	await page.screenshot({ path: info.outputPath('fullscreen-portrait.png') });
	await page.keyboard.press('ArrowRight');
	await checkImage(FILM_TOKEN, 'landscape');
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeVisible();
});

test('keeps structured traits on token details and shows muted flat traits in fullscreen', async ({
	page
}, info) => {
	const { path } = await installPlaneFixture(page);
	const [first, second] = tokens;
	// Even an older backend's detail-only tree must stay out of fullscreen.
	const preview = previewResponse(first);
	await page.route(
		(url) => url.pathname === '/api' + path + '/' + first.id + '/preview',
		(route) =>
			route.fulfill({
				json: { ...preview, token: { ...preview.token, traitTree: first.projected.tree } }
			})
	);
	await enter(page, selectCollectionViewHref(path, new URLSearchParams(), plane));
	await page.getByRole('button', { name: 'preview token ' + first.id, exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Token Preview' });
	const cycle = dialog.getByRole('button', { name: 'traits', exact: true });
	await expect(cycle).toBeEnabled();
	await expect(dialog.getByRole('link', { name: 'customize', exact: true })).toBeVisible();
	const box = dialog.locator('.token-preview-box');
	const initialBox = await box.boundingBox();
	await cycle.click();
	const traits = dialog.getByLabel('Token traits', { exact: true });
	const value = traits.getByRole('link', { name: CHAOS + ': Calm', exact: true });
	await expect(value).toBeVisible();
	await expect(traits.locator('dt')).toHaveCount(first.projected.values.length);
	await expect(dialog.locator('details')).toHaveCount(0);
	await expect(dialog.getByRole('button', { name: 'Expand all' })).toHaveCount(0);
	await page.mouse.move(0, 0);
	const mutedColor = await traits.evaluate((node) => getComputedStyle(node).color);
	await expect(value).toHaveCSS('color', mutedColor);
	await expect(traits).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(cycle).toHaveCSS('color', mutedColor);
	expect(await box.boundingBox()).toEqual(initialBox);
	const image = dialog.frameLocator('iframe').getByRole('img');
	await expect
		.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(1);
	await page.screenshot({ path: info.outputPath('plane-fullscreen-flat-traits.png') });
	await page.keyboard.press('ArrowRight');
	await expect(dialog.getByTitle('token ' + second.id, { exact: true })).toBeVisible();
	await expect(traits.getByRole('link', { name: CHAOS + ': Airy', exact: true })).toBeVisible();
	await expect(traits.locator('dt')).toHaveCount(second.projected.values.length);
	await expect(dialog.locator('details')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await page
		.getByTestId(TEST_IDS.TokenCard)
		.getByRole('link', { name: second.id, exact: true })
		.click();
	const detail = page.locator('.token-detail-traits-wrap');
	await expect(detail.getByRole('button', { name: 'Expand all' })).toBeVisible();
	await detail.getByText('Regular Constant fella', { exact: true }).click();
	await expect(detail.getByText('die dritte generation', { exact: true })).toBeVisible();
	await page.screenshot({ path: info.outputPath('plane-token-detail-projection.png') });
});

test('reads long Plane trait names and filenames together on token 34273', async ({
	page,
	isMobile
}, info) => {
	const { path } = await installPlaneFixture(page);
	await enter(page, path + '/' + DETAIL_TOKEN);
	const title = page.getByRole('heading', { level: 1, name: DETAIL_TOKEN, exact: true });
	await expect(title).toBeVisible();
	const traits = page.locator('.token-detail-traits-wrap');
	const tree = traits.locator('.trait-tree').first();
	const roots = tree.locator(':scope > ul > li > details');
	await expect(roots.first()).toBeVisible();
	for (const root of await roots.all()) await expect(root).toHaveAttribute('open', '');
	expect(await roots.locator('details').count()).toBeGreaterThan(0);
	await expect(roots.locator('details[open]')).toHaveCount(0);
	const table = traits.getByRole('table');
	const expandAll = traits.getByRole('button', { name: 'Expand all', exact: true });
	await expect(table).toBeVisible();
	await expect(expandAll).toHaveCount(1);
	const tableBox = (await table.boundingBox())!;
	const buttonBox = (await expandAll.boundingBox())!;
	expect(tableBox.y + tableBox.height).toBeLessThanOrEqual(buttonBox.y);
	expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(
		(await roots.first().boundingBox())!.y
	);
	await table.evaluate((element) => element.scrollIntoView({ block: 'start' }));
	await page.screenshot({ path: info.outputPath('34273-trait-table-and-tree.png') });
	const background = tree.getByText('Background bottom', { exact: true });
	const objects = tree.getByText('Chain connected objects', { exact: true });
	const coverage = tree.getByText(COVERAGE_FIELD, { exact: true });
	const filename = tree.getByText(BACKGROUND_FILE, { exact: true });
	for (const text of [background, objects, coverage, filename]) await expect(text).toBeVisible();
	const other = tree.locator('summary').getByText('Other', { exact: true });
	await other.click();
	await expect(background).toBeHidden();
	await other.click();
	await expect(background).toBeVisible();

	async function inspectLayout(name: string) {
		await tree.evaluate((element) => element.scrollIntoView({ block: 'start' }));
		const center = await tree.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return Math.abs(rect.left + rect.width / 2 - document.documentElement.clientWidth / 2);
		});
		expect(center).toBeLessThanOrEqual(2);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
			)
		).toBe(true);
		if (!isMobile) {
			for (const text of [background, objects, coverage, filename]) {
				const lines = await text.evaluate((element) => {
					const range = new Range();
					range.selectNodeContents(element);
					return range.getClientRects().length;
				});
				expect(lines).toBe(1);
			}
			const labelBox = (await background.boundingBox())!;
			const valueBox = (await filename.boundingBox())!;
			expect(valueBox.y).toBeCloseTo(labelBox.y, 0);
			expect(valueBox.x - (labelBox.x + labelBox.width)).toBeGreaterThanOrEqual(4);
			const thirdValueBox = (await tree.getByText('34', { exact: true }).boundingBox())!;
			expect(thirdValueBox.x).toBeCloseTo(valueBox.x, 0);
		}
		await page.screenshot({ path: info.outputPath(name + '.png') });
	}
	await inspectLayout('34273-other-fields');
	if (info.project.name === 'desktop-1267') {
		await page.setViewportSize({ width: 1370, height: 1048 });
		await inspectLayout('34273-traits-1370');
		await page.setViewportSize({ width: 708, height: 857 });
		await inspectLayout('34273-other-fields-708');
	}

	const characterRoot = roots.filter({ has: page.getByText('Characters', { exact: true }) });
	const characters = characterRoot.locator(':scope > summary');
	const collapseAll = traits.getByRole('button', { name: 'Collapse all', exact: true });
	await characters.click();
	await expandAll.focus();
	await expandAll.press('Enter');
	await expect(tree.locator('details:not([open])')).toHaveCount(0);
	await expect(collapseAll).toBeFocused();
	const characterFields = characterRoot.locator('dd');
	await expect(characterFields.first()).toBeVisible();
	await expect(expandAll).toHaveCount(0);
	await expect(tree.getByRole('textbox')).toHaveCount(0);
	await collapseAll.evaluate((button) => button.scrollIntoView({ block: 'start' }));
	await page.screenshot({ path: info.outputPath('34273-all-traits-expanded.png') });
	await characters.click();
	await expect(characterFields).toHaveCount(0);
	await expect(expandAll).toBeEnabled();
	await characters.click();
	await expect(collapseAll).toBeEnabled();
	const expandedButtonBox = (await collapseAll.boundingBox())!;
	await collapseAll.press('Space');
	await expect(expandAll).toBeFocused();
	await expect(tree.locator('details[open]')).toHaveCount(0);
	await expect(roots.locator('details')).toHaveCount(0);
	await expect(tree.locator('dd')).toHaveCount(0);
	const collapsedButtonBox = (await expandAll.boundingBox())!;
	expect(
		Math.abs(
			expandedButtonBox.x +
				expandedButtonBox.width / 2 -
				(collapsedButtonBox.x + collapsedButtonBox.width / 2)
		)
	).toBeLessThanOrEqual(1);
	await expandAll.evaluate((button) => button.scrollIntoView({ block: 'center' }));
	await page.screenshot({ path: info.outputPath('34273-all-traits-collapsed.png') });
	await characters.click();
	await expect(characterRoot.locator('details').first()).toBeVisible();
	await expect(characterRoot.locator('details[open]')).toHaveCount(0);
	await expandAll.click();
	await expect(tree.locator('details:not([open])')).toHaveCount(0);
	await expect(characterFields.first()).toBeVisible();
	await expect(collapseAll).toBeEnabled();
});

for (const entry of ['All', 'Artworks'] as const) {
	test(`opens the token’s block summary editor from the ${entry} gallery`, async ({
		page
	}, info) => {
		const { path, chain, collection } = await installPlaneFixture(page);
		const settingsPath = '/api' + path + '/customization';
		await page.route(
			(url) => url.pathname === settingsPath,
			(route) => route.fulfill({ json: { chain, collection, customization: null } })
		);
		await enter(page, path);
		if (entry === 'Artworks') {
			await page
				.getByRole('group', { name: 'Token kind' })
				.getByRole('link', { name: entry })
				.click();
		}
		await page.getByRole('button', { name: 'preview token ' + tokens[0].id, exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Token Preview' });
		const settingsRequest = page.waitForRequest(
			(request) => new URL(request.url()).pathname === settingsPath
		);
		await dialog.getByRole('link', { name: 'customize', exact: true }).click();
		const query = new URL((await settingsRequest).url()).searchParams;
		expect(query.get(TRAIT_CATALOG_QUERY.View)).toBe(plane.id);
		expect(query.get(TRAIT_CATALOG_QUERY.Generation)).toBe(String(plane.generation));
		const section = COLLECTION_CUSTOMIZATION_SECTION.TokenCardTraitSummaryTemplate;
		await expect(page).toHaveURL(
			(url) => url.pathname === path + '/customization' && url.hash === '#' + section
		);
		await expect(page.getByRole('combobox', { name: 'Collection block' })).toHaveValue(plane.id);
		await expect(
			page
				.locator('#' + section)
				.getByRole('heading', { name: 'token card trait summary template' })
		).toBeInViewport();
		await expect(dialog).toHaveCount(0);
		await page.screenshot({ path: info.outputPath('preview-block-summary-editor.png') });
	});
}

test('drafts a collection bid from the highest contract-wide offer in a mixed book', async ({
	page
}, info) => {
	const query = new URLSearchParams({
		[BID_SCOPE_QUERY_PARAM]: COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection
	});
	const market = buildBiddingE2eCollectionBiddingData(query).bidBook.bids.find(
		(bid): bid is ApiBiddingMarketBidBookRow =>
			bid.materialization.kind === TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid
	)!;
	const encodedTokenIds = tokens
		.slice(0, 2)
		.map((token) => token.id)
		.join(',');
	const finite = {
		...market,
		orderId: 'finite-collection-offer',
		scope: {
			...market.scope,
			kind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet,
			label: formatTradingBiddingBidScopeLabel({ kind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet }),
			encodedTokenIds
		},
		price: {
			kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact,
			eth: '1',
			wei: parseEther('1').toString()
		}
	};
	let onlyFinite = false;
	const { path } = await installPlaneFixture(page, (params) => {
		const data = buildBiddingE2eCollectionBiddingData(params);
		const bids = onlyFinite ? [finite] : [finite, market];
		return {
			...data,
			bidBook: { ...data.bidBook, bids, state: { ...data.bidBook.state, rowCount: bids.length } }
		};
	});
	const destination = selectCollectionViewHref(path + '/bidding', query, plane);
	const button = page.getByRole('button', { name: 'place collection bid', exact: true });
	await enter(page, destination);
	const order = page.locator('tr:has([data-open-sea-order-hash="finite-collection-offer"])');
	await expect(
		order.getByRole('cell', { name: 'token set ' + encodedTokenIds, exact: true })
	).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'place bid on collection', exact: true })
	).toHaveCount(0);
	await page.screenshot({ path: info.outputPath('mixed-collection-offers.png') });
	await button.click();
	await expect(page.getByRole('dialog', { name: 'bidding automation' })).toBeVisible();

	onlyFinite = true;
	await enter(page, destination);
	await expect(order).toBeVisible();
	await expect(button).toBeDisabled();
	await page.screenshot({ path: info.outputPath('finite-only-collection-offers.png') });
});
