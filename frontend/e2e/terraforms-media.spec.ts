import { expect, test, type Locator, type Page, type Route, type TestInfo } from 'playwright/test';
import {
	COLLECTION_MEDIA_MODE_OPTIONS,
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_PREFERENCE_VALUES,
	COLLECTION_MEDIA_QUERY_PARAMS
} from '@artgod/shared/extensions';
import {
	TERRAFORMS_MEDIA_MODE_OPTIONS,
	TERRAFORMS_MEDIA_MODES,
	TERRAFORMS_MEDIA_PREFERENCE_LABEL,
	TERRAFORMS_MEDIA_VARIANT_OPTIONS,
	TERRAFORMS_MEDIA_VARIANTS
} from '@artgod/shared/extensions/terraforms';
import { LOCAL_STORAGE_BOOLEAN_VALUES, LOCAL_STORAGE_KEYS } from '../src/lib/local-storage-keys';
import {
	BIDDING_E2E_CHAIN,
	BIDDING_E2E_COLLECTION,
	buildBiddingE2eTokenDetailData,
	resolveBiddingE2eTokenMedia
} from '../src/lib/e2e/bidding-automation-fixtures';
import { installBiddingAutomationApiMock } from './helpers/bidding-automation-api';

const COLLECTION_PATH = '/e2e-harness/collection';
const TOKEN_ID = '101';
const TOKEN_DETAIL_PATH = `${COLLECTION_PATH}/${TOKEN_ID}`;
// This fixture scale leaves enough backdrop to exercise both fitted and hidden touch controls.
const TOKEN_PREVIEW_E2E_SCALE_PERCENT = '45';
// The media suite uses the mobile project declared by its Playwright configuration.
const TERRAFORMS_MEDIA_E2E_TOUCH_PROJECT = 'pixel-7';
// Landscape geometry intentionally removes the vertical backdrop needed by the control stack.
const TERRAFORMS_MEDIA_E2E_CONSTRAINED_VIEWPORT = { width: 915, height: 412 } as const;
// The source-to-preference gap should read as approximately one compact source control.
const MEDIA_SOURCE_TO_PREFERENCE_MIN_GAP_RATIO = 0.9;
const MEDIA_REQUEST_ERROR_MESSAGE = 'E2E live V0 request failed';
const MEDIA_REQUEST_KIND = {
	Detail: 'detail',
	Preview: 'preview'
} as const;
const MEDIA_API_TOKEN_PATH_PATTERN = `/api/${escapeRegExp(BIDDING_E2E_CHAIN.slug)}/${escapeRegExp(BIDDING_E2E_COLLECTION.slug)}/[^/]+`;
const MEDIA_PREVIEW_API_ROUTE_PATTERN = new RegExp(
	`${MEDIA_API_TOKEN_PATH_PATTERN}/preview(?:\\?.*)?$`
);
const MEDIA_DETAIL_API_ROUTE_PATTERN = new RegExp(`${MEDIA_API_TOKEN_PATH_PATTERN}(?:\\?.*)?$`);

type MediaRequestKind = (typeof MEDIA_REQUEST_KIND)[keyof typeof MEDIA_REQUEST_KIND];

type CapturedMediaRequest = {
	kind: MediaRequestKind;
	tokenId: string;
	mode: string | null;
	preference: string | null;
	variant: string | null;
};

type MediaApiMock = {
	requests: CapturedMediaRequest[];
	holdNextPreview(): void;
	releaseHeldPreview(): void;
	failNextPreviewLiveV0(): void;
	failNextDetailLiveV0(): void;
};

test.beforeEach(async ({ page }) => {
	await page.addInitScript(
		({ scaleKey, scaleValue, hintKey, dismissedValue }) => {
			window.localStorage.setItem(scaleKey, scaleValue);
			window.localStorage.setItem(hintKey, dismissedValue);
		},
		{
			scaleKey: LOCAL_STORAGE_KEYS.tokenPreviewScalePercent,
			scaleValue: TOKEN_PREVIEW_E2E_SCALE_PERCENT,
			hintKey: LOCAL_STORAGE_KEYS.tokenPreviewSwipeHintDismissed,
			dismissedValue: LOCAL_STORAGE_BOOLEAN_VALUES.True
		}
	);
});

