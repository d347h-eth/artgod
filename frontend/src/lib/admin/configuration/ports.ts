export type AdminConfigInputKind = 'text' | 'password' | 'checkbox' | 'textarea' | 'select';
export type AdminConfigValidationRule = 'url';

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

export interface AdminConfigPort {
	getConfig(): Promise<AdminConfigState>;
	saveConfig(input: AdminConfigSaveInput): Promise<AdminConfigState>;
	useDefaults(): Promise<AdminConfigState>;
}
