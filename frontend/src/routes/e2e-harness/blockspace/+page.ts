import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import { load as loadBlockspace } from '../../[chain_ref]/blockspace/+page';
import type { PageLoad } from './$types';

export const ssr = false;

// Reuse the real page loader; Playwright supplies the API through test ports.
export const load: PageLoad = async (event) => {
	if (!dev) throw error(404, 'Not found');
	const data = await loadBlockspace({
		...event,
		params: { chain_ref: 'ethereum' },
		route: { id: '/[chain_ref]/blockspace' }
	});
	if (!data) throw error(500, 'Blockspace fixture unavailable');
	return { ...data, basePath: event.url.pathname };
};
