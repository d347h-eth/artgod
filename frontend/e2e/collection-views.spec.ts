import { expect, test } from 'playwright/test';
import { installBiddingAutomationApiMock } from './helpers/bidding-automation-api';
import { buildBiddingE2eCollectionDetailData } from '../src/lib/e2e/bidding-automation-fixtures';
import { TEST_IDS } from '../src/lib/test-ids';
import {
	TRAIT_CATALOG_REBUILD_STATUS as Status,
	type TraitCatalogRebuild,
	TRAIT_CATALOG_QUERY,
	type CollectionViewStatus
} from '@artgod/shared/types/trait-catalog';
import { TRAIT_FILTER_DISPLAY_KIND } from '@artgod/shared/types';

test('opens the full collection and preserves the selected block when drafting an artwork bid', async ({
	page
}, testInfo) => {
	const pinned = { key: 'collection block', value: 'DriMi' };
	const background = { key: '01 Background', value: 'blue' };
	const fixture = buildBiddingE2eCollectionDetailData(new URLSearchParams());
	const path = '/' + fixture.chain.slug + '/' + fixture.collection.slug;
	const block: CollectionViewStatus = {
		id: 'block-a',
		label: 'DriMi',
		parent: { id: 'a', label: 'Artworks' },
		pinnedTraits: [pinned],
		generation: 1,
		activeMapperVersion: 'test',
		availableMapperVersion: 'test',
		ready: 2,
		classified: 2
	};
	const egg = {
		...block,
		id: 'egg',
		label: 'Eggs',
		parent: null,
		pinnedTraits: [{ key: 'type', value: 'egg' }]
	};
	const dataReads: string[] = [];
	const collection = { ...fixture.collection, extensions: [], activityEventFeeds: [] };
	let latestRun: TraitCatalogRebuild | null = null;
	let publishedGeneration = 1;
	let viewsAvailable = false;
	let interruptStart = true;
	let interruptProgress = true;
	const rebuildRequests: unknown[] = [];
	await page.route('**/api/**', (route) =>
		route.fulfill({ status: 404, json: { message: 'Unexpected fixture request' } })
	);
	await installBiddingAutomationApiMock(page);
	await page.route('**/api/runtime/config', (route) =>
		route.fulfill({ json: { bidding: { trustOpenSeaSignedZoneTraitOffers: true } } })
	);
	await page.route('**/collection-views*', (route) => {
		const query = new URL(route.request().url()).searchParams;
		const groupId = query.get(TRAIT_CATALOG_QUERY.Group);
		return route.fulfill({
			json: {
				required: true,
				selectedViewId: query.get(TRAIT_CATALOG_QUERY.View),
				...(groupId && { selectedGroupId: groupId }),
				collection,
				views: viewsAvailable ? [{ ...block, generation: publishedGeneration, latestRun }, egg] : []
			}
		});
	});
	await page.route(
		(url) => url.pathname === '/api' + path + '/customization',
		(route) => route.fulfill({ json: { chain: fixture.chain, collection, customization: null } })
	);
	await page.route('**/trait-catalog/rebuilds?*', (route) => {
		if (interruptStart) {
			interruptStart = false;
			return route.fulfill({ status: 503, json: { message: 'fixture unavailable' } });
		}
		expect(new URL(route.request().url()).searchParams.get(TRAIT_CATALOG_QUERY.View)).toBe(
			block.id
		);
		rebuildRequests.push(route.request().postDataJSON());
		latestRun = {
			viewId: block.id,
			runId: 9,
			mapperVersion: block.availableMapperVersion,
			generation: 2,
			status: Status.Running,
			processed: 0,
			total: 2,
			error: null
		};
		return route.fulfill({ json: { rebuild: latestRun } });
	});
	await page.route('**/trait-catalog/rebuilds/9', (route) => {
		if (interruptProgress) {
			interruptProgress = false;
			return route.fulfill({ status: 429, json: { message: 'fixture rate limit' } });
		}
		const completed = rebuildRequests.length === 2;
		if (completed) publishedGeneration = 2;
		latestRun = {
			...latestRun!,
			status: completed ? Status.Completed : Status.Failed,
			processed: completed ? 2 : 1,
			error: completed ? null : 'fixture failure'
		};
		return route.fulfill({ json: { rebuild: latestRun } });
	});
	await page.route(
		(url) => url.pathname === '/api' + path,
		(route) => {
			const query = new URL(route.request().url()).searchParams;
			dataReads.push(
				query.get(TRAIT_CATALOG_QUERY.View) ?? query.get(TRAIT_CATALOG_QUERY.Group) ?? ''
			);
			const data = buildBiddingE2eCollectionDetailData(query);
			return route.fulfill({
				json: {
					...data,
					collection,
					media: {
						selectedMode: 'snapshot',
						defaultMode: 'snapshot',
						availableModes: [{ key: 'snapshot', label: 'Snapshot' }],
						preference: null
					},
					traits: {
						selected: data.selectedTraits,
						selectedRanges: [],
						facets: [
							{
								key: 'Background',
								nativeKey: background.key,
								displayKind: TRAIT_FILTER_DISPLAY_KIND.Set,
								minValue: null,
								maxValue: null,
								values: [
									{
										value: 'blue',
										native: background,
										tokenCount: 2,
										marketplaceBiddingSupported: true
									}
								]
							}
						]
					}
				}
			});
		}
	);
	// Enter through client navigation so all backend traffic stays inside the browser fixture.
	await page.goto('/e2e-harness/collection');
	await expect(page.locator('html')).toHaveAttribute('data-artgod-hydrated', '1');
	await page.evaluate((path) => {
		const link = document.createElement('a');
		link.href = path;
		document.body.append(link);
		link.click();
		link.remove();
	}, `${path}?limit=2&media_mode=snapshot`);
	const kinds = page.getByRole('group', { name: 'Token kind' });
	const blocks = page.getByRole('combobox', { name: 'Collection block' });
	const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
	await expect(refresh).toBeVisible();
	await expect(kinds.locator('[aria-current="true"]')).toHaveText('All');
	await page.screenshot({ path: testInfo.outputPath('waiting-for-traits.png') });
	viewsAvailable = true;
	await refresh.click();
	await expect(kinds).toBeVisible();
	await expect(refresh).toHaveCount(0);
	expect(dataReads).toContain('');
	await kinds.getByRole('link', { name: 'Artworks', exact: true }).click();
	await blocks.selectOption({ label: 'DriMi' });
	await expect(page).toHaveURL(
		(url) => url.searchParams.get(TRAIT_CATALOG_QUERY.View) === block.id
	);
	await expect(blocks).toHaveValue(block.id);
	const firstSelection = new URL(page.url());
	expect(firstSelection.searchParams.get('media_mode')).toBe('snapshot');
	expect(firstSelection.searchParams.get('limit')).toBe('2');
	expect(firstSelection.searchParams.has('traits')).toBe(false);
	expect(firstSelection.searchParams.has('cursor')).toBe(false);
	await expect(page.getByRole('button', { name: 'bid on traits', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'expand traits panel' }).click();
	await page.locator('details > summary').filter({ hasText: 'Background' }).click();
	await page.getByRole('checkbox', { name: /blue/ }).check();
	const lookup = page.waitForRequest(
		(r) => r.url().includes('/bidding/jobs/target-lookup') && r.method() === 'POST'
	);
	await page.getByRole('button', { name: 'bid on traits', exact: true }).click();
	expect((await lookup).postDataJSON().target.targetTraits).toEqual(
		expect.arrayContaining([
			{ type: pinned.key, value: pinned.value },
			{ type: background.key, value: background.value }
		])
	);
	await page.screenshot({ path: testInfo.outputPath('drimi-draft.png') });
	await page.locator('#bidding-automation-floor').fill('0.31');
	await page.locator('#bidding-automation-ceiling').fill('0.41');
	await page.locator('#bidding-automation-delta').fill('0.004');
	const create = page.getByTestId(TEST_IDS.BiddingPanelCreate);
	await create.click();
	const saved = page.waitForRequest(
		(r) => r.method() === 'PUT' && r.url().endsWith('/bidding/jobs/traits')
	);
	await create.click();
	expect((await saved).postDataJSON().targetTraits).toEqual(
		expect.arrayContaining([
			{ type: pinned.key, value: pinned.value },
			{ type: background.key, value: background.value }
		])
	);
	await page
		.getByRole('dialog', { name: 'bidding automation' })
		.getByRole('button', { name: 'hide' })
		.click();

	await kinds.getByRole('link', { name: 'Eggs', exact: true }).click();
	await expect(kinds.locator('[aria-current="true"]')).toHaveText('Eggs');
	await expect(page).toHaveURL((url) => url.searchParams.get(TRAIT_CATALOG_QUERY.View) === egg.id);
	expect(new URL(page.url()).searchParams.has('traits')).toBe(false);
	await page.goBack();
	await expect(page).toHaveURL(
		(url) => url.searchParams.get(TRAIT_CATALOG_QUERY.View) === block.id
	);
	await expect(blocks).toHaveValue(block.id);
	await kinds.getByRole('link', { name: 'Eggs', exact: true }).click();
	await expect(kinds.locator('[aria-current="true"]')).toHaveText('Eggs');
	await expect(page).toHaveURL((url) => url.searchParams.get(TRAIT_CATALOG_QUERY.View) === egg.id);
	const eggQuery = new URL(page.url()).searchParams;
	await kinds.getByRole('link', { name: 'Artworks', exact: true }).click();
	await expect(page.getByRole('button', { name: 'bid on traits', exact: true })).toHaveCount(0);
	await blocks.selectOption({ label: 'DriMi' });
	await expect(page).toHaveURL(
		(url) => url.searchParams.get(TRAIT_CATALOG_QUERY.View) === block.id
	);
	await expect(blocks).toHaveValue(block.id);
	const artworkQuery = new URL(page.url()).searchParams;
	expect(artworkQuery.get('media_mode')).toBe(eggQuery.get('media_mode'));
	expect(artworkQuery.get('limit')).toBe(eggQuery.get('limit'));
	expect(dataReads).toContain(block.parent!.id);
	await page.getByRole('link', { name: 'customization', exact: true }).click();
	const rebuild = page.getByRole('button', { name: 'Rebuild traits' });
	await rebuild.click();
	await expect(page.getByRole('alert')).toHaveText('Could not start the rebuild.');
	const retry = page.getByRole('button', { name: 'Retry rebuild' });
	await retry.click();
	await expect(page.getByRole('status').filter({ hasText: 'running' })).toBeVisible();
	const interrupted = page
		.getByRole('alert')
		.filter({ hasText: 'Could not load rebuild progress.' });
	await expect(interrupted).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('retry-rebuild-progress.png') });
	await interrupted.getByRole('button', { name: 'Retry', exact: true }).click();
	await expect(interrupted).toHaveCount(0);
	await expect(retry).toBeEnabled();
	await page.screenshot({ path: testInfo.outputPath('failed-rebuild.png') });
	await retry.click();
	await expect(page.getByRole('status').filter({ hasText: 'completed' })).toBeVisible();
	await expect(page).toHaveURL(
		(url) => url.searchParams.get(TRAIT_CATALOG_QUERY.Generation) === '2'
	);
	expect(rebuildRequests).toEqual([
		{ mapperVersion: block.availableMapperVersion },
		{ mapperVersion: block.availableMapperVersion, retryRunId: 9 }
	]);
	await page.screenshot({ path: testInfo.outputPath('published-catalog.png') });
	await kinds.getByRole('link', { name: 'Eggs', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Derived traits', exact: true })).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: 'completed' })).toHaveCount(0);
});
