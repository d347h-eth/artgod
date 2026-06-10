import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { buildBootstrapRunDetailE2ePageData } from '$lib/e2e/bootstrap-run-detail-fixtures';

export const ssr = false;

export const load: PageLoad = ({ params }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	// Feed deterministic bootstrap run-detail data into the production detail view.
	return buildBootstrapRunDetailE2ePageData(Number(params.run_id));
};
