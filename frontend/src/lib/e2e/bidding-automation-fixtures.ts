import {
	TERRAFORMS_BIOME_ATTRIBUTE_KEY,
	TERRAFORMS_EXTENSION_KEY,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES,
	TERRAFORMS_ZONE_ATTRIBUTE_KEY
} from '@artgod/shared/extensions/terraforms';
import {
	COLLECTION_BIDDING_BID_SCOPE_FILTER,
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
	TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
	TRADING_BIDDING_BID_BOOK_PRICE_KIND,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_BIDDING_BID_BOOK_SOURCE,
	TRADING_BIDDING_BID_SCOPE_KIND,
	TRADING_BIDDING_JOB_RUNTIME_BID_POSITION,
	TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
	TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
	TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
	TRADING_BIDDING_TIER_SELECTION_MODE,
	TRADING_JOB_STATUS,
	TRADING_JOB_TARGET_KIND
} from '@artgod/shared/types';
import type {
	ApiBiddingBidBook,
	ApiBiddingBidBookRow,
	ApiBiddingCollectionSettings,
	ApiBiddingJob,
	ApiBiddingPriceTier,
	ApiBiddingTokenOfferCard,
	ApiBiddingTokenOfferCardsPage,
	ApiChain,
	ApiCollection,
	ApiCollectionBiddingBidScopeFilter,
	ApiCollectionBiddingTraitFilterJoinMode,
	ApiCollectionMediaState,
	ApiTokenAttribute,
	ApiTokenCard,
	ApiTokenDetail,
	ApiTraitFacet,
	ApiTraitFilterPresentationFeatureState,
	ApiTraitRangeFilter,
	ApiTokensPage
} from '$lib/api-types';
import {
	parseBidBookMakerFilter,
	parseCollectionBiddingBidScopeFilter,
	parseCollectionBiddingTraitFilterJoinMode,
	parseShowMutedBidBook
} from '$lib/bidding-query';
import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
import { defaultTraitFilterPresentationState } from '$lib/trait-filter-presentation';
import { normalizeMediaMode } from '$lib/media-mode';
import { parseCollectionTokenStatus, parseDisplayMode } from '$lib/token-browser-query';
import { parseSelectedTraitRanges, parseSelectedTraits } from '$lib/trait-filters';

const COLLECTION_BASE_PATH = '/e2e-harness/collection';
const WETH_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ETH_ADDRESS = '0x0000000000000000000000000000000000000000';
const OWN_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MARKET_ADDRESS_A = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MARKET_ADDRESS_B = '0xcccccccccccccccccccccccccccccccccccccccc';
const MARKET_ADDRESS_C = '0xdddddddddddddddddddddddddddddddddddddddd';
const FIXTURE_NOW = '2026-05-01T12:00:00Z';

// Stable test-only route root used by deterministic Playwright harness pages.
export const BIDDING_AUTOMATION_E2E_COLLECTION_BASE_PATH = COLLECTION_BASE_PATH;

// Opt-in harness query key for deterministic bidding lifecycle scenarios.
export const BIDDING_E2E_SCENARIO_QUERY_PARAM = 'e2e_bidding_scenario';

// Test-owned lifecycle scenarios that keep the default harness fixture stable.
export const BIDDING_E2E_SCENARIO = {
	CancellationPhases: 'cancellation_phases'
} as const;

type BiddingE2eScenario = (typeof BIDDING_E2E_SCENARIO)[keyof typeof BIDDING_E2E_SCENARIO];

// Shared deterministic chain fixture for all bidding automation harness pages.
export const BIDDING_E2E_CHAIN: ApiChain = {
	id: 1,
	type: 'evm',
	publicChainId: 1,
	slug: 'ethereum',
	name: 'Ethereum'
};

// Shared deterministic collection fixture for all bidding automation harness pages.
export const BIDDING_E2E_COLLECTION: ApiCollection = {
	chainId: 1,
	collectionId: 1,
	slug: 'e2e-bidding',
	address: '0x1111111111111111111111111111111111111111',
	standard: 'erc721',
	status: 'live',
	deploymentBlock: 1,
	bootstrapAnchorBlock: null,
	createdAt: FIXTURE_NOW,
	updatedAt: FIXTURE_NOW,
	extensions: [{ key: TERRAFORMS_EXTENSION_KEY }]
};

// Shared deterministic media fixture for token-card and token-detail rendering.
export const BIDDING_E2E_MEDIA: ApiCollectionMediaState = {
	selectedMode: 'artifact',
	defaultMode: 'artifact',
	availableModes: [{ key: 'artifact', label: 'artifact' }]
};

// Shared deterministic collection settings fixture used by bidding forms and tiers.
export const BIDDING_E2E_SETTINGS: ApiBiddingCollectionSettings = {
	...defaultBiddingCollectionSettings(),
	tierSelectionMode: TRADING_BIDDING_TIER_SELECTION_MODE.Buttons,
	defaultDeltaEth: '0.004',
	updatedAt: FIXTURE_NOW
};

