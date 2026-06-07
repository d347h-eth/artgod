export type AdminConfigInputKind =
	| 'text'
	| 'password'
	| 'checkbox'
	| 'textarea'
	| 'select'
	| 'weighted_endpoint_list';
export type AdminConfigValidationRule =
	| 'url'
	| 'positive_integer'
	| 'rpc_endpoint_list'
	| 'websocket_endpoint_list';

export type AdminConfigField = {
	key: string;
	label: string;
	inputKind: AdminConfigInputKind;
	secret: boolean;
	options: string[];
	help: string;
	requiredForLaunch: boolean;
	validation: AdminConfigValidationRule | null;
	view?: 'basic' | 'advanced';
};

export type AdminConfigGroup = {
	id: string;
	label: string;
	fields: AdminConfigField[];
};

export type AdminConfigState = {
	configured: boolean;
	envFilePath: string;
	envFileExists: boolean;
	settingsFilePath: string;
	settingsFileExists: boolean;
	autoLaunchOnStartup: boolean;
	values: Record<string, string>;
	defaults: Record<string, string>;
	groups: AdminConfigGroup[];
};

export type AdminConfigSaveInput = {
	values: Record<string, string>;
	autoLaunchOnStartup: boolean;
};

export type AdminRpcEndpointBenchmarkInput = {
	source: string;
	trackingPolicy: string;
	rpcUrlList?: string;
};

export type AdminRpcEndpointTrackingCounts = {
	none: number;
	limited: number;
	yes: number;
	unspecified: number;
};

export type AdminRpcEndpointBenchmarkEndpoint = {
	url: string;
	weight: number;
	latencyMs: number;
	blockNumber: number;
};

export type AdminRpcEndpointBenchmarkResult = {
	source: string;
	sourceDescription: string;
	trackingPolicy: string;
	encodedEndpoints: string;
	endpoints: AdminRpcEndpointBenchmarkEndpoint[];
	candidateCount: number;
	eligibleCount: number;
	benchmarkedCount: number;
	successCount: number;
	failureCount: number;
	trackingCounts: AdminRpcEndpointTrackingCounts;
};

export interface AdminConfigPort {
	getConfig(): Promise<AdminConfigState>;
	saveConfig(input: AdminConfigSaveInput): Promise<AdminConfigState>;
	useDefaults(): Promise<AdminConfigState>;
	benchmarkRpcEndpoints(
		input: AdminRpcEndpointBenchmarkInput
	): Promise<AdminRpcEndpointBenchmarkResult>;
}
