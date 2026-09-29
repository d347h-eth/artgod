import type { Page, Route } from 'playwright/test';
import {
	BOOTSTRAP_OPERATION as Operation,
	BOOTSTRAP_OUTPUT_STEP as Step,
	BOOTSTRAP_OUTPUT_STATUS as Status,
	BOOTSTRAP_STREAM_CONTENT_TYPE,
	BOOTSTRAP_STREAM_RECORD as RecordType,
	type BootstrapOutput,
	type BootstrapOperation
} from '@artgod/shared/bootstrap/operation-output';
import {
	BOOTSTRAP_CONTRACT_CASES,
	bootstrapTestContract,
	bootstrapTestSample,
	BOOTSTRAP_TEST_PROJECT_SCOPE
} from '@artgod/shared/testing/bootstrap-probe';
import {
	bootstrapSampleCandidates,
	bootstrapTokenDiscovery,
	BOOTSTRAP_CONVENTIONAL_TOKEN_IDS
} from '@artgod/shared/bootstrap/sample-selection';
import {
	BOOTSTRAP_SHARED_CONTRACT_REASON,
	emptyBootstrapSampleMetadata,
	type BootstrapContractProbeResponse,
	type BootstrapSampleInspectionResponse,
	type BootstrapSampleInspectionRequest
} from '@artgod/shared/bootstrap/probe';
import {
	BOOTSTRAP_API_QUERY_PARAM,
	buildInspectBootstrapSamplePath
} from '@artgod/shared/http/bootstrap-routes';
import { OPENSEA_COLLECTION_SLUG_PROBE_STATUS } from '@artgod/shared/opensea/collection-slug-probe';
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from '@artgod/shared/media/token-metadata-image-source';
import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
import {
	BOOTSTRAP_PROBE_E2E_CHAIN,
	BOOTSTRAP_PROBE_E2E_CHAINS,
	BOOTSTRAP_PROBE_E2E_ROUTE_PATH,
	BOOTSTRAP_PROBE_E2E_OPENSEA_INTEGRATION
} from '../../src/lib/e2e/bootstrap-probe-fixtures';
export { BOOTSTRAP_PROBE_E2E_ROUTE_PATH };
export const BOOTSTRAP_PROBE_CONTRACTS = {
	Aeon: BOOTSTRAP_CONTRACT_CASES[4].address,
	NonEnumerable: BOOTSTRAP_CONTRACT_CASES[1].address,
	EnumerableRaster: BOOTSTRAP_CONTRACT_CASES[0].address,
	PartiallyMinted: BOOTSTRAP_CONTRACT_CASES[3].address,
	SharedManualScope: BOOTSTRAP_CONTRACT_CASES[2].address,
	EnumerableOnchainSvg: '0x4e1f41613c9084fdb9e34e11fae9412427480e56'
} as const;
export const BOOTSTRAP_PROBE_OPENSEA_SLUGS = {
	NonEnumerable: 'remilio-babies',
	EnumerableRaster: 'milady',
	EnumerableOnchainSvg: 'terraforms',
	PartiallyMinted: 'grailers-dao',
	SharedManualScope: 'meridian-by-matt-deslauriers'
} as const;
export const BOOTSTRAP_PROBE_MEDIA = {
	NonEnumerableImage:
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
	RasterImage:
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP8z8BQz0AEYBxVSFUBAFgSAf+D1M2sAAAAAElFTkSuQmCC',
	SharedManualScopeImage: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M20 90h80L60 20z" fill="cyan"/></svg>', 'utf8').toString('base64')}`,
	OnchainSvgImage: `data:image/svg+xml;base64,${Buffer.from(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#05070a"/><path d="M20 90h80L60 20z" fill="#1dd6ff"/><circle cx="60" cy="66" r="14" fill="#ff7a1a"/></svg>',
		'utf8'
	).toString('base64')}`,
	DynamicAnimationUrl: 'https://dynamic.example/bootstrap-preview.html'
} as const;

