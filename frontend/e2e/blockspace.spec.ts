import { expect, test } from 'playwright/test';
import { BLOCKSPACE_CONTEXT_ANY, BLOCKSPACE_QUERY_PARAMS } from '@artgod/shared/config/blockspace';
import {
	BLOCKSPACE_E2E,
	blockspaceFixtureUseCase,
	buildBlockspaceE2EState
} from './blockspace-fixtures';
import { formatBlockspacePageStackEntry } from '../src/lib/blockspace-page-stack';
import { BLOCKSPACE_BLOCK_MARKER } from '../src/lib/blockspace-isometric-levels';

test.beforeEach(async ({ page }) => {
	await page.route(BLOCKSPACE_E2E.apiPattern, async (route) => {
		const url = new URL(route.request().url());
		const params = url.searchParams;
		const pageParams = new URL(page.url()).searchParams;
		for (const key of Object.values(BLOCKSPACE_E2E.query)) {
			if (pageParams.has(key)) params.set(key, pageParams.get(key)!);
		}
		const json = url.pathname.endsWith('/range')
			? await blockspaceFixtureUseCase(params).getRangeSummary({
					chainRef: 'ethereum',
					collectionRef: params.get(BLOCKSPACE_QUERY_PARAMS.Collection),
					fromBlock: Number(params.get(BLOCKSPACE_QUERY_PARAMS.FromBlock)),
					toBlock: Number(params.get(BLOCKSPACE_QUERY_PARAMS.ToBlock))
				})
			: await buildBlockspaceE2EState(params);
		await route.fulfill({ json });
	});
});

test('shows both markers in the collection map and switches cleanly to chain coverage', async ({
	page
}, testInfo) => {
	const params = new URLSearchParams({
		[BLOCKSPACE_QUERY_PARAMS.Collection]: BLOCKSPACE_E2E.collections[0]
	});
	await page.goto(BLOCKSPACE_E2E.path + '?' + params);
	await page.evaluate(() => document.fonts.ready);
	const deployment = page.locator(`.${BLOCKSPACE_BLOCK_MARKER.Deployment.className}`);
	const anchor = page.locator(`.${BLOCKSPACE_BLOCK_MARKER.BootstrapAnchor.className}`);
	await expect(deployment).toHaveText('❀');
	await expect(anchor).toHaveText('⫯');
	await expect(
		page.locator(`.${BLOCKSPACE_BLOCK_MARKER.BootstrapAnchor.unsyncedTileClassName}`)
	).toHaveAttribute('aria-label', /anchor block .* not synced/);
	const left = await deployment.boundingBox(),
		right = await anchor.boundingBox();
	expect(left).not.toBeNull();
	expect(right).not.toBeNull();
	expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.width);
	expect(await anchor.evaluate((element) => getComputedStyle(element).fontFamily)).toContain(
		'Mathcastles Remix'
	);
	expect(await anchor.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
	expect(await anchor.evaluate((element) => getComputedStyle(element).fill)).toBe(
		await deployment.evaluate((element) => getComputedStyle(element).fill)
	);
	await page.screenshot({ path: testInfo.outputPath('collection-anchors.png'), fullPage: true });
	await page
		.getByRole('combobox', { name: 'context', exact: true })
		.selectOption(BLOCKSPACE_CONTEXT_ANY);
	await expect(anchor).toHaveCount(0);
	await expect(deployment).toHaveCount(0);
	await expect(page.locator('.blockspace-isometric-tile-complete').first()).toBeVisible();
	await page
		.getByRole('combobox', { name: 'context', exact: true })
		.selectOption(BLOCKSPACE_E2E.collections[1]);
	await expect(anchor).toHaveCount(1);
	await expect(
		page.locator(`.${BLOCKSPACE_BLOCK_MARKER.BootstrapAnchor.unsyncedTileClassName}`)
	).toHaveAttribute('aria-label', /24,000,400/);
});

