import type { Page, Request } from 'playwright/test';
import type { ApiBiddingJob } from '../../src/lib/api-types';
import {
	buildCompetitionPresetsPath,
	buildCompetitionPresetReapplyPreviewPath,
	buildCompetitionPresetReapplyPath
} from '@artgod/shared/http/trading-routes';
import type { BatchTokenBiddingJobSelectionRequest } from '../../src/lib/backend-api';
import { buildCollectionBiddingQuery } from '../../src/lib/bidding-query';
import {
	normalizeExtraCompetitionTraits,
	normalizeCompetitionPresetTarget,
	assertCompetitionPresetSourceUnchanged,
	TraitCompetitionValidationError
} from '@artgod/shared/trading/trait-competition';
import {
	TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
	TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
	TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND,
	TRADING_BIDDING_BID_SCOPE_KIND,
	TRADING_JOB_STATUS,
	TRADING_JOB_TARGET_KIND,
	type TradingCompetitionPresetReapplySelection,
	normalizeTradingTraitCriteria
} from '@artgod/shared/types';
import { COLLECTION_BIDDING_BID_SCOPE_FILTER } from '@artgod/shared/types';
import {
	BIDDING_E2E_COMPETITION_PRESETS,
	BIDDING_E2E_COMPETITION_PRESET_ID,
	biddingCompetitionPresetFixture,
	BIDDING_E2E_FACETS,
	BIDDING_E2E_CHAIN,
	BIDDING_E2E_COLLECTION,
	BIDDING_E2E_PRICE_TIERS,
	BIDDING_E2E_SCENARIO_QUERY_PARAM,
	BIDDING_E2E_SETTINGS,
	buildBiddingE2eCollectionBiddingData,
	buildBiddingE2eCompetitionReapplyFixture,
	BIDDING_E2E_REAPPLY_JOB_ID,
	buildBiddingE2eTokenDetailData,
	biddingE2ePriceTiersForScenario,
	findBiddingE2eJobForTarget,
	type BiddingE2eScenario
} from '../../src/lib/e2e/bidding-automation-fixtures';

export type CapturedBiddingMutation = {
	method: string;
	path: string;
	body: unknown;
};

export type BiddingAutomationApiMock = {
	mutations: CapturedBiddingMutation[];
	nextMutation(): Promise<CapturedBiddingMutation>;
	setBidBookScenario(scenario: BiddingE2eScenario): void;
	reviseCompetitionReapplyJob(jobId: string): void;
};

const BIDDING_E2E_API_PATH_SUFFIX = {
	BatchTokenLookup: '/bidding/jobs/tokens/lookup'
} as const;

