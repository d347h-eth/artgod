import type { AdminConfigPort, AdminConfigState } from '$lib/admin/configuration/ports';
import { createDesktopRuntimeStore } from '$lib/runtime/desktop-runtime-store';
import {
	RECOVERY_TASKS,
	STARTUP_PHASES,
	RUNTIME_STATUS_STATES,
	type RuntimePort,
	type RuntimeStatus,
	type RuntimeStatusListener,
	type RecoveryFailure
} from '$lib/runtime/lifecycle/ports';
import { RPC_ENDPOINT_LIST_ENV_KEY } from '@artgod/shared/config/rpc-endpoints';
import { OPENSEA_API_KEY_ENV } from '@artgod/shared/config/opensea-integration';

import {
	RECOVERY_HARNESS_SCENARIOS,
	type RecoveryHarnessScenario
} from './runtime-recovery-contract';
export * from './runtime-recovery-contract';

/** Synthetic bridge only. Uses the production store, orchestrator and Admin surface. */
export function createRuntimeRecoveryFixture(
	scenario: RecoveryHarnessScenario = RECOVERY_HARNESS_SCENARIOS.manual
) {
	let status: RuntimeStatus = {
		state: RUNTIME_STATUS_STATES.stopped,
		operationId: 0,
		revision: 1,
		startup: null,
		recoveryFailure: null,
		restartCount: 0,
		lastError: null,
		runningProcesses: [],
		backendHttpBaseUrl: '',
		natsUrl: '',
		configPath: 'fixture/config.env'
	};
	const listeners = new Set<RuntimeStatusListener>();
	const calls: string[] = [];
	let finishStop: (() => void) | null = null;
	let finishProbe: (() => void) | null = null;
	let holdProbe = false;
	const config: AdminConfigState = {
		configured: true,
		envFilePath: 'fixture/config.env',
		envFileExists: true,
		settingsFilePath: 'fixture/settings.json',
		settingsFileExists: true,
		autoLaunchOnStartup: scenario === RECOVERY_HARNESS_SCENARIOS.autoStart,
		values: {
			[RPC_ENDPOINT_LIST_ENV_KEY]: 'https://rpc.example.invalid',
			[OPENSEA_API_KEY_ENV]: 'synthetic-key'
		},
		defaults: {},
		groups: []
	};
	function publish(update: Partial<RuntimeStatus>) {
		status = { ...status, ...update, revision: status.revision + 1 };
		for (const listener of listeners) listener(status);
		return status;
	}
	function begin() {
		return publish({
			state: RUNTIME_STATUS_STATES.starting,
			operationId: status.operationId + 1,
			lastError: null,
			recoveryFailure: null,
			runningProcesses: [],
			startup: {
				phase: STARTUP_PHASES.recovery,
				task: RECOVERY_TASKS.natsMaintenance,
				startedAtMs: Date.now(),
				deadlineAtMs: Date.now() + 120_000
			}
		});
	}
	if (
		scenario === RECOVERY_HARNESS_SCENARIOS.attached ||
		scenario === RECOVERY_HARNESS_SCENARIOS.drawer
	)
		begin();
	const runtimePort: RuntimePort = {
		async loadBridge() {
			return true;
		},
		isBridgeAvailable: () => true,
		async autoStart() {
			calls.push('autoStart');
			return config.autoLaunchOnStartup &&
				status.state === RUNTIME_STATUS_STATES.stopped &&
				!status.recoveryFailure
				? begin()
				: status;
		},
		async start() {
			calls.push('start');
			return begin();
		},
		async restart() {
			calls.push('restart');
			publish({ state: RUNTIME_STATUS_STATES.stopping });
			publish({ state: RUNTIME_STATUS_STATES.stopped, startup: null });
			return begin();
		},
		async stop() {
			calls.push('stop');
			publish({ state: RUNTIME_STATUS_STATES.stopping });
			await new Promise<void>((resolve) => {
				finishStop = resolve;
			});
			return publish({
				state: RUNTIME_STATUS_STATES.stopped,
				startup: null,
				lastError: null,
				recoveryFailure: null
			});
		},
		async shutdown() {
			calls.push('shutdown');
		},
		async status() {
			return status;
		},
		async preflight() {
			return { ok: true, checks: [] };
		},
		async getConfigPath() {
			return 'fixture/config.env';
		},
		async getLogsPath() {
			return 'fixture/logs';
		},
		async listLogProcesses() {
			return ['desktop-supervisor'];
		},
		async openConfigPath() {
			calls.push('openConfig');
		},
		async openLogsPath() {
			calls.push('openLogs');
		},
		async openUserlandUi() {
			calls.push('openUserland');
		},
		async getLogsTail() {
			return [];
		},
		async onStatusChanged(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async onRuntimeLog() {
			return () => {};
		}
	};
	const configPort: AdminConfigPort = {
		async getConfig() {
			return config;
		},
		async saveConfig(input) {
			Object.assign(config, input);
			return config;
		},
		async useDefaults() {
			return config;
		},
		async benchmarkRpcEndpoints(input) {
			return {
				source: input.source,
				sourceDescription: 'Synthetic RPC',
				trackingPolicy: input.trackingPolicy,
				encodedEndpoints: config.values[RPC_ENDPOINT_LIST_ENV_KEY],
				endpoints: [],
				candidateCount: 1,
				eligibleCount: 1,
				benchmarkedCount: 1,
				successCount: 1,
				failureCount: 0,
				trackingCounts: { none: 1, limited: 0, yes: 0, unspecified: 0 }
			};
		}
	};
	const store = createDesktopRuntimeStore({
		runtimePort,
		desktopShellExpected: true,
		backendProbePort: {
			async probeReady(signal) {
				calls.push('probe');
				if (holdProbe)
					await new Promise<void>((resolve, reject) => {
						finishProbe = resolve;
						signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
					});
			}
		}
	});
	return {
		store,
		configPort,
		calls,
		status: () => status,
		services() {
			publish({
				startup: {
					phase: STARTUP_PHASES.services,
					task: null,
					startedAtMs: Date.now(),
					deadlineAtMs: Date.now() + 90_000
				}
			});
		},
		running(waitForProbe = false) {
			holdProbe = waitForProbe;
			publish({ state: RUNTIME_STATUS_STATES.running, startup: null });
		},
		cleanup() {
			publish({
				startup: {
					phase: STARTUP_PHASES.cleanup,
					task: RECOVERY_TASKS.natsMaintenance,
					startedAtMs: Date.now(),
					deadlineAtMs: Date.now() + 60_000
				}
			});
		},
		fail(reason: RecoveryFailure['reason']) {
			publish({
				state: RUNTIME_STATUS_STATES.stopped,
				startup: null,
				lastError: 'synthetic diagnostic for logs',
				recoveryFailure: { task: RECOVERY_TASKS.natsMaintenance, reason }
			});
		},
		finishStop() {
			finishStop?.();
		},
		finishProbe() {
			finishProbe?.();
		},
		lateRunning() {
			for (const listener of listeners)
				listener({
					...status,
					state: RUNTIME_STATUS_STATES.running,
					revision: status.revision - 1
				});
		}
	};
}

declare global {
	interface Window {
		runtimeRecoveryFixture: ReturnType<typeof createRuntimeRecoveryFixture>;
	}
}
