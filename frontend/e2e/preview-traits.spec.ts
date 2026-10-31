import { expect, test, type Page, type TestInfo } from 'playwright/test';
import { DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG } from '@artgod/shared/config/bidding';
import { PAGINATION_QUERY_PARAMS } from '@artgod/shared/config/pagination';
import { getDefaultBlockExplorerConfig } from '@artgod/shared/config/block-explorer';
import { TRAIT_FILTER_QUERY_PARAMS } from '@artgod/shared/types/browse';
import {
	COLLECTION_CUSTOMIZATION_SOURCE_KIND,
	defaultTraitFilterPresentationConfig,
	defaultTraitSummaryTemplateConfig,
	defaultMediaPurposePolicyConfig,
	renderTraitSummaryTemplate
} from '@artgod/shared/types';
import { defaultImageCachePolicyConfig } from '@artgod/shared/media/token-image-cache';
import type {
	CollectionDetailApiResponse,
	CollectionCustomizationApiResponse,
	RuntimeConfigApiResponse,
	TokenPreviewApiResponse
} from '../src/lib/api-types';
import {
	BIDDING_AUTOMATION_E2E_COLLECTION_BASE_PATH,
	BIDDING_E2E_CHAIN,
	BIDDING_E2E_COLLECTION,
	buildBiddingE2eCollectionDetailData,
	resolveBiddingE2eTokenMedia
} from '../src/lib/e2e/bidding-automation-fixtures';
import { LOCAL_STORAGE_BOOLEAN_VALUES, LOCAL_STORAGE_KEYS } from '../src/lib/local-storage-keys';
import { COLLECTION_CUSTOMIZATION_SECTION } from '../src/lib/customization-query';
import {
	TOKEN_PREVIEW_TRAITS_LIMITS,
	TOKEN_PREVIEW_TRAITS_MODE
} from '../src/lib/token-preview-traits';
import {
	attachDiagnosticsForTestFailure,
	captureDiagnosticsForTest,
	type PageDiagnosticsRegistry
} from './attached-app';
import { installBiddingAutomationApiMock } from './helpers/bidding-automation-api';

const TOKEN = { Many: '101', Few: '102', None: '104' } as const;
const LONG_TRAIT = { key: 'Long trait label', value: 'Long value beyond fifteen characters' };
const MANY_TRAITS = [
	LONG_TRAIT,
	...Array.from({ length: 2 * TOKEN_PREVIEW_TRAITS_LIMITS.RowsPerPage }, (_, index) => ({
		key: `Trait ${String(index + 1).padStart(2, '0')}`,
		value: `Value ${String(index + 1).padStart(2, '0')}`
	}))
];
const diagnosticsByTest: PageDiagnosticsRegistry = new Map();
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Token Preview' });
const traitsButton = (page: Page) =>
	dialog(page).getByRole('button', { name: 'traits', exact: true });
const output = (page: Page) => dialog(page).getByLabel('Token traits', { exact: true });
const rows = (page: Page) => output(page).locator('dt');
const apiPath = `/api/${BIDDING_E2E_CHAIN.slug}/${BIDDING_E2E_COLLECTION.slug}`;

test.beforeEach(async ({ page }, info) => {
	captureDiagnosticsForTest(diagnosticsByTest, page, info);
	await page.addInitScript(
		({ keys, trueValue }) => {
			if (window !== window.top) return;
			localStorage.setItem(keys.tokenPreviewScalePercent, '60');
			localStorage.setItem(keys.tokenPreviewSwipeHintDismissed, trueValue);
		},
		{ keys: LOCAL_STORAGE_KEYS, trueValue: LOCAL_STORAGE_BOOLEAN_VALUES.True }
	);
	await installBiddingAutomationApiMock(page);
	await installPreviewMock(page);
});

test.afterEach(async ({}, info) => attachDiagnosticsForTestFailure(diagnosticsByTest, info));

