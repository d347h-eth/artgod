import type { Page, Request, Route } from 'playwright/test';
import type {
	BootstrapContractProbeApiResponse,
	BootstrapOpenSeaSlugProbeApiResponse
} from '../../src/lib/api-types';
import { BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION } from '@artgod/shared/config/bootstrap';
import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from '@artgod/shared/types';
import { TERRAFORMS_EXTENSION_KEY } from '@artgod/shared/extensions/terraforms';
import { BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS } from '@artgod/shared/bootstrap/opensea-slug-probe';
import {
	BOOTSTRAP_PROBE_E2E_CHAIN,
	BOOTSTRAP_PROBE_E2E_ROUTE_PATH,
	BOOTSTRAP_PROBE_E2E_OPENSEA_INTEGRATION
} from '../../src/lib/e2e/bootstrap-probe-fixtures';

export { BOOTSTRAP_PROBE_E2E_ROUTE_PATH };

// Contract addresses used to exercise the bootstrap probe UI states.
export const BOOTSTRAP_PROBE_CONTRACTS = {
	NonEnumerable: '0xd3d9ddd0cf0a5f0bfb8f7fceae075df687eaebab',
	EnumerableRaster: '0x5af0d9827e0c53e4799bb226655a1de152a425a5',
	EnumerableOnchainSvg: '0x4e1f41613c9084fdb9e34e11fae9412427480e56'
} as const;

// OpenSea slugs returned by the bootstrap probe harness.
export const BOOTSTRAP_PROBE_OPENSEA_SLUGS = {
	NonEnumerable: 'non-enumerable-test-collection',
	EnumerableRaster: 'raster-images-2026',
	EnumerableOnchainSvg: 'terraforms'
} as const;

// Inline media lets the token card render without depending on remote hosts.
export const BOOTSTRAP_PROBE_MEDIA = {
	NonEnumerableImage:
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
	RasterImage:
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP8z8BQz0AEYBxVSFUBAFgSAf+D1M2sAAAAAElFTkSuQmCC',
	OnchainSvgImage: `data:image/svg+xml;base64,${Buffer.from(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#05070a"/><path d="M20 90h80L60 20z" fill="#1dd6ff"/><circle cx="60" cy="66" r="14" fill="#ff7a1a"/></svg>',
		'utf8'
	).toString('base64')}`,
	DynamicAnimationUrl: 'https://dynamic.example/bootstrap-preview.html'
} as const;

// Created run fixture used after the bootstrap form redirects to run detail.
export const BOOTSTRAP_PROBE_CREATED_RUN_ID = 1;

// Backend API path the redirected detail view polls in the bootstrap probe harness.
export const BOOTSTRAP_PROBE_CREATED_RUN_API_PATH = `/api/${BOOTSTRAP_PROBE_E2E_CHAIN.slug}/bootstrap-runs/${BOOTSTRAP_PROBE_CREATED_RUN_ID}`;

// Captured bootstrap writes verify the UI payload when submit behavior is tested.
export type CapturedBootstrapMutation = {
	method: string;
	path: string;
	body: unknown;
};

// E2E probe mock exposes captured reads and writes to the tests.
export type BootstrapProbeApiMock = {
	mutations: CapturedBootstrapMutation[];
	probeRequests: string[];
	openSeaSlugProbeRequests: string[];
	openSeaSlugVerificationRequests: string[];
	imageCacheEstimateRequests: unknown[];
};

