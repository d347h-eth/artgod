import {
	expect,
	test,
	type APIRequestContext,
	type Locator,
	type Page,
	type TestInfo
} from 'playwright/test';

const TARGET_PATH = process.env.ARTGOD_E2E_TARGET_PATH?.trim() || '/ethereum/terraforms';
const GEOMETRY_TOLERANCE_PX = 4;

test('opens preview modal within the viewport and closes on backdrop click', async ({
	page,
	request
}, testInfo) => {
	const diagnostics = capturePageDiagnostics(page);

	try {
		await assertAttachedAppReachable(request);

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

async function assertAttachedAppReachable(request: APIRequestContext): Promise<void> {
	let pageResponse;
	try {
		pageResponse = await request.get(TARGET_PATH);
	} catch (cause) {
		throw new Error(
			`Attached preview probe could not reach ${TARGET_PATH}. Start yarn dev first. ${toErrorMessage(cause)}`
		);
	}

	if (!pageResponse.ok()) {
		throw new Error(
			`Attached preview probe got ${pageResponse.status()} for ${TARGET_PATH}. Start yarn dev first.`
		);
	}

	let apiResponse;
	try {
		apiResponse = await request.get('/api/chains/default');
	} catch (cause) {
		throw new Error(
			`Attached preview probe could not reach /api/chains/default through the frontend dev server. Ensure backend/indexer/frontend are all running via yarn dev. ${toErrorMessage(cause)}`
		);
	}

	if (!apiResponse.ok()) {
		throw new Error(
			`Attached preview probe got ${apiResponse.status()} from /api/chains/default. Ensure yarn dev is fully up and healthy.`
		);
	}
}

function capturePageDiagnostics(page: Page): {
	consoleMessages: string[];
	pageErrors: string[];
} {
	const consoleMessages: string[] = [];
	const pageErrors: string[] = [];

	page.on('console', (message) => {
		consoleMessages.push(`[${message.type()}] ${message.text()}`);
	});

	page.on('pageerror', (error) => {
		pageErrors.push(error.stack || error.message);
	});

	return { consoleMessages, pageErrors };
}

async function attachDiagnostics(
	testInfo: TestInfo,
	diagnostics: {
		consoleMessages: string[];
		pageErrors: string[];
	}
): Promise<void> {
	if (diagnostics.consoleMessages.length > 0) {
		await testInfo.attach('browser-console.txt', {
			body: Buffer.from(diagnostics.consoleMessages.join('\n')),
			contentType: 'text/plain'
		});
	}

	if (diagnostics.pageErrors.length > 0) {
		await testInfo.attach('page-errors.txt', {
			body: Buffer.from(diagnostics.pageErrors.join('\n\n')),
			contentType: 'text/plain'
		});
	}
}

async function readPreviewMetrics(page: Page): Promise<PreviewMetrics> {
	return page.evaluate(() => {
		const readRect = (element: HTMLElement) => {
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
			overlay: readRect(overlay),
			box: readRect(box),
			frame: readRect(frame)
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

function toErrorMessage(cause: unknown): string {
	if (cause instanceof Error && cause.message.trim()) {
		return cause.message;
	}
	if (typeof cause === 'string' && cause.trim()) {
		return cause;
	}
	return 'Unknown error';
}

async function readPreviewTriggerAspectRatio(
	previewTrigger: Locator
): Promise<number> {
	const image = previewTrigger.locator('img');
	const naturalAspectRatio = await image.evaluate((node) => {
		if (!(node instanceof HTMLImageElement)) {
			throw new Error('Preview trigger image was not found');
		}
		if (node.naturalWidth <= 0 || node.naturalHeight <= 0) {
			throw new Error('Preview trigger image did not finish loading');
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
