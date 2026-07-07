import type { Page, Request } from 'playwright/test';
import {
	TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
	TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
	TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND,
	TRADING_JOB_STATUS,
	TRADING_JOB_TARGET_KIND
} from '@artgod/shared/types';
import {
	BIDDING_E2E_CHAIN,
	BIDDING_E2E_COLLECTION,
	BIDDING_E2E_PRICE_TIERS,
	BIDDING_E2E_SCENARIO_QUERY_PARAM,
	BIDDING_E2E_SETTINGS,
	buildBiddingE2eCollectionBiddingData,
	buildBiddingE2eTokenDetailData,
	findBiddingE2eJobForTarget
} from '../../src/lib/e2e/bidding-automation-fixtures';

export type CapturedBiddingMutation = {
	method: string;
	path: string;
	body: unknown;
};

export type BiddingAutomationApiMock = {
	mutations: CapturedBiddingMutation[];
	nextMutation(): Promise<CapturedBiddingMutation>;
};

const BIDDING_E2E_API_PATH_SUFFIX = {
	BatchTokenLookup: '/bidding/jobs/tokens/lookup'
} as const;

// Captures bidding write calls while returning deterministic API responses to the real UI.
export async function installBiddingAutomationApiMock(page: Page): Promise<BiddingAutomationApiMock> {
	const mutations: CapturedBiddingMutation[] = [];
	let pendingResolve: ((mutation: CapturedBiddingMutation) => void) | null = null;

	await page.route('**/api/security/csrf', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ token: 'e2e-csrf-token' })
		});
	});

	await page.route('**/api/**/bidding/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const body = requestBody(request);

		if (url.pathname.endsWith('/bidding/jobs/target-lookup')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					chain: BIDDING_E2E_CHAIN,
					collection: BIDDING_E2E_COLLECTION,
					job: findBiddingE2eJobForTarget(body)
				})
			});
			return;
		}

		if (url.pathname.endsWith(BIDDING_E2E_API_PATH_SUFFIX.BatchTokenLookup)) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(batchTokenLookupResponse(body))
			});
			return;
		}

		if (request.method() === 'GET' && url.pathname.endsWith('/bidding/price-tiers')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					chain: BIDDING_E2E_CHAIN,
					collection: BIDDING_E2E_COLLECTION,
					settings: BIDDING_E2E_SETTINGS,
					tiers: BIDDING_E2E_PRICE_TIERS
				})
			});
			return;
		}

		if (request.method() === 'GET' && url.pathname.endsWith('/bidding/bids')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(bidBookResponse(url, request))
			});
			return;
		}

		if (request.method() === 'GET' && url.pathname.endsWith('/reapply-preview')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(reapplyPreviewResponse(url.pathname))
			});
			return;
		}

		const mutation = {
			method: request.method(),
			path: url.pathname,
			body
		};
		if (pendingResolve) {
			const resolve = pendingResolve;
			pendingResolve = null;
			resolve(mutation);
		} else {
			mutations.push(mutation);
		}

		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(mutationResponse(url.pathname, body))
		});
	});

	return {
		mutations,
		nextMutation: () =>
			new Promise((resolve) => {
				const existing = mutations.shift();
				if (existing) {
					resolve(existing);
					return;
				}
				pendingResolve = resolve;
			})
	};
}

function requestBody(request: Request): unknown {
	const raw = request.postData();
	if (!raw) {
		return {};
	}
	return JSON.parse(raw) as unknown;
}