test('cycles summary, three bounded pages, empty and summary without moving media', async ({
	page,
	isMobile
}, info) => {
	await openPreview(page, TOKEN.Many);
	const summary = fixtureCards().find((card) => card.tokenId === TOKEN.Many)!.traitSummary!;
	await expect(output(page)).toHaveText(summary);
	await expect(output(page).getByRole('link')).toHaveCount(0);
	const summaryFont = await output(page).evaluate((node) =>
		Number.parseFloat(getComputedStyle(node).fontSize)
	);
	const cardFont = await page
		.locator('.token-grid-traits')
		.first()
		.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
	expect(summaryFont).toBeLessThan(cardFont * 0.8);
	const mediaBox = await dialog(page).locator('.token-preview-box').boundingBox();
	const buttonBox = await traitsButton(page).boundingBox();
	const summaryBox = await output(page).boundingBox();
	expect(summaryBox!.y + summaryBox!.height).toBeLessThanOrEqual(buttonBox!.y);
	if (!isMobile) {
		const arrows = await dialog(page).getByLabel('Preview navigation').boundingBox();
		expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(arrows!.y);
	}
	await surface(page, info, 'summary');

	for (const [pageIndex, count] of [
		TOKEN_PREVIEW_TRAITS_LIMITS.RowsPerPage,
		TOKEN_PREVIEW_TRAITS_LIMITS.RowsPerPage,
		1
	].entries()) {
		await traitsButton(page).click();
		await expect(rows(page)).toHaveCount(count);
		expect(await dialog(page).locator('.token-preview-box').boundingBox()).toEqual(mediaBox);
		expect(await traitsButton(page).boundingBox()).toEqual(buttonBox);
		await assertBounded(page);
		if (pageIndex === 0) {
			await expect(rows(page).first()).toHaveText('Long trait');
			await expect(output(page).locator('dd').first()).toHaveText('Long value beyo');
			await expect(output(page)).not.toContainText('…');
		}
		await surface(page, info, `page-${pageIndex + 1}`);
	}
	await traitsButton(page).click();
	await expect(output(page)).toHaveCount(0);
	await surface(page, info, 'hidden');
	await traitsButton(page).click();
	await expect(output(page)).toHaveText(summary);
	await page.keyboard.press('Escape');
	await expect(dialog(page)).toHaveCount(0);
	expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
});

test('restores the exact page across reloads, clamps fewer traits, and remembers empty output', async ({
	page
}, info) => {
	await openPreview(page, TOKEN.Many);
	for (let index = 0; index < 3; index += 1) await traitsButton(page).click();
	await expect(rows(page)).toHaveCount(1);
	await page.keyboard.press('Escape');
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');
	await page.getByRole('button', { name: `preview token ${TOKEN.Many}`, exact: true }).click();
	await expect(rows(page)).toHaveCount(1);
	await page.keyboard.press('d');
	await expect(dialog(page).getByTitle(`token ${TOKEN.Few}`, { exact: true })).toBeVisible();
	await expect(rows(page)).toHaveCount(3);
	expect(await readPreference(page)).toEqual({ mode: TOKEN_PREVIEW_TRAITS_MODE.Page, page: 0 });
	await surface(page, info, 'clamped-page');
	await traitsButton(page).click();
	await expect(output(page)).toHaveCount(0);
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: `preview token ${TOKEN.Many}`, exact: true }).click();
	await expect(traitsButton(page)).toBeEnabled();
	await expect(output(page)).toHaveCount(0);
	await traitsButton(page).click();
	await expect(output(page)).toBeVisible();
	await traitsButton(page).click();
	await page.keyboard.press('Escape');
	await page.getByRole('link', { name: 'load next', exact: true }).click();
	await page.getByRole('button', { name: `preview token ${TOKEN.None}`, exact: true }).click();
	await expect(traitsButton(page)).toBeEnabled();
	await expect(output(page)).toHaveCount(0);
	expect(await readPreference(page)).toEqual({ mode: TOKEN_PREVIEW_TRAITS_MODE.Hidden });
	await traitsButton(page).click();
	await expect(output(page).getByRole('link', { name: 'customize', exact: true })).toBeVisible();
	await surface(page, info, 'no-traits-or-template');
});

