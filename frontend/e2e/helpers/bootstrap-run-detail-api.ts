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
	type BootstrapStepKey,
	type BootstrapRunStatus
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
	completeDeployment(): void;
};

// Returns deterministic run-detail responses while capturing step action calls.
export async function installBootstrapRunDetailApiMock(
	page: Page,
	initialDeploymentStatus = BOOTSTRAP_STEP_STATUS.Ready as (typeof BOOTSTRAP_STEP_STATUS)[keyof typeof BOOTSTRAP_STEP_STATUS],
	runStatus: BootstrapRunStatus = BOOTSTRAP_RUN_STATUS.Completed
): Promise<BootstrapRunDetailApiMock> {
	const actions: CapturedBootstrapStepAction[] = [];
	let detailRequests = 0;
	let imageCachePaused = false;
	let deploymentStatus = initialDeploymentStatus;
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
			await fulfillJson(
				route,
				buildBootstrapRunDetailE2eDetail({ imageCachePaused, deploymentStatus, runStatus })
			);
			return;
		}

		if (request.method() === 'POST' && url.pathname.startsWith(`${detailPath}/steps/`)) {
			const stepAction = parseStepAction(url.pathname, detailPath);
			if (!stepAction) {
				await fulfillJson(
					route,
					{ error: `Unhandled bootstrap step action path: ${url.pathname}` },
					404
				);
				return;
			}
			const { stepKey, action } = stepAction;
			if (stepKey === BOOTSTRAP_STEP_KEY.ImageCache)
				imageCachePaused = action === BOOTSTRAP_STEP_ACTION.Pause;
			else
				deploymentStatus =
					action === BOOTSTRAP_STEP_ACTION.Pause
						? BOOTSTRAP_STEP_STATUS.Paused
						: BOOTSTRAP_STEP_STATUS.Ready;
			actions.push({
				stepKey,
				action,
				body: requestBody(request)
			});
			await fulfillJson(route, {
				runId: BOOTSTRAP_RUN_DETAIL_E2E_RUN_ID,
				stepKey,
				status:
					stepKey === BOOTSTRAP_STEP_KEY.DeploymentBlock
						? deploymentStatus
						: imageCachePaused
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

		await fulfillJson(
			route,
			{ error: `Unhandled bootstrap detail API path: ${url.pathname}` },
			500
		);
	});

	return {
		actions,
		completeDeployment: () => {
			deploymentStatus = BOOTSTRAP_STEP_STATUS.Succeeded;
		},
		get detailRequests() {
			return detailRequests;
		}
	};
}

function parseStepAction(
	pathname: string,
	detailPath: string
): { stepKey: BootstrapStepKey; action: BootstrapStepAction } | null {
	for (const stepKey of [BOOTSTRAP_STEP_KEY.ImageCache, BOOTSTRAP_STEP_KEY.DeploymentBlock]) {
		for (const action of Object.values(BOOTSTRAP_STEP_ACTION)) {
			if (pathname === `${detailPath}/steps/${stepKey}/${action}`) return { stepKey, action };
		}
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
