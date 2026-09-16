import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createRuntimeRecoveryFixture } from '$lib/e2e/runtime-recovery-fixture';
import { RECOVERY_HARNESS_SCENARIOS } from '$lib/e2e/runtime-recovery-contract';
import { RECOVERY_FAILURE_REASONS } from './lifecycle/ports';

describe('desktop runtime store recovery commands', () => {
	it('does not renew recovery through repeated auto-start handshakes', async () => {
		const f = createRuntimeRecoveryFixture(RECOVERY_HARNESS_SCENARIOS.autoStart);
		try {
			await f.store.autoStart();
			const activity = f.status().startup;
			await f.store.autoStart();
			expect(f.status().operationId).toBe(1);
			expect(f.status().startup).toBe(activity);
			f.fail(RECOVERY_FAILURE_REASONS.timedOut);
			await f.store.autoStart();
			expect(f.status().operationId).toBe(1);
			expect(get(f.store.state).lifecycle.phase).toBe('fatal');
		} finally {
			f.store.dispose();
		}
	});
	it('starts a new recovery operation after terminal cleanup and preserves stop/start Restart semantics', async () => {
		const f = createRuntimeRecoveryFixture();
		try {
			await f.store.start();
			expect(get(f.store.state).lifecycle.phase).toBe('recovering');
			f.fail(RECOVERY_FAILURE_REASONS.failed);
			expect(get(f.store.state).lifecycle.phase).toBe('fatal');
			await f.store.start();
			expect(f.status().operationId).toBe(2);
			f.running();
			await f.store.waitUntilReady();
			expect(f.store.isLifecycleReady()).toBe(true);
			await f.store.restart();
			expect(f.status().operationId).toBe(3);
			expect(get(f.store.state).lifecycle.phase).toBe('recovering');
			f.running();
			await f.store.waitUntilReady();
			expect(f.calls.filter((call) => call === 'probe')).toHaveLength(2);
		} finally {
			f.store.dispose();
		}
	});

	it('keeps Stop busy until cleanup and ignores late readiness from the cancelled operation', async () => {
		const f = createRuntimeRecoveryFixture();
		try {
			await f.store.start();
			const stop = f.store.stop();
			for (let i = 0; i < 30; i++) await Promise.resolve();
			expect(get(f.store.state).busyAction).toBe('stop');
			f.lateRunning();
			expect(f.store.isLifecycleReady()).toBe(false);
			f.finishStop();
			await stop;
			expect(get(f.store.state).busyAction).toBe(null);
			await f.store.start();
			expect(get(f.store.state).lifecycle.phase).toBe('recovering');
		} finally {
			f.store.dispose();
		}
	});
});
