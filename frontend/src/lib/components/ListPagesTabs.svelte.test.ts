import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ListPagesTabs from './ListPagesTabs.svelte';

describe('ListPagesTabs', () => {
	it('renders collections as non-clickable text when active', () => {
		const { body } = render(ListPagesTabs, {
			props: {
				chainSlug: 'ethereum',
				active: 'collections'
			}
		});

		expect(body).toContain('<span class="runtime-tab-active">collections</span>');
		expect(body).toContain('<a href="/ethereum/bootstrap-runs">bootstrapping</a>');
	});

	it('renders bootstrapping as non-clickable text when active', () => {
		const { body } = render(ListPagesTabs, {
			props: {
				chainSlug: 'ethereum',
				active: 'bootstrapping'
			}
		});

		expect(body).toContain('<a href="/ethereum">collections</a>');
		expect(body).toContain('<span class="runtime-tab-active">bootstrapping</span>');
	});

	it('renders blockspace as non-clickable text when active', () => {
		const { body } = render(ListPagesTabs, {
			props: {
				chainSlug: 'ethereum',
				active: 'blockspace'
			}
		});

		expect(body).toContain('<a href="/ethereum">collections</a>');
		expect(body).toContain('<a href="/ethereum/bootstrap-runs">bootstrapping</a>');
		expect(body).toContain('<span class="runtime-tab-active">blockspace</span>');
	});
});
