import { expect, test } from 'playwright/test';
import {
	APP_DEPLOYMENT_MODE,
	PUBLIC_APP_DEPLOYMENT_ENV_KEY
} from '@artgod/shared/config/deployment';
import {
	QUERY_CACHE_DEBUG_HEADER_NAME,
	QUERY_CACHE_DEBUG_STATUSES
} from '@artgod/shared/observability/http';
import {
	assertAttachedAppReachable,
	attachDiagnostics,
	capturePageDiagnostics
} from './attached-app';

test('renders the public collection blockspace and reuses cached reads after reload', async ({
	page,
	request
}, testInfo) => {
	const chainRef = process.env[PUBLIC_APP_DEPLOYMENT_ENV_KEY.ChainRef]?.trim();
	const collectionRef = process.env[PUBLIC_APP_DEPLOYMENT_ENV_KEY.CollectionRef]?.trim();
	if (
		process.env[PUBLIC_APP_DEPLOYMENT_ENV_KEY.Mode] !==
			APP_DEPLOYMENT_MODE.PublicSingleCollection ||
		!chainRef ||
		!collectionRef
	) {
		throw new Error(
			'Set public single-collection deployment mode and scope before this attached test.'
		);
	}

	const diagnostics = capturePageDiagnostics(page);
	const apiPath = `/api/${encodeURIComponent(chainRef)}/blockspace`;
	const cacheHeader = QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase();
	try {
		await assertAttachedAppReachable(request, {
			targetPath: '/blockspace',
			probeName: 'public blockspace'
		});
		await page.goto('/blockspace');
		await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');
		await expect(
			page.getByLabel('Blockspace coverage grid', { exact: true }).first()
		).toBeVisible();
		await expect(page.getByRole('combobox', { name: 'context', exact: true })).toHaveCount(0);

		const state = await request.get(apiPath);
		expect(state.ok()).toBe(true);
		expect((await state.json()).context.selected).toBe(collectionRef);
		// A stale generation may be replaced between reads; wait for a completed response-cache entry.
		await expect
			.poll(async () => (await request.get(apiPath)).headers()[cacheHeader])
			.toBe(QUERY_CACHE_DEBUG_STATUSES.Hit);

		const reloadedState = page.waitForResponse(
			(response) => new URL(response.url()).pathname === apiPath
		);
		await page.reload();
		const response = await reloadedState;
		expect(response.ok()).toBe(true);
		expect(response.headers()[cacheHeader]).toBe(QUERY_CACHE_DEBUG_STATUSES.Hit);
		await expect(
			page.getByLabel('Blockspace coverage grid', { exact: true }).first()
		).toBeVisible();
		expect(diagnostics.pageErrors).toEqual([]);
		const screenshotPath = testInfo.outputPath('public-blockspace.png');
		await page.screenshot({ path: screenshotPath, fullPage: true });
		await testInfo.attach('public-blockspace.png', {
			path: screenshotPath,
			contentType: 'image/png'
		});
	} catch (cause) {
		await attachDiagnostics(testInfo, diagnostics);
		throw cause;
	}
});