test.describe('Terraforms media selection', () => {
	test('keeps source and V2 preference together in the token toolbar', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page);
		await openHarnessPage(page, COLLECTION_PATH);

		const source = page.getByLabel('Token media source');
		const preference = page.getByRole('button', { name: TERRAFORMS_MEDIA_PREFERENCE_LABEL });
		const snapshotSource = source.getByText(COLLECTION_MEDIA_MODE_OPTIONS.Snapshot.label, {
			exact: true
		});
		await expect(snapshotSource).toBeVisible();
		await expect(
			source.getByRole('link', { name: TERRAFORMS_MEDIA_MODE_OPTIONS.Live.label, exact: true })
		).toBeVisible();
		await expect(preference).toHaveAttribute('aria-pressed', 'true');

		const sourceBox = await source.boundingBox();
		const snapshotSourceBox = await snapshotSource.boundingBox();
		const preferenceBox = await preference.boundingBox();
		expect(sourceBox).not.toBeNull();
		expect(snapshotSourceBox).not.toBeNull();
		expect(preferenceBox).not.toBeNull();
		expect(Math.abs((sourceBox?.y ?? 0) - (preferenceBox?.y ?? 0))).toBeLessThan(8);
		const sourceToPreferenceGap =
			(preferenceBox?.x ?? 0) - ((sourceBox?.x ?? 0) + (sourceBox?.width ?? 0));
		expect(sourceToPreferenceGap).toBeGreaterThanOrEqual(
			(snapshotSourceBox?.width ?? 0) * MEDIA_SOURCE_TO_PREFERENCE_MIN_GAP_RATIO
		);
		await captureSuccessArtifact(page, testInfo, 'toolbar-preference-enabled');

		await preference.click();
		await expect(page).toHaveURL(
			new RegExp(
				`${COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference}=${COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled}`
			)
		);
		await expect(preference).toHaveAttribute('aria-pressed', 'false');

		await source
			.getByRole('link', { name: TERRAFORMS_MEDIA_MODE_OPTIONS.Live.label, exact: true })
			.click();
		await expect(page).toHaveURL(
			new RegExp(`${COLLECTION_MEDIA_QUERY_PARAMS.MediaMode}=${TERRAFORMS_MEDIA_MODES.Live}`)
		);
		await expect(preference).toHaveAttribute('aria-pressed', 'false');
		await captureSuccessArtifact(page, testInfo, 'toolbar-live-preference-disabled');
	});

	test('selects snapshot media from the V2 preference without hiding explicit choices', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page);
		const mediaApi = await installMediaApiMock(page);
		await openHarnessPage(page, COLLECTION_PATH);

		mediaApi.holdNextPreview();
		await page.getByRole('button', { name: `preview token ${TOKEN_ID}` }).click();
		let dialog = page.getByRole('dialog', { name: 'Token Preview' });
		await expect(dialog).toBeVisible();
		const loading = dialog.getByLabel('loading preview');
		await expect(loading).toBeVisible();
		await expectCenteredIn(loading, dialog.locator('.token-preview-box'));
		await captureSuccessArtifact(page, testInfo, 'preview-initial-loading');
		mediaApi.releaseHeldPreview();
		await expectActivePreviewChoice(
			dialog,
			'Preview source',
			COLLECTION_MEDIA_MODE_OPTIONS.Snapshot.label
		);
		await expectActivePreviewChoice(
			dialog,
			'Preview media version',
			TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2Artifact.label
		);
		await expect(
			dialog
				.getByLabel('Preview media version')
				.getByRole('button', { name: TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2LostTerrain.label })
		).toBeVisible();
		await expectPreviewDocument(
			dialog,
			`${COLLECTION_MEDIA_MODES.Snapshot} / ${TERRAFORMS_MEDIA_VARIANTS.V2Artifact}`
		);
		await captureSuccessArtifact(page, testInfo, 'preview-snapshot-preference-enabled');

		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: TERRAFORMS_MEDIA_PREFERENCE_LABEL }).click();
		await page.getByRole('button', { name: `preview token ${TOKEN_ID}` }).click();
		dialog = page.getByRole('dialog', { name: 'Token Preview' });
		await expectActivePreviewChoice(
			dialog,
			'Preview media version',
			TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2.label
		);
		await expectPreviewDocument(
			dialog,
			`${COLLECTION_MEDIA_MODES.Snapshot} / ${TERRAFORMS_MEDIA_VARIANTS.V2}`
		);
		expect(
			mediaApi.requests.filter(
				(request) =>
					request.kind === MEDIA_REQUEST_KIND.Preview &&
					request.tokenId === TOKEN_ID &&
					request.mode === COLLECTION_MEDIA_MODES.Snapshot
			)
		).toHaveLength(2);
		await captureSuccessArtifact(page, testInfo, 'preview-snapshot-preference-disabled');
	});

	test('switches live versions, aligns failed controls with Retry, and never reuses live media', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page);
		const mediaApi = await installMediaApiMock(page);
		await openHarnessPage(page, COLLECTION_PATH);
		await page.getByRole('button', { name: `preview token ${TOKEN_ID}` }).click();

		const dialog = page.getByRole('dialog', { name: 'Token Preview' });
		const source = dialog.getByLabel('Preview source');
		await source.getByRole('button', { name: TERRAFORMS_MEDIA_MODE_OPTIONS.Live.label }).click();
		await expectActivePreviewChoice(
			dialog,
			'Preview source',
			TERRAFORMS_MEDIA_MODE_OPTIONS.Live.label
		);
		await expectActivePreviewChoice(
			dialog,
			'Preview media version',
			TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2.label
		);

		await dialog
			.getByLabel('Preview media version')
			.getByRole('button', { name: TERRAFORMS_MEDIA_VARIANT_OPTIONS.V1.label, exact: true })
			.click();
		await expectActivePreviewChoice(
			dialog,
			'Preview media version',
			TERRAFORMS_MEDIA_VARIANT_OPTIONS.V1.label
		);

		mediaApi.failNextPreviewLiveV0();
		await dialog
			.getByLabel('Preview media version')
			.getByRole('button', { name: TERRAFORMS_MEDIA_VARIANT_OPTIONS.V0.label, exact: true })
			.click();
		await expect(dialog.getByText('Unable to load preview')).toBeVisible();
		await expectActivePreviewChoice(
			dialog,
			'Preview media version',
			TERRAFORMS_MEDIA_VARIANT_OPTIONS.V0.label
		);
		await captureSuccessArtifact(page, testInfo, 'preview-live-v0-error');

		await dialog.getByRole('button', { name: 'retry', exact: true }).click();
		await expectPreviewDocument(
			dialog,
			`${TERRAFORMS_MEDIA_MODES.Live} / ${TERRAFORMS_MEDIA_VARIANTS.V0}`
		);
		await source
			.getByRole('button', { name: COLLECTION_MEDIA_MODE_OPTIONS.Snapshot.label })
			.click();
		await source.getByRole('button', { name: TERRAFORMS_MEDIA_MODE_OPTIONS.Live.label }).click();
		await expectActivePreviewChoice(
			dialog,
			'Preview source',
			TERRAFORMS_MEDIA_MODE_OPTIONS.Live.label
		);

		const uncachedDefaultLiveRequests = mediaApi.requests.filter(
			(request) =>
				request.kind === MEDIA_REQUEST_KIND.Preview &&
				request.tokenId === TOKEN_ID &&
				request.mode === TERRAFORMS_MEDIA_MODES.Live &&
				request.variant === null
		);
		expect(uncachedDefaultLiveRequests).toHaveLength(2);
		await captureSuccessArtifact(page, testInfo, 'preview-live-versions');
	});

	test('keeps token-detail media visible while an exact live request can fail and recover', async ({
		page
	}, testInfo) => {
		await installBiddingAutomationApiMock(page);
		const mediaApi = await installMediaApiMock(page);
		await openHarnessPage(page, TOKEN_DETAIL_PATH);

		const source = page.getByLabel('Token detail source');
		await source.getByRole('button', { name: TERRAFORMS_MEDIA_MODE_OPTIONS.Live.label }).click();
		await expect(page.getByLabel('Token detail media version')).toContainText(
			TERRAFORMS_MEDIA_VARIANT_OPTIONS.V2.label
		);

		mediaApi.failNextDetailLiveV0();
		await page
			.getByLabel('Token detail media version')
			.getByRole('button', { name: TERRAFORMS_MEDIA_VARIANT_OPTIONS.V0.label, exact: true })
			.click();
		await expect(page.getByText('Unable to load media.')).toBeVisible();
		await expect(
			page.getByLabel('Token detail media version').locator('span.secondary-tab-active', {
				hasText: TERRAFORMS_MEDIA_VARIANT_OPTIONS.V0.label
			})
		).toBeVisible();
		await expect(page.getByTitle(`token ${TOKEN_ID}`)).toBeVisible();
		await page.getByRole('button', { name: 'retry loading media', exact: true }).click();
		await expect(page.getByText('Unable to load media.')).toHaveCount(0);
		await expect(page.getByLabel('Token detail media version')).toContainText(
			TERRAFORMS_MEDIA_VARIANT_OPTIONS.V0.label
		);
		await captureSuccessArtifact(page, testInfo, 'token-detail-live-v0');
	});

	test('hides the complete touch control stack when the safe backdrop cannot contain it', async ({
		page
	}, testInfo) => {
		test.skip(
			testInfo.project.name !== TERRAFORMS_MEDIA_E2E_TOUCH_PROJECT,
			'Touch fit applies only to the mobile project.'
		);
		await page.setViewportSize(TERRAFORMS_MEDIA_E2E_CONSTRAINED_VIEWPORT);
		await installBiddingAutomationApiMock(page);
		await installMediaApiMock(page);
		await openHarnessPage(page, COLLECTION_PATH);
		await page.getByRole('button', { name: `preview token ${TOKEN_ID}` }).click();

		const dialog = page.getByRole('dialog', { name: 'Token Preview' });
		const source = dialog.getByLabel('Preview source');
		await expect(source).toBeVisible();
		await page.keyboard.press('0');
		await expect(source).toBeHidden();
		await expect(dialog.getByLabel('Preview media version')).toBeHidden();
		await captureSuccessArtifact(page, testInfo, 'preview-touch-controls-hidden');
	});
});

