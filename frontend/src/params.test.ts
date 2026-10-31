import { describe, expect, it } from 'vitest';
import { params } from './params';

describe('numeric route parameters', () => {
	it('preserves the token reference as a string, including leading zeroes', () => {
		for (const value of ['0', '0007', '123456789012345678901234567890']) {
			expect(params.numeric['~standard'].validate(value)).toEqual({ value });
		}
	});

	it('rejects values outside the original decimal route contract', () => {
		for (const value of ['', '-1', '1.5', 'abc', '12x']) {
			expect(params.numeric['~standard'].validate(value)).toHaveProperty('issues');
		}
	});
});
