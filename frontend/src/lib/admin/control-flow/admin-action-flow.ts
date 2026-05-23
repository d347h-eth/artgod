import type { AdminConfigState } from '$lib/admin/configuration/ports';
import type { LifecyclePhase } from '$lib/runtime/lifecycle/core/types';
import type { RuntimeStatus } from '$lib/runtime/lifecycle/ports';

export type AdminFlowState =
	| 'loading'
	| 'needs_config'
	| 'ready_to_boot'
	| 'booting'
	| 'running'
	| 'ready';

export type AdminFlowAction = {
	disabled: boolean;
	label: string;
};

export type AdminBootAction = AdminFlowAction & {
	usesDefaults: boolean;
};

export type AdminActionFlowInput = {
	config: AdminConfigState | null;
	configLoading: boolean;
	configBusyAction: string | null;
	runtimeInitialized: boolean;
	runtimeStatus: RuntimeStatus | null;
	runtimeBusyAction: string | null;
	lifecyclePhase: LifecyclePhase;
};

export type AdminActionFlow = {
	state: AdminFlowState;
	configure: AdminFlowAction;
	boot: AdminBootAction;
	userland: AdminFlowAction;
};

const RUNTIME_TRANSIENT_STATES = new Set(['starting', 'restarting', 'stopping']);

// Resolves the Admin header action sequence from configuration and runtime state.
export function resolveAdminActionFlow(input: AdminActionFlowInput): AdminActionFlow {
	const runtimeState = input.runtimeStatus?.state ?? 'unknown';
	const configBusy = input.configLoading || input.configBusyAction !== null;
	const runtimeBusy =
		!input.runtimeInitialized ||
		input.runtimeBusyAction !== null ||
		RUNTIME_TRANSIENT_STATES.has(runtimeState);
	const runtimeRunning = runtimeState === 'running';
	const userlandReady = input.lifecyclePhase === 'ready';
	const configured = input.config?.configured === true;
	const bootUsesDefaults = !configured;

	let state: AdminFlowState = 'ready_to_boot';
	if (input.configLoading || input.config === null) {
		state = 'loading';
	} else if (userlandReady) {
		state = 'ready';
	} else if (runtimeBusy) {
		state = 'booting';
	} else if (runtimeRunning) {
		state = 'running';
	} else if (!configured) {
		state = 'needs_config';
	}

	return {
		state,
		configure: {
			label: 'configuration',
			disabled: input.configLoading || input.configBusyAction !== null
		},
		boot: {
			label: bootUsesDefaults ? 'boot system with default settings' : 'boot system',
			usesDefaults: bootUsesDefaults,
			disabled:
				input.configLoading ||
				input.config === null ||
				configBusy ||
				runtimeBusy ||
				runtimeRunning ||
				userlandReady
		},
		userland: {
			label: 'enter the userland',
			disabled: !userlandReady || input.runtimeBusyAction !== null
		}
	};
}