// Shared deterministic trait facets for exercising token and offer filters.
export const BIDDING_E2E_FACETS: ApiTraitFacet[] = [
	{
		key: 'Zone',
		displayKind: 'set',
		minValue: null,
		maxValue: null,
		values: [
			biddingE2eFacetValue('Shahra', 2),
			biddingE2eFacetValue('Tetsu', 1),
			biddingE2eFacetValue('Xleph', 1)
		]
	},
	{
		key: 'Biome',
		displayKind: 'set',
		minValue: null,
		maxValue: null,
		values: [
			biddingE2eFacetValue('42', 2),
			biddingE2eFacetValue('7', 1),
			biddingE2eFacetValue('9', 1)
		]
	},
	{
		key: 'Mode',
		displayKind: 'set',
		minValue: null,
		maxValue: null,
		values: [
			biddingE2eFacetValue('Terrain', 3),
			biddingE2eFacetValue('Daydream', 1)
		]
	},
	{
		key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
		displayKind: 'set',
		minValue: null,
		maxValue: null,
		values: [biddingE2eFacetValue(TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed, 1, false)]
	}
];

const TOKEN_CARDS: ApiTokenCard[] = [
	tokenCard('101', 'Zone=Shahra / Biome=42 / Mode=Terrain', '0.90', ETH_ADDRESS, [
		{ key: 'Zone', value: 'Shahra' },
		{ key: 'Biome', value: '42' },
		{ key: 'Mode', value: 'Terrain' }
	]),
	tokenCard('102', 'Zone=Shahra / Biome=7 / Mode=Terrain', '0.85', ETH_ADDRESS, [
		{ key: 'Zone', value: 'Shahra' },
		{ key: 'Biome', value: '7' },
		{ key: 'Mode', value: 'Terrain' }
	]),
	tokenCard('103', 'Zone=Tetsu / Biome=42 / Mode=Daydream', null, null, [
		{ key: 'Zone', value: 'Tetsu' },
		{ key: 'Biome', value: '42' },
		{ key: 'Mode', value: 'Daydream' }
	]),
	tokenCard('104', 'Zone=Xleph / Biome=9 / Mode=Terrain', '0.72', ETH_ADDRESS, [
		{ key: 'Zone', value: 'Xleph' },
		{ key: 'Biome', value: '9' },
		{ key: 'Mode', value: 'Terrain' }
	])
];

const BASE_BID_ROWS: ApiBiddingBidBookRow[] = [
	bidRow({
		orderId: '0xcollection-top',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
		priceEth: '0.300',
		maker: MARKET_ADDRESS_A,
		validUntil: 1_900_000_000
	}),
	bidRow({
		orderId: '0xcollection-own-intent',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
		priceEth: '0.350',
		ceilingEth: '0.500',
		maker: OWN_ADDRESS,
		isOwn: true,
		jobId: 'job-collection',
		phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
		status: TRADING_JOB_STATUS.Paused
	}),
	bidRow({
		orderId: '0xtrait-shahra-terrain',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
		priceEth: '0.420',
		maker: MARKET_ADDRESS_A,
		traits: [
			{ type: 'Mode', value: 'Terrain' },
			{ type: 'Zone', value: 'Shahra' }
		],
		validUntil: 1_900_000_000
	}),
	bidRow({
		orderId: '0xtrait-zone-shahra',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
		priceEth: '0.310',
		maker: MARKET_ADDRESS_B,
		traits: [{ type: 'Zone', value: 'Shahra' }],
		validUntil: 1_900_000_000
	}),
	bidRow({
		orderId: '0xtrait-zone-biome-shahra-42',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
		priceEth: '0.360',
		maker: MARKET_ADDRESS_B,
		traits: [
			{ type: TERRAFORMS_ZONE_ATTRIBUTE_KEY, value: 'Shahra' },
			{ type: TERRAFORMS_BIOME_ATTRIBUTE_KEY, value: '42' }
		],
		validUntil: 1_900_000_000
	}),
	bidRow({
		orderId: '0xtrait-zone-tetsu',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
		priceEth: '0.280',
		maker: MARKET_ADDRESS_C,
		traits: [{ type: 'Zone', value: 'Tetsu' }],
		validUntil: 1_900_000_000
	}),
	bidRow({
		orderId: '0xtrait-own-biome-42',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
		priceEth: '0.350',
		ceilingEth: '0.400',
		maker: OWN_ADDRESS,
		isOwn: true,
		jobId: 'job-trait-biome-42',
		phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
		status: TRADING_JOB_STATUS.Enabled,
		traits: [{ type: 'Biome', value: '42' }],
		ownStatus: {
			position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
			constraints: [],
			job: {
				jobId: 'job-trait-biome-42',
				revision: 3,
				status: TRADING_JOB_STATUS.Enabled
			}
		}
	}),
	bidRow({
		orderId: '0xtoken-101-top',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
		tokenId: '101',
		priceEth: '0.800',
		maker: MARKET_ADDRESS_A,
		validUntil: 1_900_000_000
	}),
	bidRow({
		orderId: '0xtoken-101-own',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
		tokenId: '101',
		priceEth: '0.710',
		maker: OWN_ADDRESS,
		isOwn: true,
		jobId: 'job-token-101',
		phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
		status: TRADING_JOB_STATUS.Enabled,
		ownStatus: {
			position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
			constraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling],
			job: {
				jobId: 'job-token-101',
				revision: 2,
				status: TRADING_JOB_STATUS.Enabled
			}
		}
	}),
	bidRow({
		orderId: '0xtoken-102-market',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
		tokenId: '102',
		priceEth: '0.260',
		maker: MARKET_ADDRESS_B,
		validUntil: 1_900_000_000
	}),
	bidRow({
		orderId: '0xtoken-102-own-low',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
		tokenId: '102',
		priceEth: '0.020',
		maker: OWN_ADDRESS,
		isOwn: true,
		jobId: 'job-token-102-low',
		phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
		status: TRADING_JOB_STATUS.Enabled,
		ownStatus: {
			position: TRADING_BIDDING_JOB_RUNTIME_BID_POSITION.Losing,
			constraints: [TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Floor],
			job: {
				jobId: 'job-token-102-low',
				revision: 1,
				status: TRADING_JOB_STATUS.Enabled
			}
		}
	}),
	bidRow({
		orderId: '0xtoken-103-market',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
		tokenId: '103',
		priceEth: '0.240',
		maker: MARKET_ADDRESS_C,
		validUntil: 1_900_000_000
	})
];