test('opens the template editor from an empty summary and uses its saved template on return', async ({
	page
}, info) => {
	await installCollectionMock(page);
	const customization = await installCustomizationMock(page);
	await installPreviewMock(
		page,
		() => customization.tokenCardTraitSummaryTemplate.effectiveConfig.template
	);
	await openPreview(page, TOKEN.Few);
	const customize = output(page).getByRole('link', { name: 'customize', exact: true });
	await expect(customize).toBeVisible();
	expect(await customize.evaluate((node) => getComputedStyle(node).color)).toBe(
		await output(page).evaluate((node) => getComputedStyle(node).color)
	);
	const mediaBox = await dialog(page).locator('.token-preview-box').boundingBox();
	await traitsButton(page).click();
	await expect(rows(page)).toHaveCount(3);
	await traitsButton(page).click();
	await expect(output(page)).toHaveCount(0);
	await traitsButton(page).click();
	await expect(customize).toBeVisible();
	expect(await dialog(page).locator('.token-preview-box').boundingBox()).toEqual(mediaBox);
	await surface(page, info, 'empty-summary-customize');
	const href = new URL((await customize.getAttribute('href'))!, page.url());
	expect(href.pathname).toBe(
		`/${BIDDING_E2E_CHAIN.slug}/${BIDDING_E2E_COLLECTION.slug}/customization`
	);
	expect(href.hash).toBe(`#${COLLECTION_CUSTOMIZATION_SECTION.TokenCardTraitSummaryTemplate}`);
	await customize.click();
	await expect(page).toHaveURL(href.toString());
	await expect(dialog(page)).toHaveCount(0);
	const editor = page.locator(`#${COLLECTION_CUSTOMIZATION_SECTION.TokenCardTraitSummaryTemplate}`);
	const heading = editor.getByRole('heading', {
		name: 'token card trait summary template',
		exact: true
	});
	await expect(heading).toBeInViewport();
	const examples = editor.getByRole('table', { name: 'Trait summary template examples' });
	await expect(examples).toBeVisible();
	await surface(page, info, 'template-editor-anchor');
	await examples.scrollIntoViewIfNeeded();
	await surface(page, info, 'template-examples');
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await editor
		.getByRole('textbox', { name: 'Token card trait summary template', exact: true })
		.fill('{Mode} / {Biome}');
	await editor.getByRole('button', { name: 'save', exact: true }).click();
	await expect(editor.getByText('saved', { exact: true })).toBeVisible();
	await page
		.getByLabel('Collection sections', { exact: true })
		.getByRole('link', { name: 'tokens', exact: true })
		.click();
	await page.getByRole('button', { name: `preview token ${TOKEN.Few}`, exact: true }).click();
	await expect(output(page)).toHaveText('Terrain / 7');
	await expect(output(page).getByRole('link', { name: 'customize', exact: true })).toHaveCount(0);
	await surface(page, info, 'saved-template-preview');
});

