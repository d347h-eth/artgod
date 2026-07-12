import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import TokenDetailMediaError from './TokenDetailMediaError.svelte';

describe('TokenDetailMediaError', () => {
	it('renders a brief recovery action inside the media error surface', () => {
		const { body } = render(TokenDetailMediaError, {
			props: {
				message: 'Unable to load media.',
				onRetry: vi.fn()
			}
		});

		expect(body).toContain('role="alert"');
		expect(body).toContain('Unable to load media.');
		expect(body).toContain('aria-label="retry loading media"');
		expect(body).toContain('>retry</button>');
		expect(body).not.toContain('rpc');
	});
});
