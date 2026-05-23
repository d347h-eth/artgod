import { describe, expect, it } from 'vitest';

import { resolveAdminActionFlow } from './admin-action-flow';
import type { AdminConfigState } from '$lib/admin/configuration/ports';
import type { LifecyclePhase } from '$lib/runtime/lifecycle/core/types';
import type { RuntimeStatus } from '$lib/runtime/lifecycle/ports';

function configState(configured: boolean): AdminConfigState {
	return {
		configured,
		envFilePath: '/tmp/.env',
		envFileExists: configured,
		settingsFilePath: '/tmp/settings.json',
		settingsFileExists: configured,
		autoLaunchOnStartup: false,
		values: {},
		defaults: {},
		groups: []
	};
}

function runtimeStatus(state: string): RuntimeStatus {
	return {
		state,
		restartCount: 0,
		lastError: null,
		runningProcesses: [],
		backendHttpBaseUrl: '',
		natsUrl: '',
		configPath: ''
	};
}

function flow(input: {
	config?: AdminConfigState | null;
	configLoading?: boolean;
	configBusyAction?: string | null;
	runtimeInitialized?: boolean;
	runtimeStatus?: RuntimeStatus | null;
	runtimeBusyAction?: string | null;
	lifecyclePhase?: LifecyclePhase;
}) {
	return resolveAdminActionFlow({
		config: input.config ?? configState(true),
		configLoading: input.configLoading ?? false,
		configBusyAction: input.configBusyAction ?? null,
		runtimeInitialized: input.runtimeInitialized ?? true,
		runtimeStatus: input.runtimeStatus ?? runtimeStatus('stopped'),
		runtimeBusyAction: input.runtimeBusyAction ?? null,
		lifecyclePhase: input.lifecyclePhase ?? 'booting'
	});
}

describe('resolveAdminActionFlow', () => {
	it('boots with defaults when settings are missing', () => {
		const state = flow({ config: configState(false) });

		expect(state.state).toBe('needs_config');
		expect(state.boot.label).toBe('start infra with default settings');
		expect(state.boot.usesDefaults).toBe(true);
		expect(state.boot.disabled).toBe(false);
	});

	it('boots saved configuration when settings exist', () => {
		const state = flow({ config: configState(true) });

		expect(state.state).toBe('ready_to_boot');
		expect(state.boot.label).toBe('start infra');
		expect(state.boot.usesDefaults).toBe(false);
		expect(state.boot.disabled).toBe(false);
	});

	it('disables boot during transient runtime states', () => {
		const state = flow({ runtimeStatus: runtimeStatus('starting') });

		expect(state.state).toBe('booting');
		expect(state.boot.disabled).toBe(true);
		expect(state.userland.disabled).toBe(true);
	});

	it('waits for runtime initialization before booting', () => {
		const state = flow({ runtimeInitialized: false });

		expect(state.state).toBe('booting');
		expect(state.boot.disabled).toBe(true);
	});

	it('only enables userland after backend readiness', () => {
		const state = flow({
			runtimeStatus: runtimeStatus('running'),
			lifecyclePhase: 'ready'
		});

		expect(state.state).toBe('ready');
		expect(state.boot.disabled).toBe(true);
		expect(state.userland.disabled).toBe(false);
	});
});