const CANCELLATION_PHASE_BID_ROWS: ApiBiddingBidBookRow[] = [
	bidRow({
		orderId: '0xtoken-103-canceling',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
		tokenId: '103',
		priceEth: '0.245',
		maker: OWN_ADDRESS,
		isOwn: true,
		jobId: 'job-token-103-canceling',
		phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling,
		status: TRADING_JOB_STATUS.Archived,
		validUntil: 1_900_000_000,
		placedAt: FIXTURE_NOW
	}),
	bidRow({
		orderId: '0xtoken-104-cancel-failed',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
		tokenId: '104',
		priceEth: '0.255',
		maker: OWN_ADDRESS,
		isOwn: true,
		jobId: 'job-token-104-cancel-failed',
		phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed,
		status: TRADING_JOB_STATUS.Archived,
		validUntil: 1_900_000_000,
		placedAt: FIXTURE_NOW
	}),
	bidRow({
		orderId: '0xtrait-biome-7-canceling',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
		priceEth: '0.275',
		maker: OWN_ADDRESS,
		isOwn: true,
		jobId: 'job-trait-biome-7-canceling',
		phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling,
		status: TRADING_JOB_STATUS.Archived,
		traits: [{ type: TERRAFORMS_BIOME_ATTRIBUTE_KEY, value: '7' }],
		validUntil: 1_900_000_000,
		placedAt: FIXTURE_NOW
	}),
	bidRow({
		orderId: '0xtrait-zone-xleph-cancel-failed',
		scopeKind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
		priceEth: '0.265',
		maker: OWN_ADDRESS,
		isOwn: true,
		jobId: 'job-trait-zone-xleph-cancel-failed',
		phase: TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed,
		status: TRADING_JOB_STATUS.Archived,
		traits: [{ type: TERRAFORMS_ZONE_ATTRIBUTE_KEY, value: 'Xleph' }],
		validUntil: 1_900_000_000,
		placedAt: FIXTURE_NOW
	})
];

// Shared deterministic price tiers used by harness pages and mocked API responses.
export const BIDDING_E2E_PRICE_TIERS: ApiBiddingPriceTier[] = [
	priceTier({
		tierId: 'tier-base',
		name: 'Base',
		sortOrder: 1,
		floorEth: '0.300',
		ceilingEth: '0.400',
		deltaEth: '0.004'
	}),
	priceTier({
		tierId: 'tier-zone',
		name: 'Zone Boost',
		sortOrder: 2,
		parentTierId: 'tier-base',
		floorEth: '0.340',
		ceilingEth: '0.450',
		deltaEth: '0.006'
	})
];