function mutationResponse(path: string, body: unknown): unknown {
	if (path.endsWith('/bidding/settings')) {
		return {
			chain: BIDDING_E2E_CHAIN,
			collection: BIDDING_E2E_COLLECTION,
			settings: {
				...BIDDING_E2E_SETTINGS,
				...(isSettingsMutationBody(body) ? body : {})
			}
		};
	}

	if (path.endsWith('/reapply')) {
		const preview = reapplyPreviewResponse(path).jobs;
		return {
			...reapplyPreviewResponse(path),
			jobs: preview.map((item) => item.job),
			preview
		};
	}

	if (path.endsWith('/bidding/price-tiers')) {
		const tier = priceTierFromMutation(body);
		return {
			chain: BIDDING_E2E_CHAIN,
			collection: BIDDING_E2E_COLLECTION,
			tier,
			tiers: [tier, ...BIDDING_E2E_PRICE_TIERS.filter((item) => item.tierId !== tier.tierId)]
		};
	}

	if (path.endsWith('/bidding/jobs/tokens/batch')) {
		const tokenIds = batchMutationTokenIds(body);
		return {
			chain: BIDDING_E2E_CHAIN,
			collection: BIDDING_E2E_COLLECTION,
			tokenIds,
			jobs: tokenIds.map((tokenId, index) =>
				jobResponse({
					jobId: `job-batch-${tokenId}`,
					target: {
						type: TRADING_JOB_TARGET_KIND.Token,
						tokenId
					},
					body,
					revision: index + 1
				})
			)
		};
	}

	if (path.endsWith('/bidding/jobs/traits')) {
		return {
			chain: BIDDING_E2E_CHAIN,
			collection: BIDDING_E2E_COLLECTION,
			job: jobResponse({
				jobId: 'job-trait-mutated',
				target: {
					type: TRADING_JOB_TARGET_KIND.Collection,
					quantity: 1,
					targetTraits: mutationTargetTraits(body)
				},
				body,
				revision: 1
			})
		};
	}

	if (path.endsWith('/bidding/jobs/collection')) {
		return {
			chain: BIDDING_E2E_CHAIN,
			collection: BIDDING_E2E_COLLECTION,
			job: jobResponse({
				jobId: 'job-collection',
				target: {
					type: TRADING_JOB_TARGET_KIND.Collection,
					quantity: 1,
					targetTraits: []
				},
				body,
				revision: 5
			})
		};
	}

	if (path.includes('/bidding/jobs/') && path.endsWith('/bidding/job') === false) {
		return {
			chain: BIDDING_E2E_CHAIN,
			collection: BIDDING_E2E_COLLECTION,
			job: jobResponse({
				jobId: path.split('/').at(-1) ?? 'job-archived',
				target: {
					type: TRADING_JOB_TARGET_KIND.Token,
					tokenId: '101'
				},
				body: { status: TRADING_JOB_STATUS.Archived, deltaEth: '0.004' },
				revision: 9
			})
		};
	}

	const tokenId = tokenIdFromTokenJobPath(path) ?? '999';
	return {
		chain: BIDDING_E2E_CHAIN,
		collection: BIDDING_E2E_COLLECTION,
		tokenId,
		job: jobResponse({
			jobId: `job-token-${tokenId}`,
			target: {
				type: TRADING_JOB_TARGET_KIND.Token,
				tokenId
			},
			body,
			revision: 1
		})
	};
}

function jobResponse(input: {
	jobId: string;
	target: unknown;
	body: unknown;
	revision: number;
}): unknown {
	const body = isJobMutationBody(input.body) ? input.body : null;
	return {
		jobId: input.jobId,
		status: body?.status ?? TRADING_JOB_STATUS.Enabled,
		revision: input.revision,
		createdAt: '2026-05-01T12:00:00Z',
		updatedAt: '2026-05-01T12:00:00Z',
		archivedAt: null,
		target: input.target,
		config: {
			floorEth: body?.floorEth ?? '0.100',
			ceilingEth: body?.ceilingEth ?? '0.200',
			deltaEth: body?.deltaEth ?? '0.004',
			pricingSource: null
		},
		runtime: null
	};
}

function bidBookResponse(url: URL, request: Request): unknown {
	const searchParams = biddingFixtureSearchParams(url, request);
	const tokenId = tokenIdFromTokenScopedBiddingPath(url.pathname);
	if (tokenId) {
		const data = buildBiddingE2eTokenDetailData(tokenId, searchParams);
		return {
			chain: data.chain,
			collection: data.collection,
			tokenId: data.token.tokenId,
			bidBook: data.tokenBiddingBidBook
		};
	}

	const data = buildBiddingE2eCollectionBiddingData(searchParams);
	return {
		chain: data.chain,
		collection: data.collection,
		media: data.media,
		scopeFilter: data.bidScope,
		traits: {
			selected: data.selectedTraits,
			selectedRanges: data.selectedTraitRanges,
			facets: data.facets
		},
		bidBook: data.bidBook,
		tokenOfferCards: data.tokenOfferCards
	};
}

function biddingFixtureSearchParams(url: URL, request: Request): URLSearchParams {
	const searchParams = new URLSearchParams(url.searchParams);
	if (!searchParams.has(BIDDING_E2E_SCENARIO_QUERY_PARAM)) {
		const referer = request.headers().referer;
		if (referer) {
			const refererParams = new URL(referer).searchParams;
			const scenario = refererParams.get(BIDDING_E2E_SCENARIO_QUERY_PARAM);
			if (scenario) {
				searchParams.set(BIDDING_E2E_SCENARIO_QUERY_PARAM, scenario);
			}
		}
	}
	return searchParams;
}