async function openHarnessPage(page: Page, path: string): Promise<void> {
	await page.goto(path, { waitUntil: 'domcontentloaded' });
	await expect(page.locator('body')).toBeVisible();
}

async function expectActivePreviewChoice(
	dialog: Locator,
	groupLabel: string,
	choice: string
): Promise<void> {
	await expect(
		dialog.getByLabel(groupLabel).getByRole('button', { name: choice, exact: true })
	).toBeDisabled();
}

async function expectPreviewDocument(dialog: Locator, label: string): Promise<void> {
	await expect(dialog.frameLocator('iframe').getByText(label, { exact: true })).toBeVisible();
}

async function expectCenteredIn(content: Locator, container: Locator): Promise<void> {
	const contentBox = await content.boundingBox();
	const containerBox = await container.boundingBox();
	expect(contentBox).not.toBeNull();
	expect(containerBox).not.toBeNull();
	const contentCenterX = (contentBox?.x ?? 0) + (contentBox?.width ?? 0) / 2;
	const contentCenterY = (contentBox?.y ?? 0) + (contentBox?.height ?? 0) / 2;
	const containerCenterX = (containerBox?.x ?? 0) + (containerBox?.width ?? 0) / 2;
	const containerCenterY = (containerBox?.y ?? 0) + (containerBox?.height ?? 0) / 2;
	expect(Math.abs(contentCenterX - containerCenterX)).toBeLessThan(10);
	expect(Math.abs(contentCenterY - containerCenterY)).toBeLessThan(10);
}

