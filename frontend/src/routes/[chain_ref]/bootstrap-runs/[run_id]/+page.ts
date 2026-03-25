import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { BackendApiError, getBootstrapRunDetail } from '$lib/backend-api';
import { IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT } from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';

export const load: PageLoad = async ({ fetch, params }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		throw error(404, 'Not found');
	}

	const runId = Number(params.run_id);
	if (!Number.isInteger(runId) || runId <= 0) {
		throw error(400, 'Invalid run_id');
	}

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chainRef: params.chain_ref,
			runId,
			initialDetail: null
		};
	}

	try {
		const detail = await getBootstrapRunDetail(fetch, params.chain_ref, runId);
		return {
			chainRef: params.chain_ref,
			runId,
			initialDetail: detail
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