export const BOOTSTRAP_PROBE_CREATED_RUN_ID = 1;
export const BOOTSTRAP_PROBE_CREATED_RUN_API_PATH = `/api/${BOOTSTRAP_PROBE_E2E_CHAIN.slug}/bootstrap-runs/${BOOTSTRAP_PROBE_CREATED_RUN_ID}`;

export type CapturedBootstrapMutation = { method: string; path: string; body: unknown };

// Hold the fixture's remaining stream after selection to exercise the real
// reader/UI while metadata is still pending. No additional server is needed.
export async function pauseBootstrapSampleMetadata(page: Page) {
	return page.evaluateHandle(
		({ path, step, contentType }) => {
			const originalFetch = window.fetch;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			window.fetch = async (...args) => {
				const response = await originalFetch(...args);
				const input = args[0];
				const url = new URL(
					input instanceof Request ? input.url : String(input),
					window.location.href
				);
				if (url.pathname !== path || !response.headers.get('content-type')?.includes(contentType))
					return response;
				window.fetch = originalFetch;
				const lines = (await response.text()).trimEnd().split('\n');
				const selected = lines.findIndex((line) => JSON.parse(line).step === step);
				if (selected < 0) throw new Error('Sample selection output is required for this fixture');
				const encoder = new TextEncoder();
				let cancelled = false;
				return new Response(
					new ReadableStream({
						async start(controller) {
							controller.enqueue(encoder.encode(lines.slice(0, selected + 1).join('\n') + '\n'));
							await gate;
							if (cancelled) return;
							controller.enqueue(encoder.encode(lines.slice(selected + 1).join('\n') + '\n'));
							controller.close();
						},
						cancel() {
							cancelled = true;
						}
					}),
					{ status: response.status, headers: response.headers }
				);
			};
			return release;
		},
		{
			path: buildInspectBootstrapSamplePath(BOOTSTRAP_PROBE_E2E_CHAIN.slug),
			step: Step.Sample,
			contentType: BOOTSTRAP_STREAM_CONTENT_TYPE
		}
	);
}

