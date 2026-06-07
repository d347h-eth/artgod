import { describe, expect, it } from 'vitest';
import { RPC_ENDPOINT_LIST_ENV_KEY } from '@artgod/shared/config/rpc-endpoints';

import {
	ADMIN_ACTION_FLOW_LABELS,
	ADMIN_FLOW_STATES,
	resolveAdminActionFlow
} from './admin-action-flow';
import type { AdminConfigState } from '$lib/admin/configuration/ports';
import type { LifecyclePhase } from '$lib/runtime/lifecycle/core/types';
import type { RuntimeStatus } from '$lib/runtime/lifecycle/ports';

const REQUIRED_RPC_KEY = RPC_ENDPOINT_LIST_ENV_KEY;

function configState(
	configured: boolean,
	values: Record<string, string> = {
		[REQUIRED_RPC_KEY]: '[{"url":"https://rpc.example","weight":1}]'
	}
): AdminConfigState {
	return {
		configured,
		envFilePath: '/tmp/.env',
		envFileExists: configured,
		settingsFilePath: '/tmp/settings.json',
		settingsFileExists: configured,
		autoLaunchOnStartup: false,
		values,
		defaults: {},
		groups: [
			{
				id: 'chain-rpc',
				label: 'chain rpc',
				fields: [
					{
						key: REQUIRED_RPC_KEY,
						label: 'rpc endpoints',
						inputKind: 'weighted_endpoint_list',
						secret: false,
						options: [],
						help: '',
						requiredForLaunch: true,
						validation: 'rpc_endpoint_list',
						view: 'basic'
					}
				]
			}
		]
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

		expect(state.state).toBe(ADMIN_FLOW_STATES.needsConfig);
		expect(state.boot.label).toBe(ADMIN_ACTION_FLOW_LABELS.bootWithDefaults);
		expect(state.boot.usesDefaults).toBe(true);
		expect(state.boot.disabled).toBe(false);
	});

	it('boots saved configuration when settings exist', () => {
		const state = flow({ config: configState(true) });

		expect(state.state).toBe(ADMIN_FLOW_STATES.readyToBoot);
		expect(state.boot.label).toBe(ADMIN_ACTION_FLOW_LABELS.boot);
		expect(state.boot.usesDefaults).toBe(false);
		expect(state.boot.disabled).toBe(false);
	});

	it('requires a non-empty RPC URL before default boot is available', () => {
		const state = flow({
			config: configState(false, {
				[REQUIRED_RPC_KEY]: ''
			})
		});

		expect(state.state).toBe(ADMIN_FLOW_STATES.needsConfig);
		expect(state.boot.label).toBe(ADMIN_ACTION_FLOW_LABELS.bootWithDefaults);
		expect(state.boot.disabled).toBe(true);
		expect(state.boot.disabledReason).toBe(
			`Required configuration is missing: ${RPC_ENDPOINT_LIST_ENV_KEY}`
		);
		expect(state.boot.requiredConfigIssueKeys).toEqual([REQUIRED_RPC_KEY]);
	});

	it('requires a non-empty RPC URL before saved boot is available', () => {
		const state = flow({
			config: configState(true, {
				[REQUIRED_RPC_KEY]: '   '
			})
		});

		expect(state.state).toBe(ADMIN_FLOW_STATES.needsRequiredConfig);
		expect(state.boot.label).toBe(ADMIN_ACTION_FLOW_LABELS.boot);
		expect(state.boot.disabled).toBe(true);
		expect(state.boot.disabledReason).toBe(
			`Required configuration is missing: ${RPC_ENDPOINT_LIST_ENV_KEY}`
		);
	});

	it('explains invalid required launch configuration', () => {
		const state = flow({
			config: configState(true, {
				[REQUIRED_RPC_KEY]: 'not a url'
			})
		});

		expect(state.state).toBe(ADMIN_FLOW_STATES.needsRequiredConfig);
		expect(state.boot.disabled).toBe(true);
		expect(state.boot.disabledReason).toBe(
			`Required configuration is missing or invalid: ${RPC_ENDPOINT_LIST_ENV_KEY}`
		);
	});

	it('disables boot during transient runtime states', () => {
		const state = flow({ runtimeStatus: runtimeStatus('starting') });

		expect(state.state).toBe(ADMIN_FLOW_STATES.booting);
		expect(state.boot.disabled).toBe(true);
		expect(state.userland.disabled).toBe(true);
	});

	it('waits for runtime initialization before booting', () => {
		const state = flow({ runtimeInitialized: false });

		expect(state.state).toBe(ADMIN_FLOW_STATES.booting);
		expect(state.boot.disabled).toBe(true);
	});

	it('only enables userland after backend readiness', () => {
		const state = flow({
			runtimeStatus: runtimeStatus('running'),
			lifecyclePhase: 'ready'
		});

		expect(state.state).toBe(ADMIN_FLOW_STATES.ready);
		expect(state.boot.disabled).toBe(true);
		expect(state.userland.disabled).toBe(false);
	});
});
