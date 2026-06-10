import type { Page, Request, Route } from 'playwright/test';
import {
	BOOTSTRAP_RUN_DETAIL_E2E_ROUTE_PATH,
	BOOTSTRAP_RUN_DETAIL_E2E_RUN_ID,
	buildBootstrapRunDetailE2eDetail
} from '../../src/lib/e2e/bootstrap-run-detail-fixtures';
import { BOOTSTRAP_PROBE_E2E_CHAIN } from '../../src/lib/e2e/bootstrap-probe-fixtures';
import {
	BOOTSTRAP_STEP_ACTION,
	BOOTSTRAP_STEP_KEY,
	BOOTSTRAP_STEP_STATUS,
	BOOTSTRAP_RUN_STATUS,
	type BootstrapStepAction,
	type BootstrapStepKey
} from '@artgod/shared/bootstrap/pipeline';

export { BOOTSTRAP_RUN_DETAIL_E2E_ROUTE_PATH };

export type CapturedBootstrapStepAction = {
	stepKey: BootstrapStepKey;
	action: BootstrapStepAction;
	body: unknown;
};

export type BootstrapRunDetailApiMock = {
	actions: CapturedBootstrapStepAction[];
	detailRequests: number;
};

// Returns deterministic run-detail responses while capturing step action calls.
export async function installBootstrapRunDetailApiMock(
	page: Page
): Promise<BootstrapRunDetailApiMock> {
	const actions: CapturedBootstrapStepAction[] = [];
	let detailRequests = 0;
	let imageCachePaused = false;
	const detailPath = `/api/${BOOTSTRAP_PROBE_E2E_CHAIN.slug}/bootstrap-runs/${BOOTSTRAP_RUN_DETAIL_E2E_RUN_ID}`;

	await page.route('**/api/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());

		if (request.method() === 'GET' && url.pathname === '/api/security/csrf') {
			await fulfillJson(route, { token: 'bootstrap-run-detail-e2e-csrf' });
			return;
		}

		if (request.method() === 'GET' && url.pathname === detailPath) {
			detailRequests += 1;
			await fulfillJson(route, buildBootstrapRunDetailE2eDetail({ imageCachePaused }));
			return;
		}

		if (request.method() === 'POST' && url.pathname.startsWith(`${detailPath}/steps/`)) {
			const action = parseImageCacheAction(url.pathname, detailPath);
			if (!action) {
				await fulfillJson(
					route,
					{ error: `Unhandled bootstrap step action path: ${url.pathname}` },
					404
				);
				return;
			}
			imageCachePaused = action === BOOTSTRAP_STEP_ACTION.Pause;
			actions.push({
				stepKey: BOOTSTRAP_STEP_KEY.ImageCache,
				action,
				body: requestBody(request)
			});
			await fulfillJson(route, {
				runId: BOOTSTRAP_RUN_DETAIL_E2E_RUN_ID,
				stepKey: BOOTSTRAP_STEP_KEY.ImageCache,
				status: imageCachePaused
					? BOOTSTRAP_STEP_STATUS.Paused
					: BOOTSTRAP_STEP_STATUS.Ready
			});
			return;
		}

		if (request.method() === 'POST' && url.pathname === `${detailPath}/retry-failed`) {
			await fulfillJson(route, {
				runId: BOOTSTRAP_RUN_DETAIL_E2E_RUN_ID,
				updatedCount: 0,
				status: BOOTSTRAP_RUN_STATUS.Completed
			});
			return;
		}

		await fulfillJson(route, { error: `Unhandled bootstrap detail API path: ${url.pathname}` }, 500);
	});

	return {
		actions,
		get detailRequests() {
			return detailRequests;
		}
	};
}

function parseImageCacheAction(
	pathname: string,
	detailPath: string
): BootstrapStepAction | null {
	const pausePath = `${detailPath}/steps/${BOOTSTRAP_STEP_KEY.ImageCache}/${BOOTSTRAP_STEP_ACTION.Pause}`;
	if (pathname === pausePath) {
		return BOOTSTRAP_STEP_ACTION.Pause;
	}
	const resumePath = `${detailPath}/steps/${BOOTSTRAP_STEP_KEY.ImageCache}/${BOOTSTRAP_STEP_ACTION.Resume}`;
	if (pathname === resumePath) {
		return BOOTSTRAP_STEP_ACTION.Resume;
	}
	return null;
}

function requestBody(request: Request): unknown {
	try {
		return request.postDataJSON();
	} catch {
		return null;
	}
}

async function fulfillJson(route: Route, value: unknown, status = 200): Promise<void> {
	await route.fulfill({
		status,
		contentType: 'application/json',
		body: JSON.stringify(value)
	});
}