test('filters by the full clicked value and keeps text muted until hover or keyboard focus', async ({
	page,
	isMobile
}, info) => {
	await installCollectionMock(page);
	await openPreview(page, TOKEN.Many);
	await traitsButton(page).click();
	const value = output(page).getByRole('link', {
		name: `${LONG_TRAIT.key}: ${LONG_TRAIT.value}`,
		exact: true
	});
	const href = new URL((await value.getAttribute('href'))!, page.url());
	expect(href.searchParams.getAll(TRAIT_FILTER_QUERY_PARAMS.Traits)).toEqual([
		`${LONG_TRAIT.key}:${LONG_TRAIT.value}`
	]);
	const color = await value.evaluate((node) => getComputedStyle(node).color);
	expect(color).toBe(
		await rows(page)
			.first()
			.evaluate((node) => getComputedStyle(node).color)
	);
	if (!isMobile) {
		await value.hover();
		expect(await value.evaluate((node) => getComputedStyle(node).color)).not.toBe(color);
	}
	await page.mouse.move(0, 0);
	await page.keyboard.press('Tab');
	await value.focus();
	expect(await value.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
	const focused = await value.evaluate((node) => {
		const style = getComputedStyle(node);
		return {
			color: style.color,
			outline: style.outlineStyle,
			decoration: style.textDecorationLine
		};
	});
	expect(focused.color).not.toBe(color);
	expect(focused.outline).toBe('none');
	expect(focused.decoration).toBe('none');
	await surface(page, info, 'trait-filter-focus');
	await value.click();
	await expect(page).toHaveURL(href.toString());
	await expect(dialog(page)).toHaveCount(0);
	await expect(page.getByLabel('Selected trait filters')).toContainText('Long trait');
});

test('keeps loading and retry stable and bounds traits through resize and zoom', async ({
	page
}, info) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let fail = true;
	await page.route(`**${apiPath}/${TOKEN.Many}/preview?*`, async (route) => {
		if (fail) {
			await pending;
			fail = false;
			await route.fulfill({ status: 422, json: { message: 'fixture request failure' } });
		} else await route.fallback();
	});
	await openCollectionHarness(page);
	await page.getByRole('button', { name: `preview token ${TOKEN.Many}`, exact: true }).click();
	await expect(dialog(page).getByLabel('loading preview')).toBeVisible();
	await expect(traitsButton(page)).toBeDisabled();
	const box = await dialog(page).locator('.token-preview-box').boundingBox();
	await surface(page, info, 'loading');
	release();
	await expect(dialog(page).getByRole('button', { name: 'retry', exact: true })).toBeVisible();
	expect(await dialog(page).locator('.token-preview-box').boundingBox()).toEqual(box);
	await surface(page, info, 'error');
	await dialog(page).getByRole('button', { name: 'retry', exact: true }).click();
	await expect(traitsButton(page)).toBeEnabled();
	await traitsButton(page).click();
	await expect(rows(page)).toHaveCount(TOKEN_PREVIEW_TRAITS_LIMITS.RowsPerPage);
	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 844, height: 390 }
	]) {
		await page.setViewportSize(viewport);
		await assertBounded(page);
		await surface(page, info, `resized-${viewport.width}`);
	}
	await page.keyboard.press('0');
	await assertBounded(page);
	await surface(page, info, 'maximum-scale');
});

async function openPreview(page: Page, tokenId: string): Promise<void> {
	await openCollectionHarness(page);
	await page.getByRole('button', { name: `preview token ${tokenId}`, exact: true }).click();
	await expect(traitsButton(page)).toBeEnabled();
}

