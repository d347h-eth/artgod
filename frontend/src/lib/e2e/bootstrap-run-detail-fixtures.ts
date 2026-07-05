import {
	BOOTSTRAP_FLOW_STEP_STATE,
	BOOTSTRAP_METADATA_MODE,
	BOOTSTRAP_ENUMERATION_MODE,
	BOOTSTRAP_RUN_STATUS,
	BOOTSTRAP_STEP_ACTION,
	BOOTSTRAP_STEP_KEY,
	BOOTSTRAP_STEP_STATUS
} from '@artgod/shared/bootstrap/pipeline';
import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from '@artgod/shared/media/token-metadata-image-source';
import { COLLECTION_STATUS } from '@artgod/shared/types';
import type { ApiBootstrapFlowStep, BootstrapRunDetailApiResponse } from '../api-types';
import { BOOTSTRAP_PROBE_E2E_CHAIN } from './bootstrap-probe-fixtures';

// Browser-test route for the bootstrap run-detail harness page.
export const BOOTSTRAP_RUN_DETAIL_E2E_ROUTE_PATH = '/e2e-harness/bootstrap-runs/77';
export const BOOTSTRAP_RUN_DETAIL_E2E_RUN_ID = 77;

export type BootstrapRunDetailE2eState = {
	imageCachePaused: boolean;
	shouldPoll?: boolean;
};

// Feeds deterministic data into the production bootstrap run-detail view.
export function buildBootstrapRunDetailE2ePageData(runId: number) {
	return {
		chainRef: BOOTSTRAP_PROBE_E2E_CHAIN.slug,
		runId,
		initialDetail: buildBootstrapRunDetailE2eDetail({ imageCachePaused: false })
	};
}

// Builds the API response used by the run-detail E2E route and network mock.
export function buildBootstrapRunDetailE2eDetail(
	state: BootstrapRunDetailE2eState
): BootstrapRunDetailApiResponse {
	return {
		run: {
			runId: BOOTSTRAP_RUN_DETAIL_E2E_RUN_ID,
			chainId: BOOTSTRAP_PROBE_E2E_CHAIN.publicChainId,
			collectionId: 77,
			requestSlug: 'milady-by-remilia-corporation',
			requestAddress: '0x1111111111111111111111111111111111111111',
			requestOpenseaSlug: 'milady',
			requestStandard: 'erc721',
			imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
			metadataMode: BOOTSTRAP_METADATA_MODE.BestEffort,
			enumerationMode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
			manualTokenIdsJson: null,
			manualRangeStartTokenId: null,
			manualRangeTotalSupply: null,
			imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
			imageCacheMaxDimension: 1024,
			deploymentBlock: null,
			status: BOOTSTRAP_RUN_STATUS.Completed,
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
			status: COLLECTION_STATUS.Live
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
					key: BOOTSTRAP_STEP_KEY.Metadata,
					label: 'metadata',
					state: BOOTSTRAP_FLOW_STEP_STATE.Completed,
					completed: 1000,
					total: 1000
				}),
				flowStep({
					key: BOOTSTRAP_STEP_KEY.Ownership,
					label: 'ownership',
					state: BOOTSTRAP_FLOW_STEP_STATE.Completed,
					completed: 1000,
					total: 1000
				}),
				flowStep({
					key: BOOTSTRAP_STEP_KEY.Backfill,
					label: 'backfill',
					state: BOOTSTRAP_FLOW_STEP_STATE.Completed,
					completed: 12,
					total: 12
				}),
				flowStep({
					key: BOOTSTRAP_STEP_KEY.CollectionLive,
					label: 'collection live',
					state: BOOTSTRAP_FLOW_STEP_STATE.Completed
				}),
				imageCacheStep(state.imageCachePaused)
			],
			isTerminal: false,
			shouldPoll: state.shouldPoll ?? true
		},
		failedMetadataTasksPreview: [],
		failedMetadataTasksPreviewLimit: 50,
		isLatestForCollection: true
	};
}

function imageCacheStep(paused: boolean): ApiBootstrapFlowStep {
	return {
		key: BOOTSTRAP_STEP_KEY.ImageCache,
		label: 'image cache',
		state: BOOTSTRAP_FLOW_STEP_STATE.Active,
		detailText: paused ? BOOTSTRAP_STEP_STATUS.Paused : null,
		blocking: false,
		pausable: true,
		paused,
		availableActions: [
			paused ? BOOTSTRAP_STEP_ACTION.Resume : BOOTSTRAP_STEP_ACTION.Pause
		],
		progress: {
			completed: 600,
			total: 1000
		}
	};
}

function flowStep(input: {
	key: ApiBootstrapFlowStep['key'];
	label: string;
	state: ApiBootstrapFlowStep['state'];
	completed?: number;
	total?: number;
}): ApiBootstrapFlowStep {
	return {
		key: input.key,
		label: input.label,
		state: input.state,
		detailText: null,
		blocking: true,
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
