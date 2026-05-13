import { expect, test, type Locator, type Page, type TestInfo } from 'playwright/test';
import { LOCAL_STORAGE_KEYS } from '$lib/local-storage-keys';
import {
	assertAttachedAppReachable,
	attachDiagnostics,
	capturePageDiagnostics
} from './attached-app';

const TARGET_PATH = process.env.ARTGOD_E2E_TARGET_PATH?.trim() || '/ethereum/terraforms';
const GEOMETRY_TOLERANCE_PX = 4;

test('opens preview modal within the viewport and closes on backdrop click', async ({
	page,
	request
}, testInfo) => {
	const diagnostics = capturePageDiagnostics(page);

	try {
		await assertAttachedAppReachable(request, {
			targetPath: TARGET_PATH,
			probeName: 'preview'
		});

		await page.goto(TARGET_PATH, {
			waitUntil: 'domcontentloaded'
		});
		await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');

		const previewTrigger = page.locator('button[aria-label^="preview token "]').first();
		await expect(previewTrigger).toBeVisible();
		const expectedAspectRatio = await readPreviewTriggerAspectRatio(previewTrigger);
		await previewTrigger.click();

		const overlay = page.locator('.token-preview-overlay');
		const box = page.locator('.token-preview-box');
		const frame = page.locator('.token-preview-frame');

		await expect(overlay).toBeVisible();
		await expect(box).toBeVisible();
		await expect(frame).toBeVisible();

		const metrics = await readPreviewMetrics(page);
		assertPreviewMetrics(metrics, expectedAspectRatio, testInfo);

		await testInfo.attach('preview-open.png', {
			body: await page.screenshot({ fullPage: false }),
			contentType: 'image/png'
		});

		const backdropPoint = resolveBackdropClickPoint(metrics);
		await page.mouse.click(backdropPoint.x, backdropPoint.y);

		await expect(overlay).toHaveCount(0);

		await testInfo.attach('preview-closed.png', {
			body: await page.screenshot({ fullPage: false }),
			contentType: 'image/png'
		});
	} catch (error) {
		await attachDiagnostics(testInfo, diagnostics);
		throw error;
	}
});

test('renders token detail media within the viewport without horizontal overflow', async ({
	page,
	request
}, testInfo) => {
	const diagnostics = capturePageDiagnostics(page);

	try {
		await assertAttachedAppReachable(request, {
			targetPath: TARGET_PATH,
			probeName: 'preview'
		});

		await page.goto(TARGET_PATH, {
			waitUntil: 'domcontentloaded'
		});
		await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');

		const tokenCard = page.locator('.token-grid-card').first();
		await expect(tokenCard).toBeVisible();

		const expectedAspectRatio = await readImageNaturalAspectRatio(
			tokenCard.locator('.token-grid-thumb')
		);
		await tokenCard.locator('a.token-grid-id').click();

		await expect(page).toHaveURL(/\/ethereum\/terraforms\/\d+/);

		const mediaBox = page.locator('.token-detail-media-wrap');
		const mediaFrame = page.locator('.token-detail-media-frame');

		await expect(mediaBox).toBeVisible();
		await expect(mediaFrame).toBeVisible();

		await expect
			.poll(
				async () => {
					const metrics = await readTokenDetailMetrics(page);
					return Math.abs(metrics.box.width / metrics.box.height - expectedAspectRatio);
				},
				{
					message: `${testInfo.project.name} token detail media box did not settle to the expected aspect ratio`
				}
			)
			.toBeLessThanOrEqual(0.02);

		const metrics = await readTokenDetailMetrics(page);
		assertTokenDetailMetrics(metrics, expectedAspectRatio, testInfo);

		await testInfo.attach('token-detail-open.png', {
			body: await page.screenshot({ fullPage: false }),
			contentType: 'image/png'
		});
	} catch (error) {
		await attachDiagnostics(testInfo, diagnostics);
		throw error;
	}
});

