import { describe, expect, it } from 'vitest';
import { EVM_TOKEN_ID_MAX } from '@artgod/shared/evm/token-id';
import { openseaItemHref, parseNftUrl } from './marketplace-links';

const contractAddress = '0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270';
const tokenId = '163000681';
const pair = `${contractAddress}/${tokenId}`;

describe('NFT URL identity', () => {
	it.each([
		`https://opensea.io/item/ethereum/${pair}`,
		`https://opensea.io/assets/ethereum/${pair}`,
		`https://gallery.example/any/path/${pair}`,
		`http://127.0.0.1:8000/nfts/${pair}/details?view=full#media`,
		`//another.example/${pair}/`,
		`https://gallery.example/arbitrary-chain/${pair}?ref=shared#media`,
		`  https://gallery.example/${pair}/  `,
		`/${pair}`,
		pair
	])('extracts the path pair regardless of the host or preceding path: %s', (value) => {
		expect(parseNftUrl(value)).toEqual({ contractAddress, tokenId });
	});

	it.each(['0', '000123', '9007199254740993', EVM_TOKEN_ID_MAX.toString()])(
		'normalizes decimal token %s without losing precision',
		(value) => {
			expect(
				parseNftUrl(`https://gallery.example/${contractAddress.toUpperCase()}/${value}`)
			).toEqual({ contractAddress, tokenId: BigInt(value).toString() });
		}
	);

	it.each([
		'',
		contractAddress,
		`https://gallery.example/${contractAddress}`,
		`https://gallery.example/${contractAddress}/-1`,
		`https://gallery.example/${contractAddress}/1.5`,
		`https://gallery.example/${contractAddress}/1e3`,
		`https://gallery.example/${contractAddress}/0x10`,
		`https://gallery.example/${contractAddress}/123abc`,
		`https://gallery.example/${contractAddress}/${EVM_TOKEN_ID_MAX + 1n}`,
		`https://gallery.example/${contractAddress}/${'9'.repeat(1000)}`,
		`https://gallery.example/${contractAddress.slice(0, -1)}/${tokenId}`,
		`https://gallery.example/${contractAddress}0/${tokenId}`,
		`https://gallery.example/x${pair}`,
		`https://gallery.example/${contractAddress.replace('a7', 'zz')}/${tokenId}`,
		`https://gallery.example/?redirect=/${pair}`,
		`https://gallery.example/#/${pair}`,
		`https://${pair}`
	])('rejects incomplete or invalid path pairs: %s', (value) => {
		expect(parseNftUrl(value)).toBeNull();
	});

	it('parses the app’s existing outgoing item links', () => {
		expect(
			parseNftUrl(
				openseaItemHref({ chainSlug: 'ethereum', collectionAddress: contractAddress, tokenId })!
			)
		).toEqual({ contractAddress, tokenId });
	});
});