// Returns deterministic bootstrap probe responses while capturing write calls.
export async function installBootstrapProbeApiMock(page: Page): Promise<BootstrapProbeApiMock> {
	const mutations: CapturedBootstrapMutation[] = [];
	const probeRequests: string[] = [];
	const openSeaSlugProbeRequests: string[] = [];
	const openSeaSlugVerificationRequests: string[] = [];
	const imageCacheEstimateRequests: unknown[] = [];

	await page.route('**/api/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());

		if (request.method() === 'GET' && url.pathname === '/api/runtime/config') {
			await fulfillJson(route, {
				integrations: {
					opensea: BOOTSTRAP_PROBE_E2E_OPENSEA_INTEGRATION
				}
			});
			return;
		}

		if (request.method() === 'GET' && url.pathname === '/api/security/csrf') {
			await fulfillJson(route, { token: 'bootstrap-probe-e2e-csrf' });
			return;
		}

		if (request.method() === 'GET' && url.pathname.endsWith('/collections/bootstrap/probe')) {
			const address = normalizeAddress(url.searchParams.get('address') ?? '');
			probeRequests.push(address);
			await fulfillJson(route, probeResponse(address));
			return;
		}

		if (
			request.method() === 'GET' &&
			url.pathname.endsWith('/collections/bootstrap/opensea-slug-probe')
		) {
			const address = normalizeAddress(url.searchParams.get('address') ?? '');
			const slug = normalizeSlug(url.searchParams.get('slug') ?? '');
			if (slug) {
				openSeaSlugVerificationRequests.push(slug);
				await fulfillJson(route, openSeaSlugProbeResponseForSlug(slug));
				return;
			}
			openSeaSlugProbeRequests.push(address);
			await fulfillJson(route, openSeaSlugProbeResponseForAddress(address));
			return;
		}

		if (
			request.method() === 'POST' &&
			url.pathname.endsWith('/collections/bootstrap/image-cache-estimate')
		) {
			const body = requestBody(request) as {
				sampleTokenId?: string;
				sourceImageBytes?: number | null;
				totalSupply?: string;
				imageCacheMode?: string;
				maxDimension?: number | null;
			};
			imageCacheEstimateRequests.push(body);
			const sourceBytes = body.sourceImageBytes ?? 4096;
			const cachedBytes =
				body.maxDimension === null ? sourceBytes : Math.max(1, Math.floor(sourceBytes / 4));
			await fulfillJson(route, {
				chain: BOOTSTRAP_PROBE_E2E_CHAIN,
				sampleTokenId: body.sampleTokenId ?? '0',
				imageCacheMode: body.imageCacheMode ?? IMAGE_CACHE_MODE.CacheOnce,
				maxDimension: body.maxDimension ?? null,
				sampleSourceBytes: sourceBytes,
				sampleCachedBytes: cachedBytes,
				projectedCachedBytes: String(cachedBytes * Number(body.totalSupply ?? '0')),
				totalSupply: body.totalSupply ?? '0',
				contentType: body.maxDimension === null ? 'image/png' : 'image/webp',
				width: body.maxDimension,
				height: body.maxDimension
			});
			return;
		}

		if (request.method() === 'POST' && url.pathname.endsWith('/collections/bootstrap')) {
			const mutation = {
				method: request.method(),
				path: url.pathname,
				body: requestBody(request)
			};
			mutations.push(mutation);
			await fulfillJson(route, {
				runId: mutations.length,
				collectionId: mutations.length,
				status: 'requested',
				createdAt: '2026-06-01T12:00:00Z'
			});
			return;
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
			body: JSON.stringify({ error: `Unhandled bootstrap probe API path: ${url.pathname}` })
		});
	});

	return {
		mutations,
		probeRequests,
		openSeaSlugProbeRequests,
		openSeaSlugVerificationRequests,
		imageCacheEstimateRequests
	};
}

function openSeaSlugProbeResponseForAddress(address: string): BootstrapOpenSeaSlugProbeApiResponse {
	if (address === BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable) {
		return buildOpenSeaSlugProbeResponse({
			address,
			requestedSlug: null,
			slug: BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable
		});
	}
	if (address === BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster) {
		return buildOpenSeaSlugProbeResponse({
			address,
			requestedSlug: null,
			slug: BOOTSTRAP_PROBE_OPENSEA_SLUGS.EnumerableRaster
		});
	}
	if (address === BOOTSTRAP_PROBE_CONTRACTS.EnumerableOnchainSvg) {
		return buildOpenSeaSlugProbeResponse({
			address,
			requestedSlug: null,
			slug: BOOTSTRAP_PROBE_OPENSEA_SLUGS.EnumerableOnchainSvg
		});
	}
	return {
		chain: BOOTSTRAP_PROBE_E2E_CHAIN,
		address,
		requestedSlug: null,
		status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Missing,
		slug: null,
		reason: 'OpenSea did not return a collection slug for this contract'
	};
}

function openSeaSlugProbeResponseForSlug(slug: string): BootstrapOpenSeaSlugProbeApiResponse {
	if (
		slug === BOOTSTRAP_PROBE_OPENSEA_SLUGS.NonEnumerable ||
		slug === BOOTSTRAP_PROBE_OPENSEA_SLUGS.EnumerableRaster ||
		slug === BOOTSTRAP_PROBE_OPENSEA_SLUGS.EnumerableOnchainSvg
	) {
		return buildOpenSeaSlugProbeResponse({
			address: null,
			requestedSlug: slug,
			slug
		});
	}
	return {
		chain: BOOTSTRAP_PROBE_E2E_CHAIN,
		address: null,
		requestedSlug: slug,
		status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Missing,
		slug: null,
		reason: 'OpenSea did not confirm this collection slug'
	};
}

function buildOpenSeaSlugProbeResponse(input: {
	address: string | null;
	requestedSlug: string | null;
	slug: string;
}): BootstrapOpenSeaSlugProbeApiResponse {
	return {
		chain: BOOTSTRAP_PROBE_E2E_CHAIN,
		address: input.address,
		requestedSlug: input.requestedSlug,
		status: BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found,
		slug: input.slug,
		reason: null
	};
}

