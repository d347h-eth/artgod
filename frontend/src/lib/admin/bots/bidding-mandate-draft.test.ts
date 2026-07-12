import { describe, expect, it } from 'vitest';
import type { AdminBiddingCollectionCandidate } from './ports';
import {
	buildBiddingMandateDraft,
	formatBiddingChainIdentity,
	formatBiddingMandateTokenScope,
	formatBiddingMandateWeiAsEth,
	sortBiddingCollectionCandidatesByMaxUnitBid,
	syncBiddingMandateSelections,
	type BiddingMandateSelections
} from './bidding-mandate-draft';

const CANDIDATE: AdminBiddingCollectionCandidate = {
	chainId: 1,
	collectionId: 7,
	artgodSlug: 'shared-contract-art',
	contractAddress: '0x1111111111111111111111111111111111111111',
	openseaSlug: 'shared-contract-opensea',
	tokenScope: { label: 'range', items: [{ label: 'tokens', value: '100-199' }] },
	activeJobMaxCeilingEth: '1.25'
};

describe('bidding mandate draft', () => {
	it('formats the named chain before its qualified external id', () => {
		expect(formatBiddingChainIdentity({ chainId: 1, name: 'Ethereum' })).toBe(
			'Ethereum · chain ID #1'
		);
		expect(formatBiddingChainIdentity({ chainId: 1, name: 'Ethereum' }, 10)).toBe('chain ID #10');
	});

	it('sends only collection ids and operator price caps to Rust', () => {
		const selections: BiddingMandateSelections = {
			[CANDIDATE.collectionId]: {
				selected: true,
				maxUnitBidEth: '1.25',
				maxUnitBidEthEdited: false
			}
		};

		expect(buildBiddingMandateDraft([CANDIDATE], selections)).toEqual({
			collections: [{ collectionId: 7, maxUnitBidEth: '1.25' }]
		});
	});

	it('preserves price caps only for candidates still returned by Rust', () => {
		const stale = {
			'7': { selected: true, maxUnitBidEth: '0.5', maxUnitBidEthEdited: true },
			'9': { selected: true, maxUnitBidEth: '4', maxUnitBidEthEdited: true }
		};

		expect(syncBiddingMandateSelections([CANDIDATE], stale)).toEqual({
			'7': { selected: true, maxUnitBidEth: '0.5', maxUnitBidEthEdited: true }
		});
	});

	it('prefills enabled-job maxima without selecting collections', () => {
		expect(syncBiddingMandateSelections([CANDIDATE], {})).toEqual({
			'7': {
				selected: false,
				maxUnitBidEth: '1.25',
				maxUnitBidEthEdited: false
			}
		});
		expect(
			syncBiddingMandateSelections([{ ...CANDIDATE, activeJobMaxCeilingEth: null }], {})
		).toEqual({
			'7': { selected: false, maxUnitBidEth: '', maxUnitBidEthEdited: false }
		});
	});

	it('orders enabled-job maxima by exact WETH value with missing prefills last', () => {
		const candidates = [
			{ ...CANDIDATE, collectionId: 8, artgodSlug: 'blank', activeJobMaxCeilingEth: null },
			{ ...CANDIDATE, collectionId: 9, artgodSlug: 'nine', activeJobMaxCeilingEth: '9' },
			{ ...CANDIDATE, collectionId: 10, artgodSlug: 'ten', activeJobMaxCeilingEth: '10' },
			{ ...CANDIDATE, collectionId: 11, artgodSlug: 'fraction', activeJobMaxCeilingEth: '9.5' },
			{
				...CANDIDATE,
				collectionId: 12,
				artgodSlug: 'precise',
				activeJobMaxCeilingEth: '9.500000000000000001'
			}
		];

		expect(
			sortBiddingCollectionCandidatesByMaxUnitBid(candidates).map(
				(candidate) => candidate.collectionId
			)
		).toEqual([10, 12, 11, 9, 8]);
		expect(candidates.map((candidate) => candidate.collectionId)).toEqual([8, 9, 10, 11, 12]);
	});

	it('uses collection identity as a stable tie-breaker for equal price maxima', () => {
		const candidates = [
			{ ...CANDIDATE, collectionId: 10, artgodSlug: 'zeta', activeJobMaxCeilingEth: '1.2' },
			{ ...CANDIDATE, collectionId: 9, artgodSlug: 'alpha', activeJobMaxCeilingEth: '1.20' },
			{ ...CANDIDATE, collectionId: 8, artgodSlug: 'alpha', activeJobMaxCeilingEth: '1.2' }
		];

		expect(
			sortBiddingCollectionCandidatesByMaxUnitBid(candidates).map(
				(candidate) => candidate.collectionId
			)
		).toEqual([8, 9, 10]);
	});

	it('refreshes untouched prefills without overwriting checked or edited drafts', () => {
		const changedCandidate = { ...CANDIDATE, activeJobMaxCeilingEth: '2' };
		expect(
			syncBiddingMandateSelections([changedCandidate], {
				'7': { selected: false, maxUnitBidEth: '1.25', maxUnitBidEthEdited: false }
			})
		).toEqual({
			'7': { selected: false, maxUnitBidEth: '2', maxUnitBidEthEdited: false }
		});
		expect(
			syncBiddingMandateSelections([changedCandidate], {
				'7': { selected: true, maxUnitBidEth: '1.25', maxUnitBidEthEdited: false }
			})
		).toEqual({
			'7': { selected: true, maxUnitBidEth: '1.25', maxUnitBidEthEdited: false }
		});
		expect(
			syncBiddingMandateSelections([changedCandidate], {
				'7': { selected: false, maxUnitBidEth: '1.5', maxUnitBidEthEdited: true }
			})
		).toEqual({
			'7': { selected: false, maxUnitBidEth: '1.5', maxUnitBidEthEdited: true }
		});
	});

	it('rejects empty and zero-value mandates', () => {
		expect(() => buildBiddingMandateDraft([CANDIDATE], {})).toThrow('Select at least one');
		expect(() =>
			buildBiddingMandateDraft([CANDIDATE], {
				'7': { selected: true, maxUnitBidEth: '0.0', maxUnitBidEthEdited: true }
			})
		).toThrow('max WETH per NFT');
	});

	it('formats active native wei caps without floating point conversion', () => {
		expect(formatBiddingMandateWeiAsEth('1250000000000000000')).toBe('1.25 WETH');
	});

	it('formats token scope without repeating its canonical summary', () => {
		expect(
			formatBiddingMandateTokenScope({
				label: 'all contract tokens',
				items: [{ label: 'scope', value: 'all contract tokens' }]
			})
		).toBe('all contract tokens');
		expect(formatBiddingMandateTokenScope(CANDIDATE.tokenScope)).toBe('range · tokens: 100-199');
	});
});