// Captures bidding write calls while returning deterministic API responses to the real UI.
export async function installBiddingAutomationApiMock(
	page: Page,
	options: { competitionReapply?: boolean } = {}
): Promise<BiddingAutomationApiMock> {
	const mutations: CapturedBiddingMutation[] = [];
	const reapplyFixture = options.competitionReapply
		? buildBiddingE2eCompetitionReapplyFixture()
		: null;
	let competitionPresets = [...(reapplyFixture?.presets ?? BIDDING_E2E_COMPETITION_PRESETS)];
	const competitionVersions = new Map(
		(reapplyFixture?.versions ?? competitionPresets).map((p) => [p.versionId, p])
	);
	const reapplyJobs = new Map<string, ApiBiddingJob>(
		(reapplyFixture?.jobs ?? []).map((job) => [job.jobId, job])
	);
	const competitionSelections = new Map<string, string | null>();
	function findReapplyJob(targetTraits: unknown, quantity = 1): ApiBiddingJob | undefined {
		if (!Array.isArray(targetTraits)) return undefined;
		const signature = JSON.stringify(normalizeTradingTraitCriteria(targetTraits));
		return [...reapplyJobs.values()].find(
			(job) =>
				job.target.type === TRADING_JOB_TARGET_KIND.Collection &&
				job.target.quantity === quantity &&
				JSON.stringify(normalizeTradingTraitCriteria(job.target.targetTraits)) === signature
		);
	}
	let pendingResolve: ((mutation: CapturedBiddingMutation) => void) | null = null;
	let activeScenario: string | null = null;
	let bidBookScenarioOverride: BiddingE2eScenario | null = null;

	// Retain harness-only scenario state when production navigation rebuilds the query string.
	page.on('framenavigated', (frame) => {
		if (frame !== page.mainFrame()) {
			return;
		}
		const scenario = new URL(frame.url()).searchParams.get(BIDDING_E2E_SCENARIO_QUERY_PARAM);
		if (scenario) {
			activeScenario = scenario;
		}
	});

	await page.route('**/api/security/csrf', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ token: 'e2e-csrf-token' })
		});
	});

	await page.route('**/traits/catalog**', async (route) => {
		await route.fulfill({
			json: {
				chain: BIDDING_E2E_CHAIN,
				collection: BIDDING_E2E_COLLECTION,
				traitCatalog: { scope: [], facets: BIDDING_E2E_FACETS }
			}
		});
	});
	await page.route('**/api/**/bidding/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const body = requestBody(request);

		if (request.method() === 'GET' && url.pathname.endsWith('/bidding/competition-presets')) {
			await route.fulfill({ json: { presets: competitionPresets } });
			return;
		}
		const preset = competitionPresets.find(
			(p) =>
				url.pathname ===
					buildCompetitionPresetReapplyPreviewPath(
						BIDDING_E2E_CHAIN.slug,
						BIDDING_E2E_COLLECTION.slug,
						p.presetId
					) ||
				url.pathname ===
					buildCompetitionPresetReapplyPath(
						BIDDING_E2E_CHAIN.slug,
						BIDDING_E2E_COLLECTION.slug,
						p.presetId
					)
		);
		if (preset && request.method() === 'GET') {
			const jobs = [...reapplyJobs.values()]
				.filter(
					(job) =>
						job.status !== TRADING_JOB_STATUS.Archived &&
						job.config.competitionPreset?.presetId === preset.presetId
				)
				.map((job) => ({
					job,
					before: job.config.competitionPreset!,
					after: preset,
					changed: job.config.competitionPreset!.versionId !== preset.versionId,
					error:
						job.jobId === BIDDING_E2E_REAPPLY_JOB_ID.Ineligible
							? 'target trait is not available for marketplace bidding: Biome=removed'
							: null
				}));
			await route.fulfill({
				json: { chain: BIDDING_E2E_CHAIN, collection: BIDDING_E2E_COLLECTION, preset, jobs }
			});
			return;
		}
		if (url.pathname.endsWith('/bidding/jobs/target-lookup')) {
			const target = (body as { target?: { targetTraits?: unknown; quantity?: number } }).target;
			const override = findReapplyJob(target?.targetTraits, target?.quantity);
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					chain: BIDDING_E2E_CHAIN,
					collection: BIDDING_E2E_COLLECTION,
					job: override ?? findBiddingE2eJobForTarget(body)
				})
			});
			return;
		}

		if (url.pathname.endsWith(BIDDING_E2E_API_PATH_SUFFIX.BatchTokenLookup)) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(
					batchTokenLookupResponse(body, bidBookScenarioOverride ?? activeScenario)
				)
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
					tiers: biddingE2ePriceTiersForScenario(activeScenario)
				})
			});
			return;
		}

		if (request.method() === 'GET' && url.pathname.endsWith('/bidding/bids')) {
			const searchParams = biddingFixtureSearchParams(url, request, activeScenario);
			if (bidBookScenarioOverride)
				searchParams.set(BIDDING_E2E_SCENARIO_QUERY_PARAM, bidBookScenarioOverride);
			activeScenario = searchParams.get(BIDDING_E2E_SCENARIO_QUERY_PARAM) ?? activeScenario;
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(bidBookResponse(url, searchParams))
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

		if (preset && request.method() === 'POST') {
			const selection = body as {
				expectedRevision: number;
				jobs: TradingCompetitionPresetReapplySelection[];
			};
			const selected = selection.jobs.map((row) => reapplyJobs.get(row.jobId));
			if (
				selection.expectedRevision !== preset.revision ||
				selected.some(
					(job, index) =>
						!job ||
						job.revision !== selection.jobs[index].expectedRevision ||
						job.config.competitionPreset?.versionId !== selection.jobs[index].versionId
				)
			) {
				await route.fulfill({
					status: 422,
					json: { message: 'Selected jobs changed. Preview reapply again.' }
				});
				return;
			}
			const jobs = selected.map((job) => ({
				...job!,
				revision: job!.revision + 1,
				config: { ...job!.config, competitionPreset: preset }
			}));
			jobs.forEach((job) => reapplyJobs.set(job.jobId, job));
			await route.fulfill({
				json: { chain: BIDDING_E2E_CHAIN, collection: BIDDING_E2E_COLLECTION, preset, jobs }
			});
			return;
		}
		if (
			url.pathname ===
				buildCompetitionPresetsPath(BIDDING_E2E_CHAIN.slug, BIDDING_E2E_COLLECTION.slug) ||
			competitionPresets.some(
				(p) =>
					url.pathname ===
					buildCompetitionPresetsPath(
						BIDDING_E2E_CHAIN.slug,
						BIDDING_E2E_COLLECTION.slug,
						p.presetId
					)
			)
		) {
			if (request.method() === 'DELETE') {
				competitionPresets = competitionPresets.filter(
					(p) => p.presetId !== decodeURIComponent(url.pathname.split('/').at(-1)!)
				);
			} else {
				const definition = body as {
					presetId?: string;
					targetTraits: { type: string; value?: string }[];
					extraCompetitionTraits: { type: string; value?: string }[];
				};
				const presetId = definition.presetId ?? BIDDING_E2E_COMPETITION_PRESET_ID.Created;
				const previous = competitionPresets.find((p) => p.presetId === presetId);
				if (previous) {
					try {
						assertCompetitionPresetSourceUnchanged(previous.targetTraits, definition.targetTraits);
					} catch (error) {
						if (!(error instanceof TraitCompetitionValidationError)) throw error;
						await route.fulfill({ status: 422, json: { message: error.message } });
						return;
					}
				}
				const saved = biddingCompetitionPresetFixture(
					presetId,
					normalizeCompetitionPresetTarget(definition.targetTraits),
					normalizeExtraCompetitionTraits(definition.extraCompetitionTraits),
					(previous?.revision ?? 0) + 1
				);
				competitionVersions.set(saved.versionId, saved);
				competitionPresets = [...competitionPresets.filter((p) => p.presetId !== presetId), saved];
			}
			await route.fulfill({ json: { presets: competitionPresets } });
			return;
		}
		const response = mutationResponse(
			url.pathname,
			body,
			bidBookScenarioOverride ?? activeScenario
		) as { job?: ApiBiddingJob };
		if (response.job && url.pathname.endsWith('/bidding/jobs/traits')) {
			const existing = findReapplyJob(
				mutationTargetTraits(body),
				(body as { quantity?: number }).quantity
			);
			const targetKey = JSON.stringify(normalizeTradingTraitCriteria(mutationTargetTraits(body)));
			const requestedVersionId = (body as { competitionPresetVersionId?: string | null })
				.competitionPresetVersionId;
			// Match the real mutation contract: omission preserves, null explicitly clears.
			const versionId =
				requestedVersionId === undefined
					? existing
						? (existing.config.competitionPreset?.versionId ?? null)
						: competitionSelections.has(targetKey)
							? competitionSelections.get(targetKey)!
							: (findBiddingE2eJobForTarget({
									target: {
										type: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
										targetTraits: mutationTargetTraits(body)
									}
								})?.config.competitionPreset?.versionId ?? null)
					: requestedVersionId;
			competitionSelections.set(targetKey, versionId);
			response.job.config.competitionPreset = versionId
				? (competitionVersions.get(versionId) ?? null)
				: null;
			if (existing) {
				// Real upserts retain identity, bump revision and preserve the pinned
				// reference on omitted input, including after a bulk reapply.
				response.job = {
					...response.job,
					jobId: existing.jobId,
					revision: existing.revision + 1,
					target: existing.target
				};
				reapplyJobs.set(existing.jobId, response.job);
			}
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(response)
		});
	});

	return {
		mutations,
		reviseCompetitionReapplyJob: (jobId) => {
			const job = reapplyJobs.get(jobId);
			if (!job) throw new Error(`Unknown reapply fixture job: ${jobId}`);
			reapplyJobs.set(jobId, { ...job, revision: job.revision + 1 });
		},
		setBidBookScenario: (scenario) => {
			bidBookScenarioOverride = scenario;
		},
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

function mutationResponse(path: string, body: unknown, scenario: string | null): unknown {
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
		const tokenIds = batchMutationTokenIds(body, scenario);
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
			competitionPreset: null,
			pricingSource: null
		},
		runtime: null
	};
}

