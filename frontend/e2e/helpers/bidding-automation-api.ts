import type { Page, Request } from 'playwright/test';
import {
	TRADING_BIDDING_BID_SCOPE_KIND,
	TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND,
	TRADING_JOB_STATUS,
	TRADING_JOB_TARGET_KIND
} from '@artgod/shared/types';

const E2E_CHAIN = {
	id: 1,
	type: 'evm',
	publicChainId: 1,
	slug: 'ethereum',
	name: 'Ethereum'
};

const E2E_COLLECTION = {
	chainId: 1,
	collectionId: 1,
	slug: 'e2e-bidding',
	address: '0x1111111111111111111111111111111111111111',
	standard: 'erc721',
	status: 'live',
	deploymentBlock: 1,
	bootstrapAnchorBlock: null,
	createdAt: '2026-05-01T12:00:00Z',
	updatedAt: '2026-05-01T12:00:00Z'
};

export type CapturedBiddingMutation = {
	method: string;
	path: string;
	body: unknown;
};

export type BiddingAutomationApiMock = {
	mutations: CapturedBiddingMutation[];
	nextMutation(): Promise<CapturedBiddingMutation>;
};

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
					chain: E2E_CHAIN,
					collection: E2E_COLLECTION,
					job: existingJobForLookup(body)
				})
			});
			return;
		}

		const mutation = {
			method: request.method(),
			path: url.pathname,
			body
		};
		mutations.push(mutation);
		pendingResolve?.(mutation);
		pendingResolve = null;

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
	if (path.endsWith('/bidding/jobs/tokens/batch')) {
		const tokenIds = batchMutationTokenIds(body);
		return {
			chain: E2E_CHAIN,
			collection: E2E_COLLECTION,
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
			chain: E2E_CHAIN,
			collection: E2E_COLLECTION,
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
			chain: E2E_CHAIN,
			collection: E2E_COLLECTION,
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
			chain: E2E_CHAIN,
			collection: E2E_COLLECTION,
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
		chain: E2E_CHAIN,
		collection: E2E_COLLECTION,
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

function existingJobForLookup(body: unknown): unknown {
	if (!isLookupBody(body)) {
		return null;
	}
	const { target } = body;
	if (target.type === TRADING_JOB_TARGET_KIND.Token && target.tokenId === '101') {
		return jobResponse({
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
	}
	if (
		target.type === TRADING_BIDDING_BID_SCOPE_KIND.Trait &&
		target.targetTraits.length === 1 &&
		target.targetTraits[0]?.type === 'Biome' &&
		target.targetTraits[0]?.value === '42'
	) {
		return jobResponse({
			jobId: 'job-trait-biome-42',
			target: {
				type: TRADING_JOB_TARGET_KIND.Collection,
				quantity: 1,
				targetTraits: [{ type: 'Biome', value: '42' }]
			},
			body: {
				status: TRADING_JOB_STATUS.Enabled,
				floorEth: '0.350',
				ceilingEth: '0.400',
				deltaEth: '0.004'
			},
			revision: 3
		});
	}
	if (target.type === TRADING_JOB_TARGET_KIND.Collection) {
		return jobResponse({
			jobId: 'job-collection',
			target: {
				type: TRADING_JOB_TARGET_KIND.Collection,
				quantity: 1,
				targetTraits: []
			},
			body: {
				status: TRADING_JOB_STATUS.Paused,
				floorEth: '0.350',
				ceilingEth: '0.500',
				deltaEth: '0.004'
			},
			revision: 4
		});
	}
	return null;
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

function batchMutationTokenIds(body: unknown): string[] {
	if (!isBatchMutationBody(body)) {
		return ['999'];
	}
	if (body.selection.type === TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds) {
		return body.selection.tokenIds;
	}
	return ['101', '102'];
}

function mutationTargetTraits(body: unknown): { type: string; value: string }[] {
	return isTraitMutationBody(body) ? body.targetTraits : [];
}

function tokenIdFromTokenJobPath(path: string): string | null {
	const parts = path.split('/').filter(Boolean);
	const biddingIndex = parts.indexOf('bidding');
	return biddingIndex > 0 ? parts[biddingIndex - 1] ?? null : null;
}

function isLookupBody(value: unknown): value is {
	target:
		| { type: typeof TRADING_JOB_TARGET_KIND.Token; tokenId: string }
		| { type: typeof TRADING_JOB_TARGET_KIND.Collection; quantity?: number }
		| {
				type: typeof TRADING_BIDDING_BID_SCOPE_KIND.Trait;
				quantity?: number;
				targetTraits: { type: string; value: string }[];
		  };
} {
	return (
		!!value &&
		typeof value === 'object' &&
		!!(value as { target?: unknown }).target &&
		typeof ((value as { target: { type?: unknown } }).target.type) === 'string'
	);
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