test('mobile preview hides arrow buttons and persists swipe hint dismissal', async ({
	page,
	request
}, testInfo) => {
	test.skip(
		!['pixel-7', 'iphone-12-pro'].includes(testInfo.project.name),
		'This probe only applies to narrow mobile-emulation projects.'
	);

	const diagnostics = capturePageDiagnostics(page);

	try {
		await assertAttachedAppReachable(request, {
			targetPath: TARGET_PATH,
			probeName: 'preview'
		});
		await page.addInitScript((storageKey) => {
			window.localStorage.removeItem(storageKey);
		}, LOCAL_STORAGE_KEYS.tokenPreviewSwipeHintDismissed);

		await page.goto(TARGET_PATH, {
			waitUntil: 'domcontentloaded'
		});
		await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');

		const previewTrigger = page.locator('button[aria-label^="preview token "]').first();
		await expect(previewTrigger).toBeVisible();
		await previewTrigger.click();

		const overlay = page.locator('.token-preview-overlay');
		await expect(overlay).toBeVisible();
		await expect(page.getByRole('button', { name: 'Previous token preview' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Next token preview' })).toHaveCount(0);

		const swipeHint = page.getByRole('button', { name: 'swipe for navigation' });
		await expect(swipeHint).toBeVisible();
		await swipeHint.tap();
		await expect(swipeHint).toHaveCount(0);

		const metrics = await readPreviewMetrics(page);
		const backdropPoint = resolveBackdropClickPoint(metrics);
		await page.mouse.click(backdropPoint.x, backdropPoint.y);
		await expect(overlay).toHaveCount(0);

		await previewTrigger.click();
		await expect(overlay).toBeVisible();
		await expect(page.getByRole('button', { name: 'swipe for navigation' })).toHaveCount(0);

		await testInfo.attach('preview-swipe-hint-dismissed.png', {
			body: await page.screenshot({ fullPage: false }),
			contentType: 'image/png'
		});
	} catch (error) {
		await attachDiagnostics(testInfo, diagnostics);
		throw error;
	}
});

test('mobile backdrop swipe navigates between adjacent previews', async ({
	page,
	request
}, testInfo) => {
	test.skip(
		!['pixel-7', 'iphone-12-pro'].includes(testInfo.project.name),
		'This probe only applies to narrow mobile-emulation projects.'
	);

	const diagnostics = capturePageDiagnostics(page);

	try {
		await assertAttachedAppReachable(request, {
			targetPath: TARGET_PATH,
			probeName: 'preview'
		});

		await page.goto(TARGET_PATH, {
			waitUntil: 'domcontentloaded'
		});
		await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');

		const previewTrigger = page.locator('button[aria-label^="preview token "]').first();
		await expect(previewTrigger).toBeVisible();
		await previewTrigger.click();

		const overlay = page.locator('.token-preview-overlay');
		const frame = page.locator('.token-preview-frame');
		await expect(overlay).toBeVisible();
		await expect(frame).toBeVisible();

		const originalTitle = await frame.getAttribute('title');
		if (!originalTitle) {
			throw new Error('Preview frame title was missing before swipe navigation');
		}

		const metrics = await readPreviewMetrics(page);
		const swipeLaneY = resolveBackdropSwipeLaneY(metrics);

		await dispatchBackdropSwipe(overlay, {
			startX: metrics.viewport.width - 12,
			endX: 12,
			y: swipeLaneY
		});

		await expect
			.poll(async () => await frame.getAttribute('title'), {
				message: 'Backdrop swipe left should navigate to the next token preview'
			})
			.not.toBe(originalTitle);

		const nextTitle = await frame.getAttribute('title');
		if (!nextTitle) {
			throw new Error('Preview frame title was missing after swipe-to-next');
		}

		await dispatchBackdropSwipe(overlay, {
			startX: 12,
			endX: metrics.viewport.width - 12,
			y: swipeLaneY
		});

		await expect
			.poll(async () => await frame.getAttribute('title'), {
				message: 'Backdrop swipe right should navigate back to the previous token preview'
			})
			.toBe(originalTitle);

		await testInfo.attach('preview-backdrop-swipe.png', {
			body: await page.screenshot({ fullPage: false }),
			contentType: 'image/png'
		});

		expect(nextTitle).not.toBe(originalTitle);
	} catch (error) {
		await attachDiagnostics(testInfo, diagnostics);
		throw error;
	}
});

test('pixel mobile bottom-backdrop swipe navigates with browser touch input', async ({
	page,
	request,
	browserName
}, testInfo) => {
	test.skip(browserName !== 'chromium' || testInfo.project.name !== 'pixel-7');

	const diagnostics = capturePageDiagnostics(page);

	try {
		await assertAttachedAppReachable(request, {
			targetPath: TARGET_PATH,
			probeName: 'preview'
		});
		await page.addInitScript((storageKey) => {
			window.localStorage.removeItem(storageKey);
		}, LOCAL_STORAGE_KEYS.tokenPreviewSwipeHintDismissed);

		await page.goto(TARGET_PATH, {
			waitUntil: 'domcontentloaded'
		});
		await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');

		const previewTrigger = page.locator('button[aria-label^="preview token "]').first();
		await expect(previewTrigger).toBeVisible();
		await previewTrigger.click();

		const overlay = page.locator('.token-preview-overlay');
		const frame = page.locator('.token-preview-frame');
		const swipeHint = page.getByRole('button', { name: 'swipe for navigation' });
		await expect(overlay).toBeVisible();
		await expect(frame).toBeVisible();
		await expect(swipeHint).toBeVisible();

		const originalTitle = await frame.getAttribute('title');
		if (!originalTitle) {
			throw new Error('Preview frame title was missing before browser-touch swipe navigation');
		}

		const metrics = await readPreviewMetrics(page);
		const bottomSwipeY = resolveBottomBackdropSwipeY(metrics);

		await dispatchBrowserTouchSwipe(page, {
			startX: metrics.viewport.width - 12,
			endX: 12,
			y: bottomSwipeY
		});

		await expect
			.poll(async () => await frame.getAttribute('title'), {
				message: 'Bottom-lane browser touch swipe should navigate to the next token preview'
			})
			.not.toBe(originalTitle);
	} catch (error) {
		await attachDiagnostics(testInfo, diagnostics);
		throw error;
	}
});

test('pixel mobile bottom-backdrop tap closes preview with browser touch input', async ({
	page,
	request,
	browserName
}, testInfo) => {
	test.skip(browserName !== 'chromium' || testInfo.project.name !== 'pixel-7');

	const diagnostics = capturePageDiagnostics(page);

	try {
		await assertAttachedAppReachable(request, {
			targetPath: TARGET_PATH,
			probeName: 'preview'
		});

		await page.goto(TARGET_PATH, {
			waitUntil: 'domcontentloaded'
		});
		await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');

		const previewTrigger = page.locator('button[aria-label^="preview token "]').first();
		await expect(previewTrigger).toBeVisible();
		await previewTrigger.click();

		const overlay = page.locator('.token-preview-overlay');
		await expect(overlay).toBeVisible();

		const metrics = await readPreviewMetrics(page);
		const backdropPoint = resolveBackdropClickPoint(metrics);

		await dispatchBrowserTouchTap(page, backdropPoint);
		await expect(overlay).toHaveCount(0);
	} catch (error) {
		await attachDiagnostics(testInfo, diagnostics);
		throw error;
	}
});

async function readPreviewMetrics(page: Page): Promise<PreviewMetrics> {
	return page.evaluate(() => {
		const readRectSnapshot = (element: HTMLElement) => {
			const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
			return { left, top, right, bottom, width, height };
		};

		const overlay = document.querySelector('.token-preview-overlay');
		const box = document.querySelector('.token-preview-box');
		const frame = document.querySelector('.token-preview-frame');

		if (!(overlay instanceof HTMLElement)) {
			throw new Error('Preview overlay was not found');
		}
		if (!(box instanceof HTMLElement)) {
			throw new Error('Preview box was not found');
		}
		if (!(frame instanceof HTMLIFrameElement)) {
			throw new Error('Preview frame was not found');
		}

		return {
			viewport: {
				width: window.innerWidth,
				height: window.innerHeight
			},
			scrollWidth: document.documentElement.scrollWidth,
			scrollHeight: document.documentElement.scrollHeight,
			overlay: readRectSnapshot(overlay),
			box: readRectSnapshot(box),
			frame: readRectSnapshot(frame)
		};
	});
}

async function readTokenDetailMetrics(page: Page): Promise<TokenDetailMetrics> {
	return page.evaluate(() => {
		const readRectSnapshot = (element: HTMLElement) => {
			const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
			return { left, top, right, bottom, width, height };
		};

		const box = document.querySelector('.token-detail-media-wrap');
		const frame = document.querySelector('.token-detail-media-frame');

		if (!(box instanceof HTMLElement)) {
			throw new Error('Token detail media box was not found');
		}
		if (!(frame instanceof HTMLIFrameElement)) {
			throw new Error('Token detail media frame was not found');
		}

		return {
			viewport: {
				width: window.innerWidth,
				height: window.innerHeight
			},
			scrollWidth: document.documentElement.scrollWidth,
			scrollHeight: document.documentElement.scrollHeight,
			box: readRectSnapshot(box),
			frame: readRectSnapshot(frame)
		};
	});
}

function assertPreviewMetrics(
	metrics: PreviewMetrics,
	expectedAspectRatio: number,
	testInfo: TestInfo
): void {
	expect(Math.abs(metrics.overlay.left)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
	expect(Math.abs(metrics.overlay.top)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
	expect(Math.abs(metrics.overlay.width - metrics.viewport.width)).toBeLessThanOrEqual(
		GEOMETRY_TOLERANCE_PX
	);
	expect(Math.abs(metrics.overlay.height - metrics.viewport.height)).toBeLessThanOrEqual(
		GEOMETRY_TOLERANCE_PX
	);

	expect(metrics.box.left).toBeGreaterThanOrEqual(-GEOMETRY_TOLERANCE_PX);
	expect(metrics.box.top).toBeGreaterThanOrEqual(-GEOMETRY_TOLERANCE_PX);
	expect(metrics.box.right).toBeLessThanOrEqual(metrics.viewport.width + GEOMETRY_TOLERANCE_PX);
	expect(metrics.box.bottom).toBeLessThanOrEqual(metrics.viewport.height + GEOMETRY_TOLERANCE_PX);

	const viewportCenterX = metrics.viewport.width / 2;
	const viewportCenterY = metrics.viewport.height / 2;
	const boxCenterX = metrics.box.left + metrics.box.width / 2;
	const boxCenterY = metrics.box.top + metrics.box.height / 2;

	expect(
		Math.abs(boxCenterX - viewportCenterX),
		`${testInfo.project.name} preview box is not horizontally centered`
	).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
	expect(
		Math.abs(boxCenterY - viewportCenterY),
		`${testInfo.project.name} preview box is not vertically centered`
	).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);

	expect(metrics.frame.left).toBeGreaterThanOrEqual(metrics.box.left - GEOMETRY_TOLERANCE_PX);
	expect(metrics.frame.top).toBeGreaterThanOrEqual(metrics.box.top - GEOMETRY_TOLERANCE_PX);
	expect(metrics.frame.right).toBeLessThanOrEqual(metrics.box.right + GEOMETRY_TOLERANCE_PX);
	expect(metrics.frame.bottom).toBeLessThanOrEqual(metrics.box.bottom + GEOMETRY_TOLERANCE_PX);

	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport.width + GEOMETRY_TOLERANCE_PX);

	expect(
		Math.abs(metrics.box.width / metrics.box.height - expectedAspectRatio),
		`${testInfo.project.name} preview box aspect ratio drifted from the trigger media aspect`
	).toBeLessThanOrEqual(0.02);
}

function resolveBackdropClickPoint(metrics: PreviewMetrics): { x: number; y: number } {
	return {
		x: Math.max(4, Math.floor(metrics.box.left / 2)),
		y: Math.max(4, Math.floor(metrics.box.top / 2))
	};
}

function resolveBackdropSwipeLaneY(metrics: PreviewMetrics): number {
	const topBackdropHeight = Math.max(0, metrics.box.top);
	if (topBackdropHeight >= 24) {
		return Math.max(12, Math.floor(topBackdropHeight / 2));
	}

	const bottomBackdropHeight = Math.max(0, metrics.viewport.height - metrics.box.bottom);
	if (bottomBackdropHeight >= 24) {
		return Math.min(
			metrics.viewport.height - 12,
			Math.floor(metrics.box.bottom + bottomBackdropHeight / 2)
		);
	}

	return Math.max(12, Math.floor(metrics.box.top / 2));
}

function resolveBottomBackdropSwipeY(metrics: PreviewMetrics): number {
	const bottomBackdropHeight = Math.max(0, metrics.viewport.height - metrics.box.bottom);
	return Math.min(
		metrics.viewport.height - 12,
		Math.floor(metrics.box.bottom + Math.max(12, bottomBackdropHeight / 2))
	);
}

async function dispatchBackdropSwipe(
	overlay: Locator,
	params: {
		startX: number;
		endX: number;
		y: number;
	}
): Promise<void> {
	const touch = (x: number) => ({
		identifier: 1,
		clientX: x,
		clientY: params.y,
		pageX: x,
		pageY: params.y,
		screenX: x,
		screenY: params.y
	});

	await overlay.dispatchEvent('touchstart', {
		touches: [touch(params.startX)],
		targetTouches: [touch(params.startX)],
		changedTouches: [touch(params.startX)]
	});

	await overlay.dispatchEvent('touchmove', {
		touches: [touch(params.endX)],
		targetTouches: [touch(params.endX)],
		changedTouches: [touch(params.endX)]
	});

	await overlay.dispatchEvent('touchend', {
		touches: [],
		targetTouches: [],
		changedTouches: [touch(params.endX)]
	});
}

async function dispatchBrowserTouchSwipe(
	page: Page,
	params: {
		startX: number;
		endX: number;
		y: number;
	}
): Promise<void> {
	// Browser-level touch input exercises hit-testing and touch-target routing more faithfully than
	// direct synthetic dispatch on the overlay element.
	const session = await page.context().newCDPSession(page);
	const touchPoint = (x: number) => ({
		x,
		y: params.y,
		radiusX: 1,
		radiusY: 1,
		force: 1,
		id: 0
	});

	await session.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [touchPoint(params.startX)]
	});
	await page.waitForTimeout(32);
	await session.send('Input.dispatchTouchEvent', {
		type: 'touchMove',
		touchPoints: [touchPoint(Math.round((params.startX + params.endX) / 2))]
	});
	await page.waitForTimeout(32);
	await session.send('Input.dispatchTouchEvent', {
		type: 'touchMove',
		touchPoints: [touchPoint(params.endX)]
	});
	await page.waitForTimeout(32);
	await session.send('Input.dispatchTouchEvent', {
		type: 'touchEnd',
		touchPoints: []
	});
}

async function dispatchBrowserTouchTap(
	page: Page,
	params: {
		x: number;
		y: number;
	}
): Promise<void> {
	const session = await page.context().newCDPSession(page);
	const touchPoint = {
		x: params.x,
		y: params.y,
		radiusX: 1,
		radiusY: 1,
		force: 1,
		id: 0
	};

	await session.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [touchPoint]
	});
	await page.waitForTimeout(32);
	await session.send('Input.dispatchTouchEvent', {
		type: 'touchEnd',
		touchPoints: []
	});
}

