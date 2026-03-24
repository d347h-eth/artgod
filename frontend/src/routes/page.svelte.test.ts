import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Page from './+page.svelte';

describe('/+page.svelte', () => {
	it('renders collections heading', () => {
		const { body } = render(Page);
		expect(body).toContain('ArtGod v0.0.1-pre-alpha.1');
	});
});
