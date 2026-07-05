import type { AdminConfigState } from '$lib/admin/configuration/ports';
import {
	ADMIN_CONFIG_VALIDATION_ISSUE_KINDS,
	formatLaunchConfigIssueSummary,
	resolveAdminLaunchConfigIssues
} from '$lib/admin/configuration/validation';
import type { LifecyclePhase } from '$lib/runtime/lifecycle/core/types';
import { RUNTIME_STATUS_STATES, type RuntimeStatus } from '$lib/runtime/lifecycle/ports';
import { RPC_ENDPOINT_LIST_ENV_KEY } from '@artgod/shared/config/rpc-endpoints';

export const ADMIN_ACTION_FLOW_LABELS = {
	config: 'config',
	bootWithDefaults: 'start infra with default settings',
	boot: 'start infra',
	userland: 'enter the userland'
} as const;

export const ADMIN_FLOW_STATES = {
	loading: 'loading',
	needsConfig: 'needs_config',
	needsRequiredConfig: 'needs_required_config',
	readyToBoot: 'ready_to_boot',
	booting: 'booting',
	running: 'running',
	ready: 'ready'
} as const;

type AdminRuntimeState = (typeof ADMIN_RUNTIME_STATES)[keyof typeof ADMIN_RUNTIME_STATES];

export type AdminFlowState = (typeof ADMIN_FLOW_STATES)[keyof typeof ADMIN_FLOW_STATES];

export type AdminFlowAction = {
	disabled: boolean;
	label: string;
};

export type AdminBootAction = AdminFlowAction & {
	usesDefaults: boolean;
	disabledReason: string | null;
	requiredConfigIssueKeys: string[];
};

export type AdminActionFlowInput = {
	config: AdminConfigState | null;
	configLoading: boolean;
	configBusyAction: string | null;
	runtimeInitialized: boolean;
	runtimeStatus: RuntimeStatus | null;
	runtimeBusyAction: string | null;
	lifecyclePhase: LifecyclePhase;
	rpcAutoSourcingFailed: boolean;
};

export type AdminActionFlow = {
	state: AdminFlowState;
	configure: AdminFlowAction;
	boot: AdminBootAction;
	userland: AdminFlowAction;
};

const ADMIN_RUNTIME_STATES = {
	unknown: 'unknown',
	starting: RUNTIME_STATUS_STATES.starting,
	restarting: RUNTIME_STATUS_STATES.restarting,
	stopping: RUNTIME_STATUS_STATES.stopping,
	running: RUNTIME_STATUS_STATES.running
} as const;

const ADMIN_LIFECYCLE_PHASES = {
	ready: 'ready'
} as const satisfies Record<string, LifecyclePhase>;

const RUNTIME_TRANSIENT_STATES = new Set<AdminRuntimeState>([
	ADMIN_RUNTIME_STATES.starting,
	ADMIN_RUNTIME_STATES.restarting,
	ADMIN_RUNTIME_STATES.stopping
]);

