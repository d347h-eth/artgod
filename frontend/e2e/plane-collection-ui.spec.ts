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
import { TRAIT_FILTER_DISPLAY_KIND, TRAIT_FILTER_QUERY_PARAMS } from '@artgod/shared/types';
import { PRICE_HISTORY_QUERY } from '@artgod/shared/http/collection-routes';
import { TRAIT_CATALOG_QUERY, type CollectionViewStatus } from '@artgod/shared/types/trait-catalog';
import { buildTokenDetailHref } from '../src/lib/token-browser-query';
import { MEDIA_MODE_QUERY_PARAM } from '../src/lib/media-mode';
import { selectCollectionViewHref } from '../src/lib/collection-view';
import { COLLECTION_PAGE_TOP_ACTIONS_DOM } from '../src/lib/components/collection-page-layout-dom';
import {
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
	},
	{
		id: FILM_TOKEN,
		facts: [...artwork(FILM, 'video'), { key: 'artist', value: FILM_ARTIST }]
	}
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

const facetsByView = new Map([
	[
		plane.id,
		[
			setFacet(CHAOS, [
				['Calm', 1],
				['Airy', 1]
			]),
			setFacet(MARK_CHAOS, [['Airy', 1]]),
			setFacet(MARK_COUNT, [['7', 1]]),
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

async function installPlaneFixture(page: Page) {
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
	await installBiddingAutomationApiMock(page, { bidBookCollection: collection });
	await page.route('**/api/runtime/config', (route) =>
		route.fulfill({ json: { bidding: { trustOpenSeaSignedZoneTraitOffers: true } } })
	);
	await page.route('**/e2e-artwork/*', (route) => {
		const id = new URL(route.request().url()).pathname.split('/').pop()!;
		const dir = process.env.ARTGOD_E2E_PLANE_MEDIA_DIR;
		const file = dir && join(dir, id + '.webp');
		if (file && ((id !== FILM_TOKEN && id !== DETAIL_TOKEN) || existsSync(file))) {
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
				views: [plane, drimi, film, backrooms, driluhh, ...typedViews]
			}
		});
	});
	await page.route(
		(url) => url.pathname === apiPath,
		(route) => {
			const params = new URL(route.request().url()).searchParams;
			const view = params.get(TRAIT_CATALOG_QUERY.View) ?? '';
			requests.push(view);
			const { selectedTraits } = buildBiddingE2eCollectionDetailData(params);
			const scopedTokens = tokens.filter((token) => token.view.id === view);
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
						facets: facetsByView.get(view) ?? []
					}
				}
			});
		}
	);
	for (const token of detailTokens) {
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
	return { path, requests };
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
	await checkChrome();
	const origin = await offers.boundingBox();
	await shots('01-collection-kinds');
	await kind.getByRole('link', { name: 'Artworks' }).click();
	await expect(block).toHaveValue('');
	await expect(block.getByRole('option')).toHaveText([
		'Choose block',
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
	expect(await offers.boundingBox()).toEqual(origin);
	await expect(cards).toHaveCount(0);
	expect(requests).toEqual([]);
	await shots('02-artworks-blocks');

	await block.focus();
	await block.press('f');
	await expect(page.getByText('1 listed', { exact: true })).toBeVisible();
	await expect(block).toHaveValue(film.id);
	await expect(block).toBeFocused();
	await expect(page.getByText(/^collection block\s*=\s*film clips$/i)).toHaveCount(0);
	await checkChrome();
	expect(await offers.boundingBox()).toEqual(origin);
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
	await page.getByText('Characters', { exact: true }).click();
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
	expect(requests).not.toContain('');
});

test('separates the collection scope from Offers and Asks controls', async ({ page }, info) => {
	const { path } = await installPlaneFixture(page);
	await enter(page, path);
	const kind = page.getByRole('group', { name: 'Token kind' });
	const block = page.getByRole('combobox', { name: 'Collection block' });
	const actions = page.locator('.' + COLLECTION_PAGE_TOP_ACTIONS_DOM.classes.stack);
	const rows = actions.locator(':scope > .' + COLLECTION_PAGE_TOP_ACTIONS_DOM.classes.row);
	const picker = rows.filter({ has: kind });
	await kind.getByRole('link', { name: 'Artworks' }).click();
	await expect(block).toBeVisible();
	await expect(rows).toHaveCount(1);
	const trailingSpace = await actions.evaluate(
		(element) =>
			element.getBoundingClientRect().bottom -
			element.firstElementChild!.getBoundingClientRect().bottom -
			parseFloat(getComputedStyle(element).paddingBottom)
	);
	expect(Math.abs(trailingSpace)).toBeLessThanOrEqual(1);

	await block.selectOption({ label: driluhh.label });
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
	await page.keyboard.press('Shift+Tab');
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

test('reads long Plane trait names and filenames together on token 34273', async ({
	page,
	isMobile
}, info) => {
	const { path } = await installPlaneFixture(page);
	await enter(page, path + '/' + DETAIL_TOKEN);
	const title = page.getByRole('heading', { level: 1, name: DETAIL_TOKEN, exact: true });
	await expect(title).toBeVisible();
	await page.locator('summary').getByText('Other', { exact: true }).click();
	const traits = page.locator('.token-detail-traits-wrap');
	const tree = traits.locator('.trait-tree').first();
	const background = tree.getByText('Background bottom', { exact: true });
	const objects = tree.getByText('Chain connected objects', { exact: true });
	const coverage = tree.getByText(COVERAGE_FIELD, { exact: true });
	const filename = tree.getByText(BACKGROUND_FILE, { exact: true });
	for (const text of [background, objects, coverage, filename]) await expect(text).toBeVisible();

	async function inspectLayout(name: string) {
		await title.evaluate((element) => element.scrollIntoView({ block: 'start' }));
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
		await page.setViewportSize({ width: 708, height: 857 });
		await inspectLayout('34273-other-fields-708');
	}
});