const JOBS: ApiBiddingJob[] = [
	biddingJob({
		jobId: 'job-token-101',
		status: TRADING_JOB_STATUS.Enabled,
		target: {
			type: TRADING_JOB_TARGET_KIND.Token,
			tokenId: '101'
		},
		floorEth: '0.700',
		ceilingEth: '0.720',
		deltaEth: '0.010',
		revision: 2
	}),
	biddingJob({
		jobId: 'job-token-102-low',
		status: TRADING_JOB_STATUS.Enabled,
		target: {
			type: TRADING_JOB_TARGET_KIND.Token,
			tokenId: '102'
		},
		floorEth: '0.020',
		ceilingEth: '0.030',
		deltaEth: '0.004',
		revision: 1
	}),
	biddingJob({
		jobId: 'job-token-103-canceling',
		status: TRADING_JOB_STATUS.Archived,
		target: {
			type: TRADING_JOB_TARGET_KIND.Token,
			tokenId: '103'
		},
		floorEth: '0.240',
		ceilingEth: '0.250',
		deltaEth: '0.004',
		revision: 6,
		archivedAt: FIXTURE_NOW
	}),
	biddingJob({
		jobId: 'job-token-104-cancel-failed',
		status: TRADING_JOB_STATUS.Archived,
		target: {
			type: TRADING_JOB_TARGET_KIND.Token,
			tokenId: '104'
		},
		floorEth: '0.250',
		ceilingEth: '0.260',
		deltaEth: '0.004',
		revision: 7,
		archivedAt: FIXTURE_NOW
	}),
	biddingJob({
		jobId: 'job-trait-biome-42',
		status: TRADING_JOB_STATUS.Enabled,
		target: {
			type: TRADING_JOB_TARGET_KIND.Collection,
			quantity: 1,
			targetTraits: [{ type: 'Biome', value: '42' }]
		},
		floorEth: '0.350',
		ceilingEth: '0.400',
		deltaEth: '0.004',
		revision: 3
	}),
	biddingJob({
		jobId: 'job-trait-biome-7-canceling',
		status: TRADING_JOB_STATUS.Archived,
		target: {
			type: TRADING_JOB_TARGET_KIND.Collection,
			quantity: 1,
			targetTraits: [{ type: TERRAFORMS_BIOME_ATTRIBUTE_KEY, value: '7' }]
		},
		floorEth: '0.270',
		ceilingEth: '0.280',
		deltaEth: '0.004',
		revision: 8,
		archivedAt: FIXTURE_NOW
	}),
	biddingJob({
		jobId: 'job-trait-zone-xleph-cancel-failed',
		status: TRADING_JOB_STATUS.Archived,
		target: {
			type: TRADING_JOB_TARGET_KIND.Collection,
			quantity: 1,
			targetTraits: [{ type: TERRAFORMS_ZONE_ATTRIBUTE_KEY, value: 'Xleph' }]
		},
		floorEth: '0.260',
		ceilingEth: '0.270',
		deltaEth: '0.004',
		revision: 9,
		archivedAt: FIXTURE_NOW
	}),
	biddingJob({
		jobId: 'job-collection',
		status: TRADING_JOB_STATUS.Paused,
		target: {
			type: TRADING_JOB_TARGET_KIND.Collection,
			quantity: 1,
			targetTraits: []
		},
		floorEth: '0.350',
		ceilingEth: '0.500',
		deltaEth: '0.004',
		revision: 4
	})
];

// Archived job fixture keeps panel/status tests able to opt into archived-state coverage.
export const BIDDING_E2E_ARCHIVED_JOB: ApiBiddingJob = biddingJob({
	jobId: 'job-token-104-archived',
	status: TRADING_JOB_STATUS.Archived,
	target: {
		type: TRADING_JOB_TARGET_KIND.Token,
		tokenId: '104'
	},
	floorEth: '0.100',
	ceilingEth: '0.120',
	deltaEth: '0.004',
	revision: 5,
	archivedAt: FIXTURE_NOW
});

// Builds fixture data for the collection token browser harness route.
export function buildBiddingE2eCollectionDetailData(searchParams: URLSearchParams) {
	const selectedTraits = parseSelectedTraits(searchParams);
	const selectedTraitRanges = parseSelectedTraitRanges(searchParams);
	const tokenStatus = parseCollectionTokenStatus(searchParams.get('token_status'));
	const displayMode = parseDisplayMode(searchParams.get('mode'));
	const tokens = buildTokensPage({
		selectedTraits,
		selectedTraitRanges,
		tokenStatus,
		cursor: searchParams.get('cursor')
	});

	return {
		chain: BIDDING_E2E_CHAIN,
		collection: BIDDING_E2E_COLLECTION,
		tokens,
		facets: BIDDING_E2E_FACETS,
		selectedTraits,
		selectedTraitRanges,
		media: BIDDING_E2E_MEDIA,
		basePath: COLLECTION_BASE_PATH,
		requestCursor: searchParams.get('cursor'),
		tokenStatus,
		displayMode,
		biddingSettings: BIDDING_E2E_SETTINGS,
		priceTiers: BIDDING_E2E_PRICE_TIERS
	};
}

