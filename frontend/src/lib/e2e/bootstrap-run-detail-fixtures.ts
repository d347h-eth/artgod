import {
	BOOTSTRAP_FLOW_STEP_STATE,
	BOOTSTRAP_METADATA_MODE,
	BOOTSTRAP_ENUMERATION_MODE,
	BOOTSTRAP_RUN_STATUS,
	BOOTSTRAP_STEP_ACTION,
	BOOTSTRAP_STEP_KEY,
	BOOTSTRAP_STEP_LABEL,
	BOOTSTRAP_STEP_STATUS,
	type BootstrapStepStatus,
	type BootstrapRunStatus
} from '@artgod/shared/bootstrap/pipeline';
import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from '@artgod/shared/media/token-metadata-image-source';
import { COLLECTION_STATUS } from '@artgod/shared/types';
import { getDefaultBlockExplorerConfig } from '@artgod/shared/config/block-explorer';
import type { ApiBootstrapFlowStep, BootstrapRunDetailApiResponse } from '../api-types';
import { BOOTSTRAP_PROBE_E2E_CHAIN } from './bootstrap-probe-fixtures';

// Browser-test route for the bootstrap run-detail harness page.
export const BOOTSTRAP_RUN_DETAIL_E2E_ROUTE_PATH = '/e2e-harness/bootstrap-runs/77';
export const BOOTSTRAP_RUN_DETAIL_E2E_RUN_ID = 77;
export const BOOTSTRAP_RUN_DETAIL_E2E_DEPLOYMENT_BLOCK = 13_090_020;
export const BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO_QUERY_PARAM = 'scenario';
export const BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO = {
	Pending: 'pending',
	Completed: 'completed',
	Paused: 'paused',
	Failed: 'failed',
	RunFailed: 'run_failed',
	NoOpenSea: 'no_opensea',
	Extension: 'extension',
	CustomExplorer: 'custom_explorer',
	InvalidExplorer: 'invalid_explorer',
	Missing: 'missing'
} as const;

export const BOOTSTRAP_RUN_DETAIL_E2E_EXPLORER_URL = 'https://explorer.example';

export type BootstrapRunDetailE2eState = {
	imageCachePaused: boolean;
	shouldPoll?: boolean;
	deploymentStatus?: BootstrapStepStatus;
	openSeaEnabled?: boolean;
	runStatus?: BootstrapRunStatus;
};

// Feeds deterministic data into the production bootstrap run-detail view.
export function buildBootstrapRunDetailE2ePageData(runId: number, scenario?: string | null) {
	const explorerScenario =
		scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.CustomExplorer ||
		scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.InvalidExplorer;
	const blockExplorer = getDefaultBlockExplorerConfig();
	if (explorerScenario)
		blockExplorer.baseUrl =
			scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.CustomExplorer
				? BOOTSTRAP_RUN_DETAIL_E2E_EXPLORER_URL
				: 'invalid explorer URL';
	const initialDetail = buildBootstrapRunDetailE2eDetail({
		runStatus:
			scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.RunFailed
				? BOOTSTRAP_RUN_STATUS.Failed
				: undefined,
		imageCachePaused: scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.Paused,
		deploymentStatus:
			scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.Paused
				? BOOTSTRAP_STEP_STATUS.Paused
				: scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.Failed
					? BOOTSTRAP_STEP_STATUS.FailedTerminal
					: scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.Completed || explorerScenario
						? BOOTSTRAP_STEP_STATUS.Succeeded
						: BOOTSTRAP_STEP_STATUS.Ready,
		openSeaEnabled: scenario !== BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.NoOpenSea
	});
	if (scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.Extension) {
		initialDetail.flow.steps.push(
			flowStep({
				key: BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
				state: BOOTSTRAP_FLOW_STEP_STATE.Active,
				blocking: false,
				completed: 128,
				total: 1000
			})
		);
	}
	if (explorerScenario || scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.Extension)
		initialDetail.flow.shouldPoll = false;
	if (scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.Completed) {
		initialDetail.flow.steps = initialDetail.flow.steps.map((step) => ({
			...step,
			state: BOOTSTRAP_FLOW_STEP_STATE.Completed,
			availableActions: [],
			progress: step.progress ? { ...step.progress, completed: step.progress.total } : null
		}));
		initialDetail.flow.shouldPoll = false;
		initialDetail.flow.isTerminal = true;
	}
	if (scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.Pending) {
		initialDetail.run.status = BOOTSTRAP_RUN_STATUS.Queued;
		initialDetail.run.anchorBlock = null;
		initialDetail.collection.status = COLLECTION_STATUS.Bootstrapping;
		initialDetail.flow.steps = initialDetail.flow.steps.map((step) => ({
			...step,
			state: BOOTSTRAP_FLOW_STEP_STATE.Pending,
			progress: null,
			availableActions: []
		}));
	}
	return {
		chainRef: BOOTSTRAP_PROBE_E2E_CHAIN.slug,
		runId,
		blockExplorer,
		initialDetail: scenario === BOOTSTRAP_RUN_DETAIL_E2E_SCENARIO.Missing ? null : initialDetail
	};
}