function probeResponse(address: string): BootstrapContractProbeApiResponse {
	if (address === BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable) {
		return buildProbeResponse({
			address,
			contractName: 'Non Enumerable: Test Collection!',
			enumerable: false,
			totalSupply: '1000',
			firstTokenId: '1',
			firstTokenName: 'Non Enumerable #1',
			firstTokenImage: BOOTSTRAP_PROBE_MEDIA.NonEnumerableImage,
			firstTokenImageBytes: 34567,
			firstTokenImageContentType: 'image/png',
			firstTokenSource: 'candidate_token_uri',
			tokenUriPayloadBytes: 2048,
			manualInput: {
				mode: 'manual_range',
				startTokenId: '1',
				totalSupply: 1000
			},
			warnings: ['first token resolved through fallback checks']
		});
	}

	if (address === BOOTSTRAP_PROBE_CONTRACTS.EnumerableRaster) {
		return buildProbeResponse({
			address,
			contractName: 'Raster Images / 2026',
			enumerable: true,
			totalSupply: '7500',
			firstTokenId: '0',
			firstTokenName: 'Raster #0',
			firstTokenImage: BOOTSTRAP_PROBE_MEDIA.RasterImage,
			firstTokenImageBytes: 98234,
			firstTokenImageContentType: 'image/png',
			firstTokenSource: 'token_by_index',
			tokenUriPayloadBytes: 4096,
			animationUrl: BOOTSTRAP_PROBE_MEDIA.DynamicAnimationUrl,
			manualInput: null,
			warnings: []
		});
	}

	if (address === BOOTSTRAP_PROBE_CONTRACTS.EnumerableOnchainSvg) {
		return buildProbeResponse({
			address,
			contractName: 'Terraforms',
			enumerable: true,
			totalSupply: '9900',
			firstTokenId: '1',
			firstTokenName: 'Onchain SVG #1',
			firstTokenImage: BOOTSTRAP_PROBE_MEDIA.OnchainSvgImage,
			firstTokenImageBytes: 612,
			firstTokenImageContentType: 'image/svg+xml',
			firstTokenSource: 'token_by_index',
			tokenUriPayloadBytes: 7680,
			manualInput: null,
			warnings: [],
			imageCacheSuggestion: {
				selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension,
				extensionKey: TERRAFORMS_EXTENSION_KEY,
				config: {
					imageCacheMode: IMAGE_CACHE_MODE.Off,
					maxDimension: null
				}
			}
		});
	}

	throw new Error(`No bootstrap probe fixture for ${address}`);
}

function buildProbeResponse(input: {
	address: string;
	contractName: string;
	enumerable: boolean;
	totalSupply: string;
	firstTokenId: string;
	firstTokenName: string;
	firstTokenImage: string;
	firstTokenImageBytes: number;
	firstTokenImageContentType: string;
	firstTokenSource: 'token_by_index' | 'candidate_token_uri';
	tokenUriPayloadBytes: number;
	animationUrl?: string;
	manualInput: {
		mode: 'manual_range';
		startTokenId: string;
		totalSupply: number;
	} | null;
	warnings: string[];
	imageCacheSuggestion?: BootstrapContractProbeApiResponse['imageCacheSuggestion'];
}): BootstrapContractProbeApiResponse {
	const totalSupply = Number(input.totalSupply);
	return {
		chain: BOOTSTRAP_PROBE_E2E_CHAIN,
		address: input.address,
		standard: 'erc721',
		contractName: input.contractName,
		erc721: {
			supported: true,
			error: null
		},
		enumerable: {
			supported: input.enumerable,
			error: input.enumerable ? null : 'ContractFunctionZeroDataError'
		},
		totalSupply: {
			status: 'available',
			value: input.totalSupply,
			safeIntegerValue: totalSupply,
			bootstrapRangeValue: totalSupply,
			error: null
		},
		firstToken: {
			tokenId: input.firstTokenId,
			source: input.firstTokenSource,
			tokenUri: `ipfs://metadata/${input.firstTokenId}`,
			tokenUriPayloadBytes: input.tokenUriPayloadBytes,
			tokenUriPayloadTruncated: false,
			tokenUriPayloadError: null,
			name: input.firstTokenName,
			image: input.firstTokenImage,
			imageBytes: input.firstTokenImageBytes,
			imageBytesSource: input.firstTokenImage.startsWith('data:') ? 'data_uri' : 'download',
			imageContentType: input.firstTokenImageContentType,
			imageBytesError: null,
			animationUrl: input.animationUrl ?? null,
			metadataError: null,
			candidates: []
		},
		storageEstimate: {
			sampleTokenId: input.firstTokenId,
			samplePayloadBytes: input.tokenUriPayloadBytes,
			projectedBytes: String(input.tokenUriPayloadBytes * totalSupply),
			totalSupply: input.totalSupply
		},
		imageStorageEstimate: {
			sampleTokenId: input.firstTokenId,
			sampleImageBytes: input.firstTokenImageBytes,
			projectedBytes: String(input.firstTokenImageBytes * totalSupply),
			totalSupply: input.totalSupply,
			contentType: input.firstTokenImageContentType
		},
		suggestedInput: {
			supportsEnumerable: input.enumerable,
			manualInput: input.manualInput,
			ready: true,
			warnings: input.warnings
		},
		imageCacheSuggestion: input.imageCacheSuggestion ?? {
			selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
			extensionKey: null,
			config: {
				imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
				maxDimension: BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION
			}
		}
	};
}

function requestBody(request: Request): unknown {
	const raw = request.postData();
	if (!raw) {
		return {};
	}
	return JSON.parse(raw) as unknown;
}

function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

function normalizeSlug(slug: string): string {
	return slug.trim().toLowerCase();
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
	await route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify(body)
	});
}