export async function installBootstrapProbeApiMock(
	page: Page,
	transforms: {
		contract?: (response: BootstrapContractProbeResponse) => BootstrapContractProbeResponse;
		sample?: (response: BootstrapSampleInspectionResponse) => BootstrapSampleInspectionResponse;
	} = {}
) {
	const mutations: CapturedBootstrapMutation[] = [];
	const probeRequests: string[] = [];
	const sampleRequests: BootstrapSampleInspectionRequest[] = [];
	const openSeaSlugProbeRequests: string[] = [];
	const openSeaSlugVerificationRequests: string[] = [];
	const openSeaSlugProbeSampleTokenIds: (string | null)[] = [];
	const imageCacheEstimateRequests: unknown[] = [];
	await page.route('**/api/**', async (route) => {
		const request = route.request(),
			url = new URL(request.url());
		const chain =
			BOOTSTRAP_PROBE_E2E_CHAINS.find((candidate) =>
				url.pathname.startsWith(`/api/${candidate.slug}/`)
			) ?? BOOTSTRAP_PROBE_E2E_CHAIN;
		if (url.pathname === '/api/runtime/config')
			return fulfillJson(route, {
				integrations: { opensea: BOOTSTRAP_PROBE_E2E_OPENSEA_INTEGRATION }
			});
		if (url.pathname === '/api/security/csrf')
			return fulfillJson(route, { token: 'bootstrap-probe-e2e-csrf' });
		if (url.pathname.endsWith('/collections/bootstrap/probe')) {
			const address = url.searchParams.get(BOOTSTRAP_API_QUERY_PARAM.Address)!;
			probeRequests.push(address);
			const response = { ...contractResponse(address), chain };
			return fulfillJson(route, transforms.contract?.(response) ?? response);
		}
		if (url.pathname.endsWith('/collections/bootstrap/sample')) {
			const body = request.postDataJSON() as BootstrapSampleInspectionRequest;
			sampleRequests.push(body);
			const response = { ...sampleResponse(body), chain };
			return fulfillJson(route, transforms.sample?.(response) ?? response);
		}
		if (url.pathname.endsWith('/collections/bootstrap/opensea-slug-probe')) {
			const address = url.searchParams.get(BOOTSTRAP_API_QUERY_PARAM.Address)!;
			const requestedSlug = url.searchParams.get(BOOTSTRAP_API_QUERY_PARAM.Slug);
			const tokenId = url.searchParams.get(BOOTSTRAP_API_QUERY_PARAM.SampleTokenId);
			openSeaSlugProbeSampleTokenIds.push(tokenId);
			if (requestedSlug) openSeaSlugVerificationRequests.push(requestedSlug);
			else openSeaSlugProbeRequests.push(address);
			const fixture = BOOTSTRAP_CONTRACT_CASES.find((c) => c.address === address);
			const belongs =
				fixture &&
				tokenId !== null &&
				BigInt(tokenId) >= BigInt(fixture.start) &&
				BigInt(tokenId) < BigInt(fixture.start) + BigInt(fixture.count);
			const slug = belongs ? fixture.openseaSlug : null;
			const found = slug && (!requestedSlug || requestedSlug === slug);
			return fulfillJson(route, {
				chain,
				address,
				requestedSlug,
				status: found
					? OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Found
					: OPENSEA_COLLECTION_SLUG_PROBE_STATUS.Missing,
				slug: found ? slug : null,
				reason: found ? null : 'OpenSea did not confirm this collection slug'
			});
		}
		if (url.pathname.endsWith('/collections/bootstrap/image-cache-estimate')) {
			const body = request.postDataJSON();
			imageCacheEstimateRequests.push(body);
			return fulfillJson(route, {
				chain,
				sampleTokenId: body.sampleTokenId,
				imageCacheMode: body.imageCacheMode,
				maxDimension: body.maxDimension,
				sampleSourceBytes: 4096,
				sampleCachedBytes: body.maxDimension === null ? 4096 : 1024,
				contentType: 'image/png',
				sampleCachedImageDataUrl: BOOTSTRAP_PROBE_MEDIA.RasterImage,
				sourceWidth: 2160,
				sourceHeight: 2160,
				width: body.maxDimension ?? 2160,
				height: body.maxDimension ?? 2160
			});
		}
		if (request.method() === 'POST' && url.pathname.endsWith('/collections/bootstrap')) {
			mutations.push({
				method: request.method(),
				path: url.pathname,
				body: request.postDataJSON()
			});
			return fulfillJson(route, {
				runId: 1,
				collectionId: 1,
				status: 'requested',
				createdAt: '2026-06-01T12:00:00Z'
			});
		}
		if (request.method() === 'GET' && url.pathname === BOOTSTRAP_PROBE_CREATED_RUN_API_PATH) {
			await fulfillJson(route, {
				chain: BOOTSTRAP_PROBE_E2E_CHAIN,
				collection: {
					chainId: 1,
					collectionId: BOOTSTRAP_PROBE_CREATED_RUN_ID,
					slug: 'bootstrap-probe-created',
					address: BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster,
					status: 'bootstrapping'
				},
				run: {
					runId: BOOTSTRAP_PROBE_CREATED_RUN_ID,
					chainId: 1,
					collectionId: BOOTSTRAP_PROBE_CREATED_RUN_ID,
					requestSlug: 'bootstrap-probe-created',
					requestOpenseaSlug: 'raster-images-2026',
					requestAddress: BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster,
					imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
					animationSourceField: null,
					requestStandard: 'erc721',
					metadataMode: 'strict',
					enumerationMode: 'enumerable',
					manualTokenIdsJson: null,
					manualRangeStartTokenId: null,
					manualRangeTotalSupply: null,
					imageCacheMode: IMAGE_CACHE_MODE.Off,
					imageCacheMaxDimension: null,
					deploymentBlock: null,
					status: 'requested',
					anchorBlock: null,
					anchorBlockHash: null,
					anchorBlockTimestamp: null,
					errorCode: null,
					errorMessage: null,
					createdAt: '2026-06-01T12:00:00Z',
					updatedAt: '2026-06-01T12:00:00Z',
					finishedAt: null
				},
				flow: {
					steps: [],
					isTerminal: false,
					shouldPoll: false
				},
				metadataTasks: {
					total: 0,
					pending: 0,
					processing: 0,
					succeeded: 0,
					failedRetryable: 0,
					failedTerminal: 0,
					retry: 0
				},
				imageCacheTasks: {
					total: 0,
					pending: 0,
					processing: 0,
					succeeded: 0,
					failedRetryable: 0,
					failedTerminal: 0,
					retry: 0
				},
				collectionExtensionArtifactTasks: {
					total: 0,
					pending: 0,
					processing: 0,
					succeeded: 0,
					failedRetryable: 0,
					failedTerminal: 0,
					retry: 0
				},
				ownershipTasks: {
					total: 0,
					pending: 0,
					processing: 0,
					succeeded: 0,
					failedRetryable: 0,
					failedTerminal: 0,
					retry: 0
				},
				events: [],
				failedMetadataTasks: []
			});
			return;
		}

		await route.fulfill({
			status: 500,
			contentType: 'application/json',
			body: JSON.stringify({ message: 'Unhandled mock path: ' + url.pathname })
		});
	});
	return {
		mutations,
		probeRequests,
		sampleRequests,
		openSeaSlugProbeRequests,
		openSeaSlugVerificationRequests,
		openSeaSlugProbeSampleTokenIds,
		imageCacheEstimateRequests
	};
}

