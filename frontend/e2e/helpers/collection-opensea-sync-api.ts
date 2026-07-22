import type { Page, Request, Route } from 'playwright/test';
import { API_CSRF_ROUTE_PATH } from '@artgod/shared/http/api-security';
import { OPENSEA_COLLECTION_SLUG_PROBE_STATUS } from '@artgod/shared/opensea/collection-slug-probe';
import {
	buildProbeCollectionOpenSeaSlugPath,
	buildStartCollectionOpenSeaSyncPath,
	COLLECTION_API_QUERY_PARAM
} from '@artgod/shared/http/collection-routes';
import { OPENSEA_COLLECTION_STATUS } from '@artgod/shared/types';
import {
	COLLECTION_OPENSEA_SYNC_E2E_CHAIN,
	COLLECTION_OPENSEA_SYNC_E2E_COLLECTION,
	COLLECTION_OPENSEA_SYNC_E2E_ROUTE_PATH,
	COLLECTION_OPENSEA_SYNC_E2E_SLUG
} from '../../src/lib/e2e/collection-opensea-sync-fixtures';

export { COLLECTION_OPENSEA_SYNC_E2E_ROUTE_PATH };

const COLLECTION_OPENSEA_SYNC_PROBE_PATH = buildProbeCollectionOpenSeaSlugPath({
	chainRef: COLLECTION_OPENSEA_SYNC_E2E_CHAIN.slug,
	collectionRef: COLLECTION_OPENSEA_SYNC_E2E_COLLECTION.slug
});
const COLLECTION_OPENSEA_SYNC_START_PATH = buildStartCollectionOpenSeaSyncPath({
	chainRef: COLLECTION_OPENSEA_SYNC_E2E_CHAIN.slug,
	collectionRef: COLLECTION_OPENSEA_SYNC_E2E_COLLECTION.slug
});

export type CollectionOpenSeaSyncApiMock = {
	probeSlugs: Array<string | null>;
	syncSlugs: string[];
};

// Serves the collection-specific probe and start endpoints used by the modal journey.
export async function installCollectionOpenSeaSyncApiMock(
	page: Page
): Promise<CollectionOpenSeaSyncApiMock> {
	const probeSlugs: Array<string | null> = [];
	const syncSlugs: string[] = [];

	await page.route('**/api/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());

		if (request.method() === 'GET' && url.pathname === API_CSRF_ROUTE_PATH) {
			await fulfillJson(route, { token: 'collection-opensea-sync-e2e-csrf' });
			return;
		}

		if (request.method() === 'GET' && url.pathname === COLLECTION_OPENSEA_SYNC_PROBE_PATH) {
			const requestedSlug = normalizeSlug(
				url.searchParams.get(COLLECTION_API_QUERY_PARAM.OpenSeaSlug)
			);
			probeSlugs.push(requestedSlug);
			const confirmed =
				requestedSlug === null || requestedSlug === COLLECTION_OPENSEA_SYNC_E2E_SLUG;
			await fulfillJson(route, {
				chain: COLLECTION_OPENSEA_SYNC_E2E_CHAIN,
				address: COLLECTION_OPENSEA_SYNC_E2E_COLLECTION.address,
				requestedSlug,
				status: confirmed
					? OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Found
					: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Missing,
				slug: confirmed ? COLLECTION_OPENSEA_SYNC_E2E_SLUG : null,
				reason: confirmed ? null : "Check this collection's OpenSea slug, then resolve again"
			});
			return;
		}

		if (request.method() === 'POST' && url.pathname === COLLECTION_OPENSEA_SYNC_START_PATH) {
			const body = requestBody(request) as { openseaSlug?: unknown };
			const openseaSlug = normalizeSlug(body.openseaSlug);
			if (!openseaSlug) {
				await fulfillJson(route, { message: 'openseaSlug is required' }, 400);
				return;
			}
			syncSlugs.push(openseaSlug);
			await fulfillJson(route, {
				chain: COLLECTION_OPENSEA_SYNC_E2E_CHAIN,
				collection: {
					...COLLECTION_OPENSEA_SYNC_E2E_COLLECTION,
					openseaSlug,
					openseaStatus: OPENSEA_COLLECTION_STATUS.Pending
				},
				openseaStatus: OPENSEA_COLLECTION_STATUS.Pending
			});
			return;
		}

		await fulfillJson(route, { error: `Unhandled collection API path: ${url.pathname}` }, 500);
	});

	return { probeSlugs, syncSlugs };
}

function requestBody(request: Request): unknown {
	const body = request.postData();
	return body ? JSON.parse(body) : null;
}

function normalizeSlug(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const slug = value.trim().toLowerCase();
	return slug || null;
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
	await route.fulfill({
		status,
		contentType: 'application/json',
		body: JSON.stringify(body)
	});
}