// Builds fixture data for the collection bidding/offers harness route.
export function buildBiddingE2eCollectionBiddingData(searchParams: URLSearchParams) {
	const selectedTraits = parseSelectedTraits(searchParams);
	const selectedTraitRanges = parseSelectedTraitRanges(searchParams);
	const bidScope = parseCollectionBiddingBidScopeFilter(searchParams);
	const traitJoinMode = parseCollectionBiddingTraitFilterJoinMode(searchParams);
	const makerFilter = parseBidBookMakerFilter(searchParams);
	const scenario = parseBiddingE2eScenario(searchParams);
	const bidBook = buildBidBook({
		bidScope,
		traitJoinMode,
		selectedTraits,
		makerFilter,
		scenario
	});
	const tokenOfferCards = buildTokenOfferCardsPage({
		selectedTraits,
		selectedTraitRanges,
		traitJoinMode,
		makerFilter,
		cursor: searchParams.get('cursor'),
		scenario
	});

	return {
		chain: BIDDING_E2E_CHAIN,
		collection: BIDDING_E2E_COLLECTION,
		biddingSettings: BIDDING_E2E_SETTINGS,
		priceTiers: BIDDING_E2E_PRICE_TIERS,
		bidBook,
		tokenOfferCards,
		facets: BIDDING_E2E_FACETS,
		media: BIDDING_E2E_MEDIA,
		basePath: COLLECTION_BASE_PATH,
		selectedTraits,
		selectedTraitRanges,
		bidScope,
		traitJoinMode,
		showMuted: parseShowMutedBidBook(searchParams),
		makerFilter,
		mediaMode: normalizeMediaMode(searchParams.get('media_mode')),
		requestCursor: searchParams.get('cursor')
	};
}

// Builds fixture data for the token-detail bidding harness route.
export function buildBiddingE2eTokenDetailData(tokenRef: string, searchParams: URLSearchParams) {
	const token = tokenDetail(tokenRef);
	const scenario = parseBiddingE2eScenario(searchParams);
	return {
		chain: BIDDING_E2E_CHAIN,
		collection: BIDDING_E2E_COLLECTION,
		media: BIDDING_E2E_MEDIA,
		token,
		biddingSettings: BIDDING_E2E_SETTINGS,
		priceTiers: BIDDING_E2E_PRICE_TIERS,
		traitFilterPresentation: traitFilterPresentation(),
		tokenBiddingJob:
			JOBS.find(
				(job) =>
					job.target.type === TRADING_JOB_TARGET_KIND.Token && job.target.tokenId === tokenRef
			) ?? null,
		tokenBiddingBidBook: buildTokenDetailBidBook(tokenRef, scenario),
		showMuted: parseShowMutedBidBook(searchParams),
		backPath: COLLECTION_BASE_PATH,
		backQuery: null
	};
}

// Resolves fixture lookup responses for existing bidding automation jobs.
export function findBiddingE2eJobForTarget(body: unknown): ApiBiddingJob | null {
	if (!isLookupBody(body)) {
		return null;
	}
	const { target } = body;
	if (target.type === TRADING_JOB_TARGET_KIND.Token) {
		return (
			JOBS.find(
				(job) => job.target.type === TRADING_JOB_TARGET_KIND.Token && job.target.tokenId === target.tokenId
			) ?? null
		);
	}
	if (target.type === TRADING_BIDDING_BID_SCOPE_KIND.Trait) {
		return (
			JOBS.find(
				(job) =>
					job.target.type === TRADING_JOB_TARGET_KIND.Collection &&
					traitsSignature(job.target.targetTraits) === traitsSignature(target.targetTraits)
			) ?? null
		);
	}
	if (target.type === TRADING_JOB_TARGET_KIND.Collection) {
		return (
			JOBS.find(
				(job) =>
					job.target.type === TRADING_JOB_TARGET_KIND.Collection &&
					job.target.targetTraits.length === 0
			) ?? null
		);
	}
	return null;
}

// Builds a deterministic API mutation response for captured Playwright requests.
export function buildBiddingE2eMutationJob(body: unknown, fallbackJobId: string): ApiBiddingJob {
	if (isJobMutationBody(body)) {
		return biddingJob({
			jobId: fallbackJobId,
			status: body.status,
			target: {
				type: TRADING_JOB_TARGET_KIND.Token,
				tokenId: '999'
			},
			floorEth: body.floorEth ?? '0.100',
			ceilingEth: body.ceilingEth ?? '0.200',
			deltaEth: body.deltaEth,
			revision: 1
		});
	}
	return biddingJob({
		jobId: fallbackJobId,
		status: TRADING_JOB_STATUS.Enabled,
		target: {
			type: TRADING_JOB_TARGET_KIND.Token,
			tokenId: '999'
		},
		floorEth: '0.100',
		ceilingEth: '0.200',
		deltaEth: BIDDING_E2E_SETTINGS.defaultDeltaEth,
		revision: 1
	});
}

function parseBiddingE2eScenario(searchParams: URLSearchParams): BiddingE2eScenario | null {
	const value = searchParams.get(BIDDING_E2E_SCENARIO_QUERY_PARAM);
	return value === BIDDING_E2E_SCENARIO.CancellationPhases ? value : null;
}

function bidRowsForScenario(scenario: BiddingE2eScenario | null): ApiBiddingBidBookRow[] {
	return scenario === BIDDING_E2E_SCENARIO.CancellationPhases
		? [...BASE_BID_ROWS, ...CANCELLATION_PHASE_BID_ROWS]
		: BASE_BID_ROWS;
}