// Resolves the Admin header action sequence from configuration and runtime state.
export function resolveAdminActionFlow(input: AdminActionFlowInput): AdminActionFlow {
	const runtimeState = resolveRuntimeState(input.runtimeStatus);
	const configBusy = input.configLoading || input.configBusyAction !== null;
	const runtimeBusy =
		!input.runtimeInitialized ||
		input.runtimeBusyAction !== null ||
		RUNTIME_TRANSIENT_STATES.has(runtimeState);
	const runtimeRunning = runtimeState === ADMIN_RUNTIME_STATES.running;
	const userlandReady = input.lifecyclePhase === ADMIN_LIFECYCLE_PHASES.ready;
	const configured = input.config?.configured === true;
	const bootUsesDefaults = !configured;
	const requiredConfigIssues = resolveAdminLaunchConfigIssues(input.config);
	const autoSourceableRpcIssue = requiredConfigIssues.find((issue) =>
		isAutoSourceableMissingRpcIssue(issue, configured)
	);
	const blockingRequiredConfigIssues = requiredConfigIssues.filter(
		(issue) => !isAutoSourceableMissingRpcIssue(issue, configured)
	);
	const requiredConfigReady = input.config !== null && blockingRequiredConfigIssues.length === 0;
	const bootWarningReason =
		blockingRequiredConfigIssues.length > 0
			? formatLaunchConfigIssueSummary(blockingRequiredConfigIssues)
			: input.rpcAutoSourcingFailed && autoSourceableRpcIssue
				? `Automated RPC sourcing failed: ${RPC_ENDPOINT_LIST_ENV_KEY}`
				: null;

	const state = resolveFlowState({
		configLoaded: !input.configLoading && input.config !== null,
		configured,
		requiredConfigReady,
		runtimeBusy,
		runtimeRunning,
		userlandReady
	});

	return {
		state,
		configure: {
			label: ADMIN_ACTION_FLOW_LABELS.config,
			disabled: false
		},
		boot: {
			label: bootUsesDefaults
				? ADMIN_ACTION_FLOW_LABELS.bootWithDefaults
				: ADMIN_ACTION_FLOW_LABELS.boot,
			usesDefaults: bootUsesDefaults,
			disabledReason: bootWarningReason,
			requiredConfigIssueKeys: blockingRequiredConfigIssues.map((issue) => issue.key),
			disabled:
				input.configLoading ||
				input.config === null ||
				configBusy ||
				runtimeBusy ||
				runtimeRunning ||
				userlandReady ||
				!requiredConfigReady
		},
		userland: {
			label: ADMIN_ACTION_FLOW_LABELS.userland,
			disabled: !userlandReady || input.runtimeBusyAction !== null
		}
	};
}

function resolveRuntimeState(status: RuntimeStatus | null): AdminRuntimeState {
	const state = status?.state;
	if (state === ADMIN_RUNTIME_STATES.starting) {
		return ADMIN_RUNTIME_STATES.starting;
	}
	if (state === ADMIN_RUNTIME_STATES.restarting) {
		return ADMIN_RUNTIME_STATES.restarting;
	}
	if (state === ADMIN_RUNTIME_STATES.stopping) {
		return ADMIN_RUNTIME_STATES.stopping;
	}
	if (state === ADMIN_RUNTIME_STATES.running) {
		return ADMIN_RUNTIME_STATES.running;
	}
	return ADMIN_RUNTIME_STATES.unknown;
}

function isAutoSourceableMissingRpcIssue(
	issue: ReturnType<typeof resolveAdminLaunchConfigIssues>[number],
	configured: boolean
): boolean {
	return (
		!configured &&
		issue.key === RPC_ENDPOINT_LIST_ENV_KEY &&
		issue.kind === ADMIN_CONFIG_VALIDATION_ISSUE_KINDS.required
	);
}

function resolveFlowState(input: {
	configLoaded: boolean;
	configured: boolean;
	requiredConfigReady: boolean;
	runtimeBusy: boolean;
	runtimeRunning: boolean;
	userlandReady: boolean;
}): AdminFlowState {
	if (!input.configLoaded) {
		return ADMIN_FLOW_STATES.loading;
	}
	if (input.userlandReady) {
		return ADMIN_FLOW_STATES.ready;
	}
	if (input.runtimeBusy) {
		return ADMIN_FLOW_STATES.booting;
	}
	if (input.runtimeRunning) {
		return ADMIN_FLOW_STATES.running;
	}
	if (!input.requiredConfigReady) {
		return input.configured ? ADMIN_FLOW_STATES.needsRequiredConfig : ADMIN_FLOW_STATES.needsConfig;
	}
	if (!input.configured) {
		return ADMIN_FLOW_STATES.needsConfig;
	}
	return ADMIN_FLOW_STATES.readyToBoot;
}
