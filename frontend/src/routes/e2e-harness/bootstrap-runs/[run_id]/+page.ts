import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import {
	buildBootstrapRunDetailE2ePageData,
	BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO_QUERY_PARAM
} from '$lib/e2e/bootstrap-run-detail-fixtures';

export const ssr = false;

export const load: PageLoad = ({ params, url }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	// Feed deterministic bootstrap run-detail data into the production detail view.
	return buildBootstrapRunDetailE2ePageData(
		Number(params.run_id),
		url.searchParams.get(BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO_QUERY_PARAM)
	);
};