function assertTokenDetailMetrics(
	metrics: TokenDetailMetrics,
	expectedAspectRatio: number,
	testInfo: TestInfo
): void {
	expect(metrics.box.left).toBeGreaterThanOrEqual(-GEOMETRY_TOLERANCE_PX);
	expect(metrics.box.right).toBeLessThanOrEqual(metrics.viewport.width + GEOMETRY_TOLERANCE_PX);
	expect(metrics.box.width).toBeLessThanOrEqual(metrics.viewport.width + GEOMETRY_TOLERANCE_PX);
	expect(metrics.box.height).toBeLessThanOrEqual(metrics.viewport.height + GEOMETRY_TOLERANCE_PX);

	const viewportCenterX = metrics.viewport.width / 2;
	const boxCenterX = metrics.box.left + metrics.box.width / 2;
	expect(
		Math.abs(boxCenterX - viewportCenterX),
		`${testInfo.project.name} token detail media box is not horizontally centered`
	).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);

	expect(metrics.frame.left).toBeGreaterThanOrEqual(metrics.box.left - GEOMETRY_TOLERANCE_PX);
	expect(metrics.frame.top).toBeGreaterThanOrEqual(metrics.box.top - GEOMETRY_TOLERANCE_PX);
	expect(metrics.frame.right).toBeLessThanOrEqual(metrics.box.right + GEOMETRY_TOLERANCE_PX);
	expect(metrics.frame.bottom).toBeLessThanOrEqual(metrics.box.bottom + GEOMETRY_TOLERANCE_PX);

	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport.width + GEOMETRY_TOLERANCE_PX);
	expect(
		Math.abs(metrics.box.width / metrics.box.height - expectedAspectRatio),
		`${testInfo.project.name} token detail media box aspect ratio drifted from the token image aspect`
	).toBeLessThanOrEqual(0.02);
}

