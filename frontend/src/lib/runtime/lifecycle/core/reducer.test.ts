import { describe, expect, it } from 'vitest';

import { appendLifecycleEvent, createInitialLifecycleState, reduceLifecycle } from './reducer';
import type { LifecycleState } from './types';
import type { RuntimeStatus } from '../ports';

function makeStatus(state: string, overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
	return {
		state,
		restartCount: 0,
		lastError: null,
		runningProcesses: [],
		backendHttpBaseUrl: 'http://127.0.0.1:42710',
		natsUrl: 'nats://127.0.0.1:42720',
		configPath: '/tmp/.env',
		...overrides
	};
}

describe('lifecycle reducer', () => {
	it('creates expected initial lifecycle state for desktop and web modes', () => {
		const desktop = createInitialLifecycleState(true, 1000);
		expect(desktop.phase).toBe('booting');
		expect(desktop.apiReady).toBe(false);
		expect(desktop.currentAction).toBe('Launching desktop runtime...');

		const web = createInitialLifecycleState(false, 2000);
		expect(web.phase).toBe('ready');
		expect(web.apiReady).toBe(true);
		expect(web.currentAction).toBe('Web runtime mode');
	});

	it('assigns event ids and prunes events by configured limit', () => {
		let state = createInitialLifecycleState(true, 0);

		state = appendLifecycleEvent(
			state,
			{ id: -1, atIso: '2026-01-01T00:00:00.000Z', level: 'info', code: 'a', message: 'A' },
			2
		);
		state = appendLifecycleEvent(
			state,
			{ id: -1, atIso: '2026-01-01T00:00:01.000Z', level: 'info', code: 'b', message: 'B' },
			2
		);
		state = appendLifecycleEvent(
			state,
			{ id: -1, atIso: '2026-01-01T00:00:02.000Z', level: 'info', code: 'c', message: 'C' },
			2
		);

		expect(state.events.map((event) => event.code)).toEqual(['b', 'c']);
		expect(state.events.map((event) => event.id)).toEqual([2, 3]);
		expect(state.nextEventId).toBe(4);
	});

	it('keeps lifecycle in booting when runtime is running but API is not ready', () => {
		const state = createInitialLifecycleState(true, 0);
		const next = reduceLifecycle(state, {
			type: 'APPLY_RUNTIME_STATUS',
			status: makeStatus('running'),
			previous: makeStatus('starting'),
			startedAtMs: 123
		});

		expect(next.phase).toBe('booting');
		expect(next.currentAction).toBe('Runtime running. Waiting for first backend API response...');
		expect(next.apiReady).toBe(false);
		expect(next.events.at(-1)?.code).toBe('runtime.state.running');
	});

	it('transitions to ready on API_READY only when stopping lock is inactive', () => {
		const base = createInitialLifecycleState(true, 0);

		const ready = reduceLifecycle(base, {
			type: 'API_READY',
			startedAtMs: 999
		});
		expect(ready.phase).toBe('ready');
		expect(ready.apiReady).toBe(true);
		expect(ready.currentAction).toBe('Runtime ready');

		const stoppingBase: LifecycleState = {
			...base,
			stoppingLockActive: true,
			phase: 'stopping'
		};
		const stillStopping = reduceLifecycle(stoppingBase, {
			type: 'API_READY',
			startedAtMs: 1000
		});
		expect(stillStopping.phase).toBe('stopping');
		expect(stillStopping.apiReady).toBe(true);
	});

	it('ignores non-stopping status updates while stopping lock is active', () => {
		const state: LifecycleState = {
			...createInitialLifecycleState(true, 0),
			phase: 'stopping',
			stoppingLockActive: true
		};

		const next = reduceLifecycle(state, {
			type: 'APPLY_RUNTIME_STATUS',
			status: makeStatus('running'),
			previous: makeStatus('stopping'),
			startedAtMs: 111
		});

		expect(next).toEqual(state);
	});
});
