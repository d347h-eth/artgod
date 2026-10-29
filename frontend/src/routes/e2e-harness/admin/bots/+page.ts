import { dev } from '$app/env';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { parseAdminBotsAuthorizationScenario } from '$lib/e2e/admin-bots-authorization-fixtures';

export const ssr = false;

export const load: PageLoad = ({ url }) => {
	if (!dev) throw error(404, 'Not found');
	return { scenario: parseAdminBotsAuthorizationScenario(url.searchParams) };
};