async function readPreviewTriggerAspectRatio(previewTrigger: Locator): Promise<number> {
	return readImageNaturalAspectRatio(previewTrigger.locator('img'));
}

async function readImageNaturalAspectRatio(image: Locator): Promise<number> {
	const naturalAspectRatio = await image.evaluate((node) => {
		if (!(node instanceof HTMLImageElement)) {
			throw new Error('Token image was not found');
		}
		if (node.naturalWidth <= 0 || node.naturalHeight <= 0) {
			throw new Error('Token image did not finish loading');
		}
		return node.naturalWidth / node.naturalHeight;
	});

	if (!Number.isFinite(naturalAspectRatio) || naturalAspectRatio <= 0) {
		throw new Error('Preview trigger image aspect ratio is invalid');
	}

	return naturalAspectRatio;
}

type RectSnapshot = {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
};

type PreviewMetrics = {
	viewport: {
		width: number;
		height: number;
	};
	scrollWidth: number;
	scrollHeight: number;
	overlay: RectSnapshot;
	box: RectSnapshot;
	frame: RectSnapshot;
};

type TokenDetailMetrics = {
	viewport: {
		width: number;
		height: number;
	};
	scrollWidth: number;
	scrollHeight: number;
	box: RectSnapshot;
	frame: RectSnapshot;
};