function contractResponse(address: string): BootstrapContractProbeResponse {
	const fixture =
		BOOTSTRAP_CONTRACT_CASES.find((c) => c.address === address) ?? BOOTSTRAP_CONTRACT_CASES[0];
	const response = bootstrapTestContract({
		address,
		contractName: fixture.name,
		sharedContract:
			fixture.name === 'meridian'
				? { reason: BOOTSTRAP_SHARED_CONTRACT_REASON.ProjectInterface, registryAddress: null }
				: null,
		enumerable: { supported: fixture.enumerable, error: null }
	});
	response.totalSupply = {
		...response.totalSupply,
		value: String(fixture.supply),
		safeIntegerValue: Number(fixture.supply),
		bootstrapRangeValue: Number(fixture.supply)
	};
	const id =
		fixture.name === 'grailers' ? null : fixture.name === 'meridian' ? '0' : fixture.sample;
	response.discovery = bootstrapTokenDiscovery(
		{
			checked: fixture.enumerable,
			tokenId: fixture.enumerable ? id : null,
			error: null
		},
		BOOTSTRAP_CONVENTIONAL_TOKEN_IDS.map((tokenId) => ({
			tokenId,
			exists: id !== null && BigInt(tokenId) >= BigInt(id),
			error: null
		}))
	);
	return response;
}
function sampleResponse(
	input: BootstrapSampleInspectionRequest
): BootstrapSampleInspectionResponse {
	const candidates = bootstrapSampleCandidates({
		requestedTokenId: input.requestedTokenId?.trim() || null,
		discoveredTokenId: input.discoveredTokenId ?? null,
		scope: input.scope ?? null
	});
	const sparse = input.address === BOOTSTRAP_PROBE_CONTRACTS.PartiallyMinted;
	const selected = input.requestedTokenId?.trim()
		? candidates[0]
		: candidates.find((c) => !sparse || BigInt(c.tokenId) >= 10n);
	const tokenId = selected?.tokenId ?? null;
	const exists = tokenId !== null && (!sparse || BigInt(tokenId) >= 10n);
	const response = bootstrapTestSample({
		address: input.address,
		requestedTokenId: input.requestedTokenId?.trim() || null,
		scope: input.scope ?? null
	});
	const text = JSON.stringify({
		name: 'Sample #' + tokenId,
		image: BOOTSTRAP_PROBE_MEDIA.RasterImage,
		image_url: BOOTSTRAP_PROBE_MEDIA.NonEnumerableImage,
		animation_url: BOOTSTRAP_PROBE_MEDIA.DynamicAnimationUrl,
		generator_url: BOOTSTRAP_PROBE_MEDIA.DynamicAnimationUrl
	});
	response.sample = {
		...emptyBootstrapSampleMetadata(),
		tokenId,
		source: selected?.source ?? null,
		ownership:
			tokenId === null
				? null
				: {
						tokenId,
						exists,
						error: exists ? null : 'This token has no owner. Choose another sample token ID.'
					},
		candidates: tokenId === null ? [] : [{ tokenId, exists, error: null }],
		tokenUri: exists ? 'ipfs://metadata/' + tokenId : null,
		tokenUriPayload: exists ? text : null,
		tokenUriPayloadBytes: exists ? Buffer.byteLength(text) : null
	};
	if (
		input.address === BOOTSTRAP_PROBE_CONTRACTS.SharedManualScope &&
		tokenId !== null &&
		BigInt(tokenId) >= BigInt(BOOTSTRAP_TEST_PROJECT_SCOPE.startTokenId) &&
		BigInt(tokenId) <
			BigInt(BOOTSTRAP_TEST_PROJECT_SCOPE.startTokenId) +
				BigInt(BOOTSTRAP_TEST_PROJECT_SCOPE.mintedTokenCount)
	)
		response.projectScope = BOOTSTRAP_TEST_PROJECT_SCOPE;
	return response;
}
async function fulfillJson(route: Route, body: unknown): Promise<void> {
	if (route.request().headers().accept === BOOTSTRAP_STREAM_CONTENT_TYPE) {
		const path = new URL(route.request().url()).pathname;
		const operation: BootstrapOperation = path.endsWith('/probe')
			? Operation.Probe
			: path.endsWith('/sample')
				? Operation.Inspect
				: path.endsWith('/image-cache-estimate')
					? Operation.Estimate
					: path.endsWith('/opensea-slug-probe')
						? Operation.Resolve
						: Operation.Queue;
		const output: BootstrapOutput[] = [
			{ step: Step.Operation, status: Status.Started, message: operation }
		];
		if (operation === Operation.Probe) {
			const contract = body as BootstrapContractProbeResponse;
			output.push({
				step: Step.Supply,
				status: Status.Succeeded,
				message: `Contract total supply: ${contract.totalSupply.value}`
			});
		}
		if (operation === Operation.Inspect) {
			const sample = (body as BootstrapSampleInspectionResponse).sample;
			output.push({
				step: Step.Ownership,
				status: sample.ownership?.exists ? Status.Succeeded : Status.Failed,
				message: `Token #${sample.tokenId} ownership checked`
			});
			if (sample.tokenId !== null)
				output.push({
					step: Step.Sample,
					status: Status.Succeeded,
					message: `Sample token #${sample.tokenId}`,
					tokenId: sample.tokenId
				});
			if (sample.tokenUri)
				output.push({
					step: Step.TokenUri,
					status: Status.Succeeded,
					message: `Token #${sample.tokenId} URI`,
					url: sample.tokenUri
				});
			if (sample.tokenUriPayload !== null)
				output.push({
					step: Step.Metadata,
					status: Status.Succeeded,
					message: `Token #${sample.tokenId} metadata`,
					text: sample.tokenUriPayload
				});
			if (sample.tokenUriPayloadError)
				output.push({
					step: Step.Metadata,
					status: Status.Failed,
					message: sample.tokenUriPayloadError,
					url: sample.tokenUri ?? undefined
				});
		}
		output.push({
			step: Step.Operation,
			status: Status.Completed,
			message: `${operation} finished`
		});
		return fulfillBootstrapOutput(route, operation, output, body);
	}
	await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

export async function fulfillBootstrapOutput(
	route: Route,
	operation: BootstrapOperation,
	output: BootstrapOutput[],
	result: unknown
) {
	const records = output.map((entry, index) => ({
		...entry,
		type: RecordType.Progress,
		operation,
		sequence: index + 1,
		timestamp: '2026-09-28T20:00:00Z'
	}));
	await route.fulfill({
		status: 200,
		contentType: BOOTSTRAP_STREAM_CONTENT_TYPE,
		body: [...records, { type: RecordType.Result, result }]
			.map((record) => JSON.stringify(record) + '\n')
			.join('')
	});
}