test('keeps the anchor available through drilling and backfill selection', async ({
	page
}, testInfo) => {
	const params = new URLSearchParams({
		[BLOCKSPACE_QUERY_PARAMS.Collection]: BLOCKSPACE_E2E.collections[0]
	});
	await page.goto(BLOCKSPACE_E2E.path + '?' + params);
	await page
		.locator(`.${BLOCKSPACE_BLOCK_MARKER.BootstrapAnchor.unsyncedTileClassName}`)
		.press('Enter');
	await expect(
		page.getByRole('region', { name: 'L1 blockspace level', exact: true })
	).toBeVisible();
	await page
		.getByRole('region', { name: 'L1 blockspace level', exact: true })
		.locator(`.${BLOCKSPACE_BLOCK_MARKER.BootstrapAnchor.unsyncedTileClassName}`)
		.press('Enter');
	const leaf = page.getByRole('region', { name: 'L2 blockspace level', exact: true });
	await expect(leaf.locator(`.${BLOCKSPACE_BLOCK_MARKER.BootstrapAnchor.className}`)).toHaveText(
		'⫯'
	);
	const target = leaf.locator(`.${BLOCKSPACE_BLOCK_MARKER.BootstrapAnchor.unsyncedTileClassName}`);
	await expect(target).toHaveAttribute(
		'aria-label',
		/block 24,000,200: 0\/1 synced.*anchor block 24,000,200 not synced/
	);
	await page.getByRole('button', { name: 'backfill range', exact: true }).click();
	await target.press('Enter');
	await target.press('Enter');
	await expect(page.getByRole('button', { name: 'commit to backfill', exact: true })).toBeEnabled();
	await expect(target).toHaveClass(/blockspace-isometric-tile-selected/);
	await expect(leaf.locator(`.${BLOCKSPACE_BLOCK_MARKER.BootstrapAnchor.className}`)).toHaveText(
		'⫯'
	);
	await page.screenshot({
		path: testInfo.outputPath('anchor-backfill-selection.png'),
		fullPage: true
	});
});

test('shows synced coincident deployment and anchor markers without overlap', async ({
	page
}, testInfo) => {
	const rootBucket = 1024 * 1024;
	const stack = [
		{
			pageStartBlock: Math.floor(BLOCKSPACE_E2E.deployment / rootBucket) * rootBucket,
			bucketSize: 1024
		},
		{ pageStartBlock: Math.floor(BLOCKSPACE_E2E.deployment / 1024) * 1024, bucketSize: 1 }
	]
		.map(formatBlockspacePageStackEntry)
		.join(',');
	const params = new URLSearchParams({
		stack,
		[BLOCKSPACE_QUERY_PARAMS.Collection]: BLOCKSPACE_E2E.collections[0]
	});
	params.set(BLOCKSPACE_E2E.query.coincident, '1');
	params.set(BLOCKSPACE_E2E.query.coverage, BLOCKSPACE_E2E.coverage.both);
	await page.goto(BLOCKSPACE_E2E.path + '?' + params);
	await page.evaluate(() => document.fonts.ready);
	const leaf = page.getByRole('region', { name: 'L2 blockspace level', exact: true });
	const target = leaf.locator(`.${BLOCKSPACE_BLOCK_MARKER.BootstrapAnchor.syncedTileClassName}`);
	await expect(target).toHaveClass(/blockspace-isometric-tile-deployment-synced/);
	await expect(target).toHaveAttribute(
		'aria-label',
		/deployment block 24,000,100 synced, anchor block 24,000,100 synced/
	);
	const deployment = leaf.locator(`.${BLOCKSPACE_BLOCK_MARKER.Deployment.className}`);
	const anchor = leaf.locator(`.${BLOCKSPACE_BLOCK_MARKER.BootstrapAnchor.className}`);
	const left = await deployment.boundingBox(),
		right = await anchor.boundingBox();
	expect(left).not.toBeNull();
	expect(right).not.toBeNull();
	expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.width);
	await page.screenshot({ path: testInfo.outputPath('coincident-anchors.png'), fullPage: true });
});