// Builds the API response used by the run-detail E2E route and network mock.
export function buildBootstrapRunDetailE2eDetail(
	state: BootstrapRunDetailE2eState
): BootstrapRunDetailApiResponse {
	const detail: BootstrapRunDetailApiResponse = {
		run: {
			runId: BOOTSTRAP_RUN_DETAIL_E2E_RUN_ID,
			chainId: BOOTSTRAP_PROBE_E2E_CHAIN.publicChainId,
			collectionId: 77,
			requestSlug: 'milady-by-remilia-corporation',
			requestAddress: '0x1111111111111111111111111111111111111111',
			requestOpenseaSlug: 'milady',
			requestStandard: 'erc721',
			imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
			animationSourceField: null,
			metadataMode: BOOTSTRAP_METADATA_MODE.BestEffort,
			enumerationMode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
			manualTokenIdsJson: null,
			manualRangeStartTokenId: null,
			manualRangeTotalSupply: null,
			imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
			imageCacheMaxDimension: 1024,
			deploymentBlock:
				state.deploymentStatus === BOOTSTRAP_STEP_STATUS.Succeeded
					? BOOTSTRAP_RUN_DETAIL_E2E_DEPLOYMENT_BLOCK
					: null,
			status: state.runStatus ?? BOOTSTRAP_RUN_STATUS.Completed,
			anchorBlock: 24500000,
			anchorBlockHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			anchorBlockTimestamp: 1726000000,
			errorCode: null,
			errorMessage: null,
			createdAt: '2026-02-01T00:00:00Z',
			updatedAt: '2026-02-01T00:04:00Z',
			finishedAt: '2026-02-01T00:03:00Z'
		},
		collection: {
			chainId: BOOTSTRAP_PROBE_E2E_CHAIN.publicChainId,
			collectionId: 77,
			slug: 'milady-by-remilia-corporation',
			address: '0x1111111111111111111111111111111111111111',
			status:
				state.runStatus === BOOTSTRAP_RUN_STATUS.Failed
					? COLLECTION_STATUS.Bootstrapping
					: COLLECTION_STATUS.Live
		},
		metadataTasks: {
			pending: 0,
			retry: 0,
			succeeded: 1000,
			failedTerminal: 0,
			total: 1000
		},
		flow: {
			steps: [
				flowStep({
					key: BOOTSTRAP_STEP_KEY.Anchor,
					state: BOOTSTRAP_FLOW_STEP_STATE.Completed,
					completed: 1,
					total: 1
				}),
				flowStep({
					key: BOOTSTRAP_STEP_KEY.Enumeration,
					state: BOOTSTRAP_FLOW_STEP_STATE.Completed,
					completed: 1000,
					total: 1000
				}),
				flowStep({
					key: BOOTSTRAP_STEP_KEY.Metadata,
					state: BOOTSTRAP_FLOW_STEP_STATE.Completed,
					completed: 1000,
					total: 1000
				}),
				flowStep({
					key: BOOTSTRAP_STEP_KEY.Ownership,
					state: BOOTSTRAP_FLOW_STEP_STATE.Completed,
					completed: 1000,
					total: 1000
				}),
				flowStep({
					key: BOOTSTRAP_STEP_KEY.Backfill,
					state: BOOTSTRAP_FLOW_STEP_STATE.Completed,
					completed: 12,
					total: 12
				}),
				flowStep({
					key: BOOTSTRAP_STEP_KEY.CollectionLive,
					state: BOOTSTRAP_FLOW_STEP_STATE.Completed,
					completed: 1,
					total: 1
				}),
				...(state.openSeaEnabled === false
					? []
					: [
							flowStep({
								key: BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
								state: BOOTSTRAP_FLOW_STEP_STATE.Completed,
								blocking: false,
								completed: 1,
								total: 1
							}),
							flowStep({
								key: BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
								state: BOOTSTRAP_FLOW_STEP_STATE.Active,
								blocking: false,
								completed: 0,
								total: 1
							}),
							flowStep({
								key: BOOTSTRAP_STEP_KEY.OpenSeaReady,
								state: BOOTSTRAP_FLOW_STEP_STATE.Pending,
								blocking: false,
								completed: 0,
								total: 1
							})
						]),
				imageCacheStep(state.imageCachePaused),
				deploymentStep(state.deploymentStatus ?? BOOTSTRAP_STEP_STATUS.Ready)
			],
			isTerminal: false,
			shouldPoll: state.shouldPoll ?? true
		},
		failedMetadataTasksPreview: [],
		failedMetadataTasksPreviewLimit: 50,
		isLatestForCollection: true
	};
	if (state.runStatus === BOOTSTRAP_RUN_STATUS.Failed) {
		detail.flow.shouldPoll = false;
		detail.flow.isTerminal = true;
		detail.flow.steps = detail.flow.steps.map((step) => {
			if (
				step.key === BOOTSTRAP_STEP_KEY.DeploymentBlock ||
				step.key === BOOTSTRAP_STEP_KEY.ImageCache
			)
				return { ...step, availableActions: [] };
			if (step.key === BOOTSTRAP_STEP_KEY.Metadata)
				return {
					...step,
					state: BOOTSTRAP_FLOW_STEP_STATE.Failed,
					availableActions: [BOOTSTRAP_STEP_ACTION.Retry],
					progress: { completed: 0, total: 1000 }
				};
			if (
				step.key === BOOTSTRAP_STEP_KEY.Ownership ||
				step.key === BOOTSTRAP_STEP_KEY.Backfill ||
				step.key === BOOTSTRAP_STEP_KEY.CollectionLive
			)
				return {
					...step,
					state: BOOTSTRAP_FLOW_STEP_STATE.Pending,
					progress: step.progress ? { ...step.progress, completed: 0 } : null
				};
			return step;
		});
	}
	return detail;
}