async function captureSuccessArtifact(page: Page, testInfo: TestInfo, name: string): Promise<void> {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: false });
	await testInfo.attach(name, {
		path,
		contentType: 'image/png'
	});
}

async function installMediaApiMock(page: Page): Promise<MediaApiMock> {
	const requests: CapturedMediaRequest[] = [];
	let failPreviewLiveV0 = false;
	let failDetailLiveV0 = false;
	let heldPreviewPromise: Promise<void> | null = null;
	let releaseHeldPreview: (() => void) | null = null;

	await page.route(MEDIA_PREVIEW_API_ROUTE_PATTERN, async (route) => {
		const requestUrl = new URL(route.request().url());
		const request = captureMediaRequest(MEDIA_REQUEST_KIND.Preview, requestUrl);
		requests.push(request);
		if (heldPreviewPromise) {
			const hold = heldPreviewPromise;
			heldPreviewPromise = null;
			await hold;
			releaseHeldPreview = null;
		}
		if (failPreviewLiveV0 && isLiveV0Request(request)) {
			failPreviewLiveV0 = false;
			await fulfillMediaError(route);
			return;
		}

		const tokenId = decodeURIComponent(requestUrl.pathname.split('/').at(-2) ?? TOKEN_ID);
		const media = resolveBiddingE2eTokenMedia(requestUrl.searchParams);
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				media,
				token: {
					tokenId,
					image: null,
					animationUrl: mediaDocumentUrl(media.selectedMode, media.selectedVariant)
				}
			})
		});
	});

	await page.route(MEDIA_DETAIL_API_ROUTE_PATTERN, async (route) => {
		const requestUrl = new URL(route.request().url());
		const request = captureMediaRequest(MEDIA_REQUEST_KIND.Detail, requestUrl);
		requests.push(request);
		if (failDetailLiveV0 && isLiveV0Request(request)) {
			failDetailLiveV0 = false;
			await fulfillMediaError(route);
			return;
		}

		const tokenId = decodeURIComponent(requestUrl.pathname.split('/').at(-1) ?? TOKEN_ID);
		const data = buildBiddingE2eTokenDetailData(tokenId, requestUrl.searchParams);
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				chain: BIDDING_E2E_CHAIN,
				collection: BIDDING_E2E_COLLECTION,
				media: data.media,
				token: {
					...data.token,
					animationUrl: mediaDocumentUrl(data.media.selectedMode, data.media.selectedVariant)
				},
				traitFilterPresentation: data.traitFilterPresentation
			})
		});
	});

	return {
		requests,
		holdNextPreview: () => {
			heldPreviewPromise = new Promise<void>((resolve) => {
				releaseHeldPreview = resolve;
			});
		},
		releaseHeldPreview: () => {
			releaseHeldPreview?.();
		},
		failNextPreviewLiveV0: () => {
			failPreviewLiveV0 = true;
		},
		failNextDetailLiveV0: () => {
			failDetailLiveV0 = true;
		}
	};
}

function captureMediaRequest(kind: MediaRequestKind, url: URL): CapturedMediaRequest {
	const tokenId = decodeURIComponent(
		url.pathname.split('/').at(kind === MEDIA_REQUEST_KIND.Preview ? -2 : -1) ?? TOKEN_ID
	);
	return {
		kind,
		tokenId,
		mode: url.searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode),
		preference: url.searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference),
		variant: url.searchParams.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaVariant)
	};
}

function isLiveV0Request(request: CapturedMediaRequest): boolean {
	return (
		request.mode === TERRAFORMS_MEDIA_MODES.Live && request.variant === TERRAFORMS_MEDIA_VARIANTS.V0
	);
}

async function fulfillMediaError(route: Route): Promise<void> {
	await route.fulfill({
		status: 422,
		contentType: 'application/json',
		body: JSON.stringify({ message: MEDIA_REQUEST_ERROR_MESSAGE })
	});
}

function mediaDocumentUrl(mode: string, variant: string | null): string {
	const label = `${mode} / ${variant ?? 'canonical'}`;
	const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:Canvas;color:CanvasText;font:700 1.25rem monospace;text-transform:uppercase}</style></head><body>${label}</body></html>`;
	return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