async function openCollectionHarness(page: Page): Promise<void> {
	await page.goto(BIDDING_AUTOMATION_E2E_COLLECTION_BASE_PATH, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');
}

function fixtureCards() {
	const first = buildBiddingE2eCollectionDetailData(new URLSearchParams()).tokens;
	const next = new URLSearchParams({ [PAGINATION_QUERY_PARAMS.Cursor]: first.nextCursor! });
	return [...first.items, ...buildBiddingE2eCollectionDetailData(next).tokens.items];
}

async function assertBounded(page: Page): Promise<void> {
	const bounds = await output(page).boundingBox();
	const overlay = await dialog(page).boundingBox();
	expect(bounds!.x).toBeGreaterThanOrEqual(overlay!.x);
	expect(bounds!.y).toBeGreaterThanOrEqual(overlay!.y);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(overlay!.x + overlay!.width);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(overlay!.y + overlay!.height);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function surface(page: Page, info: TestInfo, name: string): Promise<void> {
	const path = info.outputPath(`${name}.png`);
	await page.screenshot({ path });
	await info.attach(name, { path, contentType: 'image/png' });
}

async function readPreference(page: Page) {
	return page.evaluate(
		(key) => JSON.parse(localStorage.getItem(key)!),
		LOCAL_STORAGE_KEYS.tokenPreviewTraitDisplay
	);
}

async function installPreviewMock(page: Page, summaryTemplate?: () => string): Promise<void> {
	await page.route(`**${apiPath}/*/preview?*`, async (route) => {
		const url = new URL(route.request().url());
		const tokenId = url.pathname.split('/').at(-2)!;
		const card = fixtureCards().find((item) => item.tokenId === tokenId)!;
		const response: TokenPreviewApiResponse = {
			media: resolveBiddingE2eTokenMedia(url.searchParams),
			token: {
				tokenId,
				image: card.image,
				animationUrl: null,
				traitSummary: summaryTemplate
					? renderTraitSummaryTemplate(summaryTemplate(), card.attributes)
					: tokenId === TOKEN.None
						? null
						: card.traitSummary,
				attributes:
					tokenId === TOKEN.Many ? MANY_TRAITS : tokenId === TOKEN.None ? [] : card.attributes
			}
		};
		await route.fulfill({ json: response });
	});
}

async function installCustomizationMock(
	page: Page
): Promise<CollectionCustomizationApiResponse['customization']> {
	function userSource<T>(config: T) {
		return {
			selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
			userConfig: config,
			extensionConfig: null,
			effectiveConfig: config
		};
	}
	const customization: CollectionCustomizationApiResponse['customization'] = {
		traitFilterPresentation: {
			...userSource(defaultTraitFilterPresentationConfig()),
			availableTraitKeys: ['Mode', 'Biome', 'Zone']
		},
		tokenCardTraitSummaryTemplate: userSource(defaultTraitSummaryTemplateConfig()),
		activityRowTraitSummaryTemplate: userSource(defaultTraitSummaryTemplateConfig()),
		imageCachePolicy: userSource(defaultImageCachePolicyConfig()),
		mediaPurposePolicy: userSource(defaultMediaPurposePolicyConfig())
	};
	await page.route(`**${apiPath}/customization`, async (route) => {
		if (route.request().method() === 'PUT') {
			const body = route.request().postDataJSON();
			customization.tokenCardTraitSummaryTemplate = userSource({
				template: body.tokenCardTraitSummaryTemplate.userConfig.template
			});
		}
		await route.fulfill({
			json: {
				chain: BIDDING_E2E_CHAIN,
				collection: BIDDING_E2E_COLLECTION,
				customization
			} satisfies CollectionCustomizationApiResponse
		});
	});
	return customization;
}

async function installCollectionMock(page: Page): Promise<void> {
	await page.route(new RegExp(`${apiPath}(?:\\?.*)?$`), async (route) => {
		const data = buildBiddingE2eCollectionDetailData(new URL(route.request().url()).searchParams);
		const response: CollectionDetailApiResponse = {
			chain: data.chain,
			collection: data.collection,
			media: data.media,
			tokens: data.tokens,
			traits: {
				facets: data.facets,
				selected: data.selectedTraits,
				selectedRanges: data.selectedTraitRanges
			}
		};
		await route.fulfill({ json: response });
	});
	const runtime: RuntimeConfigApiResponse = {
		integrations: {
			opensea: { enabled: false, mode: 'disabled', reason: null, missingKeys: [], requiredKeys: [] }
		},
		blockExplorer: getDefaultBlockExplorerConfig(),
		bidding: {
			trustOpenSeaSignedZoneTraitOffers: false,
			bidBookLiveRefresh: DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG
		}
	};
	await page.route('**/api/runtime/config', (route) => route.fulfill({ json: runtime }));
}
