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

test('requires a leaf and preserves its native predicate when drafting an artwork bid', async ({
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
		return route.fulfill({
			json: {
				required: true,
				selectedViewId: query.get(TRAIT_CATALOG_QUERY.View),
				collection,
				views: [{ ...block, generation: publishedGeneration, latestRun }, egg]
			}
		});
	});
	await page.route('**/customization?*', (route) =>
		route.fulfill({ json: { chain: fixture.chain, collection, customization: null } })
	);
	await page.route('**/trait-catalog/rebuilds?*', (route) => {
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
			dataReads.push(query.get(TRAIT_CATALOG_QUERY.View) ?? '');
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
	}, `${path}?limit=2&media_mode=snapshot&traits=stale:value&cursor=old`);
	await expect(page.getByLabel('Token kind')).toBeVisible();
	expect(dataReads).toEqual([]);
	await page.getByLabel('Token kind').selectOption({ label: 'Artworks' });
	await page.getByLabel('Collection block').selectOption({ label: 'DriMi' });
	await expect(page.getByText('collection block = DriMi', { exact: true })).toBeVisible();
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

	await page.getByLabel('Token kind').selectOption({ label: 'Eggs' });
	await expect(page.getByText('type = egg', { exact: true })).toBeVisible();
	expect(new URL(page.url()).searchParams.has('traits')).toBe(false);
	await page.goBack();
	await expect(page.getByText('collection block = DriMi', { exact: true })).toBeVisible();
	await page.getByLabel('Token kind').selectOption({ label: 'Eggs' });
	await expect(page.getByText('type = egg', { exact: true })).toBeVisible();
	const eggQuery = new URL(page.url()).searchParams;
	await page.getByLabel('Token kind').selectOption({ label: 'Artworks' });
	await expect(page.getByRole('button', { name: 'bid on traits', exact: true })).toHaveCount(0);
	await page.getByLabel('Collection block').selectOption({ label: 'DriMi' });
	await expect(page.getByText('collection block = DriMi', { exact: true })).toBeVisible();
	const artworkQuery = new URL(page.url()).searchParams;
	expect(artworkQuery.get('media_mode')).toBe(eggQuery.get('media_mode'));
	expect(artworkQuery.get('limit')).toBe(eggQuery.get('limit'));
	expect(dataReads).not.toContain('');
	await page.getByRole('link', { name: 'customization', exact: true }).click();
	await page.getByRole('button', { name: 'Rebuild traits' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'running' })).toBeVisible();
	await page.getByRole('button', { name: 'Retry rebuild' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'completed' })).toBeVisible();
	expect(new URL(page.url()).searchParams.get(TRAIT_CATALOG_QUERY.Generation)).toBe('2');
	expect(rebuildRequests).toEqual([
		{ mapperVersion: block.availableMapperVersion },
		{ mapperVersion: block.availableMapperVersion, retryRunId: 9 }
	]);
	await page.screenshot({ path: testInfo.outputPath('published-catalog.png') });
});