function deploymentStep(status: BootstrapStepStatus): ApiBootstrapFlowStep {
	const done = status === BOOTSTRAP_STEP_STATUS.Succeeded;
	const failed = status === BOOTSTRAP_STEP_STATUS.FailedTerminal;
	const paused = status === BOOTSTRAP_STEP_STATUS.Paused;
	return {
		key: BOOTSTRAP_STEP_KEY.DeploymentBlock,
		label: BOOTSTRAP_STEP_LABEL[BOOTSTRAP_STEP_KEY.DeploymentBlock],
		state: done
			? BOOTSTRAP_FLOW_STEP_STATE.Completed
			: failed
				? BOOTSTRAP_FLOW_STEP_STATE.Failed
				: BOOTSTRAP_FLOW_STEP_STATE.Active,
		detailText: null,
		blocking: false,
		pausable: true,
		paused,
		availableActions: done
			? []
			: [
					failed
						? BOOTSTRAP_STEP_ACTION.Retry
						: paused
							? BOOTSTRAP_STEP_ACTION.Resume
							: BOOTSTRAP_STEP_ACTION.Pause
				],
		progress: { completed: done ? 1 : 0, total: 1 }
	};
}

function imageCacheStep(paused: boolean): ApiBootstrapFlowStep {
	return {
		key: BOOTSTRAP_STEP_KEY.ImageCache,
		label: BOOTSTRAP_STEP_LABEL[BOOTSTRAP_STEP_KEY.ImageCache],
		state: BOOTSTRAP_FLOW_STEP_STATE.Active,
		detailText: paused ? BOOTSTRAP_STEP_STATUS.Paused : null,
		blocking: false,
		pausable: true,
		paused,
		availableActions: [paused ? BOOTSTRAP_STEP_ACTION.Resume : BOOTSTRAP_STEP_ACTION.Pause],
		progress: {
			completed: 600,
			total: 1000
		}
	};
}

function flowStep(input: {
	key: ApiBootstrapFlowStep['key'];
	state: ApiBootstrapFlowStep['state'];
	completed?: number;
	total?: number;
	blocking?: boolean;
}): ApiBootstrapFlowStep {
	return {
		key: input.key,
		label: BOOTSTRAP_STEP_LABEL[input.key],
		state: input.state,
		detailText: null,
		blocking: input.blocking ?? true,
		pausable: false,
		paused: false,
		availableActions: [],
		progress:
			input.completed === undefined || input.total === undefined
				? null
				: {
						completed: input.completed,
						total: input.total
					}
	};
}
