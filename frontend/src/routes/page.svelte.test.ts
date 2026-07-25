import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { APP_VERSION } from '$lib/runtime/app-version';
import {
	buildCollectionOpenSeaSyncE2ePageData,
	COLLECTION_OPENSEA_SYNC_E2E_SLUG
} from '$lib/e2e/collection-opensea-sync-fixtures';
import Page from './+page.svelte';

describe('/+page.svelte', () => {
	it('renders collections heading', () => {
		const { body } = render(Page);
		expect(body).toContain(`ArtGod ${APP_VERSION}`);
	});

	it('forwards root-route OpenSea integration status to collection actions', () => {
		const fixture = buildCollectionOpenSeaSyncE2ePageData();
		const { body } = render(Page, {
			props: {
				data: {
					mode: 'collections',
					...fixture,
					page: {
						...fixture.page,
						items: fixture.page.items.map((collection) => ({
							...collection,
							openseaSlug: COLLECTION_OPENSEA_SYNC_E2E_SLUG
						}))
					},
					basePath: '/',
					deferred: false
				}
			}
		});

		expect(body).toContain('pause opensea stream');
	});
});