function priceTierFromMutation(body: unknown): unknown {
	if (!isPriceTierMutationBody(body)) {
		return BIDDING_E2E_PRICE_TIERS[0];
	}
	return {
		...BIDDING_E2E_PRICE_TIERS[0],
		tierId: body.tierId ?? 'tier-created',
		name: body.name,
		status: body.status,
		sortOrder: body.sortOrder,
		parentTierId: body.parentTierId,
		floorConfig: body.floorConfig,
		ceilingConfig: body.ceilingConfig,
		deltaEth: body.deltaEth,
		resolvedFloorEth:
			body.floorConfig.kind === TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed
				? body.floorConfig.valueEth
				: BIDDING_E2E_PRICE_TIERS[0].resolvedFloorEth,
		resolvedCeilingEth:
			body.ceilingConfig.kind === TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed
				? body.ceilingConfig.valueEth
				: BIDDING_E2E_PRICE_TIERS[0].resolvedCeilingEth,
		revision: 2
	};
}

function reapplyPreviewResponse(path: string) {
	const tierId = path.split('/price-tiers/')[1]?.split('/')[0] ?? 'tier-base';
	const tier =
		BIDDING_E2E_PRICE_TIERS.find((item) => item.tierId === tierId) ??
		BIDDING_E2E_PRICE_TIERS[0];
	const changedJob = jobResponse({
		jobId: 'job-token-101',
		target: {
			type: TRADING_JOB_TARGET_KIND.Token,
			tokenId: '101'
		},
		body: {
			status: TRADING_JOB_STATUS.Enabled,
			floorEth: '0.700',
			ceilingEth: '0.720',
			deltaEth: '0.010'
		},
		revision: 2
	});
	return {
		chain: BIDDING_E2E_CHAIN,
		collection: BIDDING_E2E_COLLECTION,
		tier,
		jobs: [
			{
				job: changedJob,
				before: {
					floorEth: '0.700',
					ceilingEth: '0.720',
					deltaEth: '0.010',
					pricingSource: null
				},
				after: {
					floorEth: tier.resolvedFloorEth,
					ceilingEth: tier.resolvedCeilingEth,
					deltaEth: tier.deltaEth,
					pricingSource: null
				},
				changed: true
			}
		]
	};
}

function batchMutationTokenIds(body: unknown): string[] {
	if (!isBatchMutationBody(body)) {
		return ['999'];
	}
	if (body.selection.type === TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds) {
		return body.selection.tokenIds;
	}
	return ['101', '102'];
}

function batchTokenLookupResponse(body: unknown): unknown {
	const tokenIds = batchMutationTokenIds(body);
	return {
		chain: BIDDING_E2E_CHAIN,
		collection: BIDDING_E2E_COLLECTION,
		jobs: [],
		targetCount: tokenIds.length
	};
}

function mutationTargetTraits(body: unknown): { type: string; value: string }[] {
	return isTraitMutationBody(body) ? body.targetTraits : [];
}

function tokenIdFromTokenJobPath(path: string): string | null {
	const parts = path.split('/').filter(Boolean);
	const biddingIndex = parts.indexOf('bidding');
	return biddingIndex > 0 ? parts[biddingIndex - 1] ?? null : null;
}

function tokenIdFromTokenScopedBiddingPath(path: string): string | null {
	const parts = path.split('/').filter(Boolean);
	const biddingIndex = parts.indexOf('bidding');
	return biddingIndex > 3 ? parts[biddingIndex - 1] ?? null : null;
}

function isJobMutationBody(value: unknown): value is {
	status: string;
	floorEth?: string;
	ceilingEth?: string;
	deltaEth?: string;
} {
	return !!value && typeof value === 'object';
}

function isBatchMutationBody(value: unknown): value is {
	selection:
		| { type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds; tokenIds: string[] }
		| { type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenBrowserFilter }
		| { type: typeof TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter };
} {
	return (
		!!value &&
		typeof value === 'object' &&
		!!(value as { selection?: unknown }).selection &&
		typeof ((value as { selection: { type?: unknown } }).selection.type) === 'string'
	);
}

function isTraitMutationBody(value: unknown): value is {
	targetTraits: { type: string; value: string }[];
} {
	return (
		!!value &&
		typeof value === 'object' &&
		Array.isArray((value as { targetTraits?: unknown }).targetTraits)
	);
}

function isSettingsMutationBody(value: unknown): value is {
	tierSelectionMode: string;
	defaultDeltaEth: string;
} {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as { tierSelectionMode?: unknown }).tierSelectionMode === 'string' &&
		typeof (value as { defaultDeltaEth?: unknown }).defaultDeltaEth === 'string'
	);
}

function isPriceTierMutationBody(value: unknown): value is {
	tierId?: string;
	name: string;
	status: string;
	sortOrder: number;
	parentTierId: string | null;
	floorConfig: { kind: string; valueEth?: string };
	ceilingConfig: { kind: string; valueEth?: string };
	deltaEth: string;
} {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as { name?: unknown }).name === 'string' &&
		typeof (value as { deltaEth?: unknown }).deltaEth === 'string'
	);
}
