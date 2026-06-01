import { describe, expect, it } from 'vitest';
import { parseRuntimeLogLine } from './log-line-format';

describe('runtime log line format', () => {
	it('parses structured JSON lines without requiring bracket prefixes', () => {
		expect(
			parseRuntimeLogLine(
				JSON.stringify({
					t: '2026-06-01T12:00:00Z',
					level: 'info',
					component: 'BackendApi',
					action: 'startup',
					stream: 'stdout',
					msg: 'Backend API ready'
				})
			)
		).toEqual({
			tokens: ['2026-06-01T12:00:00Z', 'info', 'BackendApi', 'startup', 'stdout'],
			message: 'Backend API ready'
		});
	});

	it('keeps bracket-prefixed lines readable for older local tails', () => {
		expect(parseRuntimeLogLine('[stdout] worker ready')).toEqual({
			tokens: ['stdout'],
			message: 'worker ready'
		});
	});
});
