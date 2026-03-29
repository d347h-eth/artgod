import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { APP_VERSION } from '$lib/runtime/app-version';
import Page from './+page.svelte';

describe('/+page.svelte', () => {
	it('renders collections heading', () => {
		const { body } = render(Page);
		expect(body).toContain(`ArtGod ${APP_VERSION}`);
	});
});