function buildTokensPage(params: {
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	tokenStatus: 'listed' | 'all' | 'listed_then_unlisted';
	cursor: string | null;
}): ApiTokensPage {
	const filtered = TOKEN_CARDS.filter((token) => {
		if (params.tokenStatus === 'listed' && !token.listingPrice) {
			return false;
		}
		return tokenMatchesAllTraits(token.attributes, params.selectedTraits);
	});
	const page = paginate(filtered, params.cursor, 2);
	return {
		items: page.items,
		prevCursor: page.prevCursor,
		nextCursor: page.nextCursor,
		limit: page.limit,
		totalItems: filtered.length,
		rangeStart: page.rangeStart,
		rangeEnd: page.rangeEnd,
		currentPage: page.currentPage,
		totalPages: page.totalPages
	};
}

function buildTokenOfferCardsPage(params: {
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
	makerFilter: string | null;
	cursor: string | null;
	scenario: BiddingE2eScenario | null;
}): ApiBiddingTokenOfferCardsPage {
	const bidRows = bidRowsForScenario(params.scenario);
	const cards = TOKEN_CARDS.map((token) => {
		const offers = bidRows.filter(
			(row) =>
				row.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Token &&
				row.scope.tokenId === token.tokenId &&
				(!params.makerFilter ||
					row.maker.address.toLowerCase() === params.makerFilter.toLowerCase())
		);
		return offers.length > 0 ? { ...token, offers } : null;
	}).filter((card): card is ApiBiddingTokenOfferCard => !!card);
	const filtered = cards.filter((card) =>
		tokenMatchesTraits(card.attributes, params.selectedTraits, params.traitJoinMode)
	);
	const page = paginate(filtered, params.cursor, 2);
	return {
		items: page.items,
		prevCursor: page.prevCursor,
		nextCursor: page.nextCursor,
		limit: page.limit,
		totalItems: filtered.length,
		totalOffers: filtered.reduce((sum, card) => sum + card.offers.length, 0),
		rangeStart: page.rangeStart,
		rangeEnd: page.rangeEnd,
		currentPage: page.currentPage,
		totalPages: page.totalPages
	};
}

function buildBidBook(params: {
	bidScope: ApiCollectionBiddingBidScopeFilter;
	traitJoinMode: ApiCollectionBiddingTraitFilterJoinMode;
	selectedTraits: ApiTokenAttribute[];
	makerFilter: string | null;
	scenario: BiddingE2eScenario | null;
}): ApiBiddingBidBook {
	const bids = bidRowsForScenario(params.scenario).filter((row) => {
		if (params.bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
			if (row.scope.kind !== TRADING_BIDDING_BID_SCOPE_KIND.Token) {
				return false;
			}
		}
		if (params.bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits) {
			if (row.scope.kind !== TRADING_BIDDING_BID_SCOPE_KIND.Trait) {
				return false;
			}
			if (
				params.selectedTraits.length > 0 &&
				!bidTraitsMatchFilter(row.scope.traits, params.selectedTraits, params.traitJoinMode)
			) {
				return false;
			}
		}
		if (params.bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection) {
			if (row.scope.kind !== TRADING_BIDDING_BID_SCOPE_KIND.Collection) {
				return false;
			}
		}
		return (
			!params.makerFilter || row.maker.address.toLowerCase() === params.makerFilter.toLowerCase()
		);
	});

	return {
		state: {
			source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
			updatedAt: FIXTURE_NOW,
			snapshotRefreshedAtMs: null,
			projectedAt: null,
			rowCount: bids.length,
			durationMs: null,
			lastError: null
		},
		ownMakerAddress: OWN_ADDRESS,
		bids
	};
}

function buildTokenDetailBidBook(
	tokenId: string,
	scenario: BiddingE2eScenario | null
): ApiBiddingBidBook {
	const token = tokenCardById(tokenId);
	const bids = bidRowsForScenario(scenario).filter((row) => {
		if (row.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Collection) {
			return true;
		}
		if (row.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Token) {
			return row.scope.tokenId === tokenId;
		}
		if (row.scope.kind === TRADING_BIDDING_BID_SCOPE_KIND.Trait) {
			return row.scope.traits.every((trait) =>
				token.attributes.some(
					(attribute) => attribute.key === trait.type && attribute.value === trait.value
				)
			);
		}
		return false;
	});
	return {
		state: {
			source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
			updatedAt: FIXTURE_NOW,
			snapshotRefreshedAtMs: null,
			projectedAt: null,
			rowCount: bids.length,
			durationMs: null,
			lastError: null
		},
		ownMakerAddress: OWN_ADDRESS,
		bids
	};
}

function traitFilterPresentation(): ApiTraitFilterPresentationFeatureState {
	return {
		...defaultTraitFilterPresentationState(),
		availableTraitKeys: BIDDING_E2E_FACETS.map((facet) => facet.key)
	};
}

