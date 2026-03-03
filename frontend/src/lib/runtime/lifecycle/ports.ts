export type RuntimeStatus = {
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
	probeReady(): Promise<void>;
}

export interface ClockPort {
	now(): number;
	sleep(ms: number): Promise<void>;
}
