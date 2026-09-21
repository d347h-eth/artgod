// Frontend-owned constants for the runtime status values sent by the Tauri supervisor.
export const RUNTIME_STATUS_STATES = {
	starting: 'starting',
	restarting: 'restarting',
	stopping: 'stopping',
	running: 'running',
	stopped: 'stopped'
} as const;

// Mirrors runtime/recovery.rs at the desktop bridge boundary.
export const STARTUP_PHASES = {
	preparing: 'preparing',
	recovery: 'recovery',
	services: 'services',
	cleanup: 'cleanup',
	backoff: 'backoff'
} as const;
export const RECOVERY_TASKS = {
	natsMaintenance: 'natsMaintenance',
	sqliteMaintenance: 'sqliteMaintenance',
	sqliteCompaction: 'sqliteCompaction'
} as const;
export const RECOVERY_FAILURE_REASONS = { failed: 'failed', timedOut: 'timedOut' } as const;
export type StartupActivity = {
	phase: (typeof STARTUP_PHASES)[keyof typeof STARTUP_PHASES];
	task: (typeof RECOVERY_TASKS)[keyof typeof RECOVERY_TASKS] | null;
	startedAtMs: number;
	deadlineAtMs: number;
};
export type RecoveryFailure = {
	task: NonNullable<StartupActivity['task']>;
	reason: (typeof RECOVERY_FAILURE_REASONS)[keyof typeof RECOVERY_FAILURE_REASONS];
};

export type RuntimeStatus = {
	operationId: number;
	revision: number;
	startup: StartupActivity | null;
	recoveryFailure: RecoveryFailure | null;
	state: string;
	restartCount: number;
	lastError: string | null;
	runningProcesses: string[];
	backendHttpBaseUrl: string;
	natsUrl: string;
	configPath: string;
};

export type RuntimePreflightCheck = {
	key: string;
	status: 'pass' | 'warn' | 'fail';
	message: string;
};

export type RuntimePreflight = {
	ok: boolean;
	checks: RuntimePreflightCheck[];
};

export type RuntimeLogEntry = {
	process: string;
	line: string;
};

export type RuntimeStatusListener = (status: RuntimeStatus) => void;
export type RuntimeLogListener = (entry: RuntimeLogEntry) => void;

export interface RuntimePort {
	loadBridge(maxWaitMs: number, pollIntervalMs: number): Promise<boolean>;
	isBridgeAvailable(): boolean;
	autoStart(): Promise<RuntimeStatus>;
	start(): Promise<RuntimeStatus>;
	stop(): Promise<RuntimeStatus>;
	restart(): Promise<RuntimeStatus>;
	shutdown(): Promise<void>;
	status(): Promise<RuntimeStatus | null>;
	preflight(): Promise<RuntimePreflight | null>;
	getConfigPath(): Promise<string | null>;
	getLogsPath(): Promise<string | null>;
	listLogProcesses(): Promise<string[]>;
	openConfigPath(): Promise<void>;
	openLogsPath(): Promise<void>;
	openUserlandUi(): Promise<void>;
	getLogsTail(process: string, limitPerProcess: number): Promise<RuntimeLogEntry[]>;
	onStatusChanged(listener: RuntimeStatusListener): Promise<() => void>;
	onRuntimeLog(listener: RuntimeLogListener): Promise<() => void>;
}

export interface BackendProbePort {
	probeReady(signal?: AbortSignal): Promise<void>;
}

export interface ClockPort {
	now(): number;
	sleep(ms: number): Promise<void>;
}

// Runtime store action ids shown in Admin status messages while a command is active.
export const RUNTIME_BUSY_ACTIONS = {
	start: 'start',
	autoStart: 'autoStart',
	stop: 'stop',
	restart: 'restart',
	shutdown: 'shutdown',
	preflight: 'preflight',
	openConfig: 'openConfig',
	openLogs: 'openLogs',
	openUserlandUi: 'openUserlandUi'
} as const;