function tokenCard(
	tokenId: string,
	traitSummary: string,
	listingPriceEth: string | null,
	listingCurrency: string | null,
	attributes: ApiTokenAttribute[]
): ApiTokenCard {
	return {
		tokenId,
		name: `E2E Token #${tokenId}`,
		image: null,
		traitSummary,
		listingPrice: listingPriceEth ? ethToWei(listingPriceEth) : null,
		listingCurrency,
		attributes,
		hasMetadata: true,
		metadataUpdatedAt: FIXTURE_NOW
	};
}

function tokenCardById(tokenId: string): ApiTokenCard {
	return TOKEN_CARDS.find((token) => token.tokenId === tokenId) ?? TOKEN_CARDS[0];
}

function tokenDetail(tokenId: string): ApiTokenDetail {
	const token = tokenCardById(tokenId);
	return {
		tokenId: token.tokenId,
		name: token.name,
		image: token.image,
		animationUrl: null,
		listingPrice: token.listingPrice,
		listingCurrency: token.listingCurrency,
		currentHolder: MARKET_ADDRESS_A,
		attributes: token.attributes.map((attribute) => ({
			key: attribute.key,
			value: attribute.value,
			tokenCount:
				BIDDING_E2E_FACETS.find((facet) => facet.key === attribute.key)?.values.find(
					(item) => item.value === attribute.value
				)?.tokenCount ?? null,
			rarityPercent: 25,
			marketplaceBiddingSupported:
				BIDDING_E2E_FACETS.find((facet) => facet.key === attribute.key)?.values.find(
					(item) => item.value === attribute.value
				)?.marketplaceBiddingSupported ?? true
		})),
		hasMetadata: token.hasMetadata,
		metadataUpdatedAt: token.metadataUpdatedAt
	};
}

function biddingE2eFacetValue(
	value: string,
	tokenCount: number,
	marketplaceBiddingSupported = true
): ApiTraitFacet['values'][number] {
	return {
		value,
		tokenCount,
		marketplaceBiddingSupported
	};
}

function bidRow(params: {
	orderId: string;
	scopeKind: ApiBiddingBidBookRow['scope']['kind'];
	priceEth: string;
	ceilingEth?: string;
	maker: string;
	isOwn?: boolean;
	tokenId?: string;
	traits?: { type: string; value: string }[];
	jobId?: string;
	phase?: ApiBiddingBidBookRow['materialization']['phase'];
	status?: ApiBiddingJob['status'];
	validUntil?: number | null;
	placedAt?: string | null;
	ownStatus?: ApiBiddingBidBookRow['ownStatus'];
}): ApiBiddingBidBookRow {
	const traits = params.traits ?? [];
	const hasRange = !!params.ceilingEth;
	return {
		orderId: params.orderId,
		source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
		materialization: params.jobId
			? {
					kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
					jobId: params.jobId,
					status: params.status ?? TRADING_JOB_STATUS.Enabled,
					phase: params.phase ?? TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued
				}
			: {
					kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid,
					jobId: null,
					status: null,
					phase: null
				},
		scope: {
			kind: params.scopeKind,
			label: scopeLabel(params.scopeKind, params.tokenId ?? null, traits),
			tokenId: params.tokenId ?? null,
			traits
		},
		maker: {
			address: params.maker,
			label: params.isOwn ? 'You' : params.maker,
			isOwn: params.isOwn ?? false
		},
		price: hasRange
			? {
					kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Range,
					floorWei: ethToWei(params.priceEth),
					floorEth: params.priceEth,
					ceilingWei: ethToWei(params.ceilingEth ?? params.priceEth),
					ceilingEth: params.ceilingEth ?? params.priceEth
				}
			: {
					kind: TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact,
					wei: ethToWei(params.priceEth),
					eth: params.priceEth
				},
		bidLimits: hasRange
			? {
					floorWei: ethToWei(params.priceEth),
					floorEth: params.priceEth,
					ceilingWei: ethToWei(params.ceilingEth ?? params.priceEth),
					ceilingEth: params.ceilingEth ?? params.priceEth
				}
			: null,
		quantity: '1',
		currencyAddress: WETH_ADDRESS,
		currencySymbol: 'WETH',
		protocolAddress: null,
		validUntil: params.validUntil ?? null,
		placedAt: params.placedAt ?? (params.jobId ? null : FIXTURE_NOW),
		snapshotRefreshedAtMs: null,
		seenAt: FIXTURE_NOW,
		ownStatus: params.ownStatus ?? null
	};
}

function scopeLabel(
	kind: ApiBiddingBidBookRow['scope']['kind'],
	tokenId: string | null,
	traits: { type: string; value: string }[]
): string {
	if (kind === TRADING_BIDDING_BID_SCOPE_KIND.Collection) {
		return 'collection';
	}
	if (kind === TRADING_BIDDING_BID_SCOPE_KIND.Token) {
		return tokenId ? `#${tokenId}` : 'token';
	}
	if (kind === TRADING_BIDDING_BID_SCOPE_KIND.Trait) {
		return traits.map((trait) => `${trait.type}=${trait.value}`).join(' + ');
	}
	return kind;
}

