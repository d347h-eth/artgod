import type { APIRequestContext, Page, TestInfo } from 'playwright/test';

export type PageDiagnostics = {
	consoleMessages: string[];
	pageErrors: string[];
};

export type PageDiagnosticsRegistry = Map<string, PageDiagnostics>;

export function capturePageDiagnostics(page: Page): PageDiagnostics {
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

export async function attachDiagnostics(
	testInfo: TestInfo,
	diagnostics: PageDiagnostics
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

// Starts per-test browser diagnostics capture so failures include console/page errors.
export function captureDiagnosticsForTest(
	registry: PageDiagnosticsRegistry,
	page: Page,
	testInfo: TestInfo
): void {
	registry.set(testInfo.testId, capturePageDiagnostics(page));
}

// Attaches captured browser diagnostics only when the current Playwright test failed.
export async function attachDiagnosticsForTestFailure(
	registry: PageDiagnosticsRegistry,
	testInfo: TestInfo
): Promise<void> {
	const diagnostics = registry.get(testInfo.testId);
	registry.delete(testInfo.testId);
	if (!diagnostics || testInfo.status === testInfo.expectedStatus) return;
	await attachDiagnostics(testInfo, diagnostics);
}

export async function assertAttachedAppReachable(
	request: APIRequestContext,
	params: {
		targetPath: string;
		probeName: string;
	}
): Promise<void> {
	let pageResponse;
	try {
		// Probe the target page through the attached frontend dev server before driving the UI.
		pageResponse = await request.get(params.targetPath);
	} catch (cause) {
		throw new Error(
			`Attached ${params.probeName} probe could not reach ${params.targetPath}. Start yarn dev first. ${toErrorMessage(cause)}`
		);
	}

	if (!pageResponse.ok()) {
		throw new Error(
			`Attached ${params.probeName} probe got ${pageResponse.status()} for ${params.targetPath}. Start yarn dev first.`
		);
	}

	let apiResponse;
	try {
		// Confirm the backend API is reachable through the same dev-server origin.
		apiResponse = await request.get('/api/chains/default');
	} catch (cause) {
		throw new Error(
			`Attached ${params.probeName} probe could not reach /api/chains/default through the frontend dev server. Ensure backend/indexer/frontend are all running via yarn dev. ${toErrorMessage(cause)}`
		);
	}

	if (!apiResponse.ok()) {
		throw new Error(
			`Attached ${params.probeName} probe got ${apiResponse.status()} from /api/chains/default. Ensure yarn dev is fully up and healthy.`
		);
	}
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