function bidBookResponse(url: URL, searchParams: URLSearchParams): unknown {
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
		ownBidStateCounts: data.ownBidStateCounts,
		tokenOfferCards: data.tokenOfferCards
	};
}

function biddingFixtureSearchParams(
	url: URL,
	request: Request,
	activeScenario: string | null
): URLSearchParams {
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
		if (!searchParams.has(BIDDING_E2E_SCENARIO_QUERY_PARAM) && activeScenario) {
			searchParams.set(BIDDING_E2E_SCENARIO_QUERY_PARAM, activeScenario);
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
		BIDDING_E2E_PRICE_TIERS.find((item) => item.tierId === tierId) ?? BIDDING_E2E_PRICE_TIERS[0];
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

function batchMutationTokenIds(body: unknown, scenario: string | null): string[] {
	if (!isBatchMutationBody(body)) {
		return ['999'];
	}
	if (body.selection.type === TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenIds) {
		return body.selection.tokenIds;
	}
	if (body.selection.type === TRADING_BATCH_TOKEN_BIDDING_JOB_SELECTION_KIND.TokenOfferFilter) {
		const selection = body.selection;
		const query = buildCollectionBiddingQuery({
			bidScope: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
			selectedTraits: selection.traits,
			selectedTraitRanges: selection.traitRanges,
			traitJoinMode: selection.traitJoinMode,
			maker: selection.makerAddress,
			ownershipFilter: selection.ownershipFilter,
			ownStateFilter: selection.ownStateFilter
		});
		if (scenario) query.set(BIDDING_E2E_SCENARIO_QUERY_PARAM, scenario);
		const tokenIds: string[] = [];
		let cursor: string | null = null;
		do {
			if (cursor) query.set('cursor', cursor);
			const page = buildBiddingE2eCollectionBiddingData(query).tokenOfferCards;
			tokenIds.push(...page.items.map((card) => card.tokenId));
			cursor = page.nextCursor;
		} while (cursor);
		return tokenIds;
	}
	return ['101', '102'];
}

function batchTokenLookupResponse(body: unknown, scenario: string | null): unknown {
	const tokenIds = batchMutationTokenIds(body, scenario);
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
	return biddingIndex > 0 ? (parts[biddingIndex - 1] ?? null) : null;
}

function tokenIdFromTokenScopedBiddingPath(path: string): string | null {
	const parts = path.split('/').filter(Boolean);
	const biddingIndex = parts.indexOf('bidding');
	return biddingIndex > 3 ? (parts[biddingIndex - 1] ?? null) : null;
}

function isJobMutationBody(value: unknown): value is {
	status: string;
	floorEth?: string;
	ceilingEth?: string;
	deltaEth?: string;
	competitionPresetVersionId?: string | null;
} {
	return !!value && typeof value === 'object';
}

function isBatchMutationBody(value: unknown): value is {
	selection: BatchTokenBiddingJobSelectionRequest;
} {
	return (
		!!value &&
		typeof value === 'object' &&
		!!(value as { selection?: unknown }).selection &&
		typeof (value as { selection: { type?: unknown } }).selection.type === 'string'
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