function biddingJob(params: {
	jobId: string;
	status: ApiBiddingJob['status'];
	target: ApiBiddingJob['target'];
	floorEth: string;
	ceilingEth: string;
	deltaEth: string;
	revision: number;
	archivedAt?: string | null;
}): ApiBiddingJob {
	return {
		jobId: params.jobId,
		status: params.status,
		revision: params.revision,
		createdAt: FIXTURE_NOW,
		updatedAt: FIXTURE_NOW,
		archivedAt: params.archivedAt ?? null,
		target: params.target,
		config: {
			floorEth: params.floorEth,
			ceilingEth: params.ceilingEth,
			deltaEth: params.deltaEth,
			pricingSource: null
		},
		runtime: null
	};
}

function priceTier(params: {
	tierId: string;
	name: string;
	sortOrder: number;
	parentTierId?: string | null;
	floorEth: string;
	ceilingEth: string;
	deltaEth: string;
}): ApiBiddingPriceTier {
	return {
		tierId: params.tierId,
		name: params.name,
		status: TRADING_JOB_STATUS.Enabled,
		sortOrder: params.sortOrder,
		parentTierId: params.parentTierId ?? null,
		floorConfig: {
			kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
			valueEth: params.floorEth
		},
		ceilingConfig: {
			kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
			valueEth: params.ceilingEth
		},
		deltaEth: params.deltaEth,
		resolvedFloorEth: params.floorEth,
		resolvedCeilingEth: params.ceilingEth,
		resolvedAt: FIXTURE_NOW,
		lastError: null,
		revision: 1,
		createdAt: FIXTURE_NOW,
		updatedAt: FIXTURE_NOW,
		archivedAt: null
	};
}

function tokenMatchesAllTraits(
	attributes: ApiTokenAttribute[],
	selectedTraits: ApiTokenAttribute[]
): boolean {
	return selectedTraits.every((trait) =>
		attributes.some((attribute) => attribute.key === trait.key && attribute.value === trait.value)
	);
}

function tokenMatchesTraits(
	attributes: ApiTokenAttribute[],
	selectedTraits: ApiTokenAttribute[],
	joinMode: ApiCollectionBiddingTraitFilterJoinMode
): boolean {
	if (selectedTraits.length === 0) {
		return true;
	}
	const matches = (trait: ApiTokenAttribute) =>
		attributes.some((attribute) => attribute.key === trait.key && attribute.value === trait.value);
	return joinMode === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
		? selectedTraits.every(matches)
		: selectedTraits.some(matches);
}

function bidTraitsMatchFilter(
	bidTraits: { type: string; value: string }[],
	selectedTraits: ApiTokenAttribute[],
	joinMode: ApiCollectionBiddingTraitFilterJoinMode
): boolean {
	const matches = (trait: ApiTokenAttribute) =>
		bidTraits.some((bidTrait) => bidTrait.type === trait.key && bidTrait.value === trait.value);
	return joinMode === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
		? selectedTraits.every(matches)
		: selectedTraits.some(matches);
}

function traitsSignature(traits: { type: string; value: string }[]): string {
	return traits
		.map((trait) => `${trait.type}=${trait.value}`)
		.sort((left, right) => left.localeCompare(right))
		.join('\u0000');
}

function paginate<T>(
	items: T[],
	cursor: string | null,
	limit: number
): {
	items: T[];
	prevCursor: string | null;
	nextCursor: string | null;
	limit: number;
	rangeStart: number;
	rangeEnd: number;
	currentPage: number;
	totalPages: number;
} {
	const pageIndex = cursor === 'page-2' ? 1 : 0;
	const start = pageIndex * limit;
	const pageItems = items.slice(start, start + limit);
	const totalPages = Math.max(Math.ceil(items.length / limit), 1);
	return {
		items: pageItems,
		prevCursor: pageIndex > 0 ? 'page-1' : null,
		nextCursor: start + limit < items.length ? 'page-2' : null,
		limit,
		rangeStart: pageItems.length === 0 ? 0 : start + 1,
		rangeEnd: start + pageItems.length,
		currentPage: pageIndex + 1,
		totalPages
	};
}

function ethToWei(eth: string): string {
	const [wholeRaw, fractionRaw = ''] = eth.split('.');
	const whole = BigInt(wholeRaw || '0') * 1_000_000_000_000_000_000n;
	const fraction = BigInt(fractionRaw.padEnd(18, '0').slice(0, 18) || '0');
	return String(whole + fraction);
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
	if (!value || typeof value !== 'object') {
		return false;
	}
	const target = (value as { target?: unknown }).target;
	return !!target && typeof target === 'object' && typeof (target as { type?: unknown }).type === 'string';
}

function isJobMutationBody(value: unknown): value is {
	status: ApiBiddingJob['status'];
	floorEth?: string;
	ceilingEth?: string;
	deltaEth: string;
} {
	if (!value || typeof value !== 'object') {
		return false;
	}
	return typeof (value as { deltaEth?: unknown }).deltaEth === 'string';
}
