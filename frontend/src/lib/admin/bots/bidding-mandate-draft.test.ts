import { describe, expect, it } from 'vitest';
import type { AdminBiddingCollectionCandidate } from './ports';
import {
	buildBiddingMandateDraft,
	formatBiddingChainIdentity,
	formatBiddingMandateTokenScope,
	formatBiddingMandateWeiAsEth,
	syncBiddingMandateSelections,
	type BiddingMandateSelections
} from './bidding-mandate-draft';

const CANDIDATE: AdminBiddingCollectionCandidate = {
	chainId: 1,
	collectionId: 7,
	artgodSlug: 'shared-contract-art',
	contractAddress: '0x1111111111111111111111111111111111111111',
	openseaSlug: 'shared-contract-opensea',
	tokenScope: { label: 'range', items: [{ label: 'tokens', value: '100-199' }] }
};

describe('bidding mandate draft', () => {
	it('formats the named chain before its qualified external id', () => {
		expect(formatBiddingChainIdentity({ chainId: 1, name: 'Ethereum' })).toBe(
			'Ethereum · chain ID #1'
		);
		expect(formatBiddingChainIdentity({ chainId: 1, name: 'Ethereum' }, 10)).toBe('chain ID #10');
	});

	it('sends only collection ids and operator caps to Rust', () => {
		const selections: BiddingMandateSelections = {
			[CANDIDATE.collectionId]: {
				selected: true,
				maxUnitBidEth: '1.25',
				maxQuantity: '2'
			}
		};

		expect(buildBiddingMandateDraft([CANDIDATE], selections)).toEqual({
			collections: [{ collectionId: 7, maxUnitBidEth: '1.25', maxQuantity: 2 }]
		});
	});

	it('preserves caps only for candidates still returned by Rust', () => {
		const stale = {
			'7': { selected: true, maxUnitBidEth: '0.5', maxQuantity: '3' },
			'9': { selected: true, maxUnitBidEth: '4', maxQuantity: '1' }
		};

		expect(syncBiddingMandateSelections([CANDIDATE], stale)).toEqual({
			'7': { selected: true, maxUnitBidEth: '0.5', maxQuantity: '3' }
		});
	});

	it('rejects empty and zero-value mandates', () => {
		expect(() => buildBiddingMandateDraft([CANDIDATE], {})).toThrow('Select at least one');
		expect(() =>
			buildBiddingMandateDraft([CANDIDATE], {
				'7': { selected: true, maxUnitBidEth: '0.0', maxQuantity: '1' }
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
		expect(formatBiddingMandateTokenScope(CANDIDATE.tokenScope)).toBe(
			'range · tokens: 100-199'
		);
	});
});
