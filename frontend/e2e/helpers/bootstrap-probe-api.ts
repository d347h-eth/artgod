import type { Page, Request, Route } from 'playwright/test';
import type { BootstrapContractProbeApiResponse } from '../../src/lib/api-types';
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
};

// Returns deterministic bootstrap probe responses while capturing write calls.
export async function installBootstrapProbeApiMock(page: Page): Promise<BootstrapProbeApiMock> {
	const mutations: CapturedBootstrapMutation[] = [];
	const probeRequests: string[] = [];

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

		await route.fulfill({
			status: 500,
			contentType: 'application/json',
			body: JSON.stringify({ error: `Unhandled bootstrap probe API path: ${url.pathname}` })
		});
	});

	return {
		mutations,
		probeRequests
	};
}

function probeResponse(address: string): BootstrapContractProbeApiResponse {
	if (address === BOOTSTRAP_PROBE_CONTRACTS.NonEnumerable) {
		return buildProbeResponse({
			address,
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
			warnings: []
		});
	}

	throw new Error(`No bootstrap probe fixture for ${address}`);
}

function buildProbeResponse(input: {
	address: string;
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
}): BootstrapContractProbeApiResponse {
	const totalSupply = Number(input.totalSupply);
	return {
		chain: BOOTSTRAP_PROBE_E2E_CHAIN,
		address: input.address,
		standard: 'erc721',
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
			totalSupply: input.totalSupply
		},
		suggestedInput: {
			supportsEnumerable: input.enumerable,
			manualInput: input.manualInput,
			ready: true,
			warnings: input.warnings
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

async function fulfillJson(route: Route, body: unknown): Promise<void> {
	await route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify(body)
	});
}
