import type { AdminConfigField, AdminConfigState } from '$lib/admin/configuration/ports';

export const ADMIN_CONFIG_VALIDATION_RULES = {
	url: 'url',
	websocketUrl: 'websocket_url'
} as const;

export const ADMIN_CONFIG_VALIDATION_ISSUE_KINDS = {
	required: 'required',
	url: 'url'
} as const;

export type AdminConfigValidationIssueKind =
	(typeof ADMIN_CONFIG_VALIDATION_ISSUE_KINDS)[keyof typeof ADMIN_CONFIG_VALIDATION_ISSUE_KINDS];

export type AdminConfigValidationIssue = {
	key: string;
	label: string;
	kind: AdminConfigValidationIssueKind;
	message: string;
	requiredForLaunch: boolean;
};

const SUPPORTED_URL_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const SUPPORTED_WEBSOCKET_URL_PROTOCOLS = new Set(['ws:', 'wss:']);
const EXPLICIT_URL_SCHEME_PATTERN = /^(https?|wss?):\/\//;
const EXPLICIT_WEBSOCKET_URL_SCHEME_PATTERN = /^wss?:\/\//;

// Validates every manifest-backed setting against lightweight frontend rules.
export function resolveAdminConfigValidationIssues(
	config: AdminConfigState | null,
	values: Record<string, string>
): AdminConfigValidationIssue[] {
	if (!config) {
		return [];
	}
	return flattenConfigFields(config)
		.map((field) => validateAdminConfigField(field, values[field.key] ?? ''))
		.filter((issue): issue is AdminConfigValidationIssue => issue !== null);
}

// Returns launch-blocking configuration issues in manifest order.
export function resolveAdminLaunchConfigIssues(
	config: AdminConfigState | null,
	values: Record<string, string> | null = null
): AdminConfigValidationIssue[] {
	if (!config) {
		return [];
	}
	const effectiveValues = values ?? config.values;
	return flattenConfigFields(config)
		.filter((field) => field.requiredForLaunch)
		.map((field) => validateAdminConfigField(field, effectiveValues[field.key] ?? ''))
		.filter((issue): issue is AdminConfigValidationIssue => issue !== null);
}

export function formatLaunchConfigIssueSummary(
	issues: AdminConfigValidationIssue[]
): string | null {
	if (issues.length === 0) {
		return null;
	}
	const keys = issues.map((issue) => issue.key).join(', ');
	const hasInvalidValue = issues.some(
		(issue) => issue.kind !== ADMIN_CONFIG_VALIDATION_ISSUE_KINDS.required
	);
	return hasInvalidValue
		? `Required configuration is missing or invalid: ${keys}`
		: `Required configuration is missing: ${keys}`;
}

export function validateAdminConfigField(
	field: AdminConfigField,
	value: string
): AdminConfigValidationIssue | null {
	const trimmed = value.trim();
	if (field.requiredForLaunch && trimmed.length === 0) {
		return buildValidationIssue(
			field,
			ADMIN_CONFIG_VALIDATION_ISSUE_KINDS.required,
			`${field.key} is required for app launch.`
		);
	}
	if (trimmed.length === 0) {
		return null;
	}
	if (field.validation === ADMIN_CONFIG_VALIDATION_RULES.url && !isSupportedUrl(trimmed)) {
		return buildValidationIssue(
			field,
			ADMIN_CONFIG_VALIDATION_ISSUE_KINDS.url,
			`${field.key} must be a valid URL.`
		);
	}
	if (
		field.validation === ADMIN_CONFIG_VALIDATION_RULES.websocketUrl &&
		!isSupportedWebSocketUrl(trimmed)
	) {
		return buildValidationIssue(
			field,
			ADMIN_CONFIG_VALIDATION_ISSUE_KINDS.url,
			`${field.key} must be a valid WebSocket URL.`
		);
	}
	return null;
}

function flattenConfigFields(config: AdminConfigState): AdminConfigField[] {
	return config.groups.flatMap((group) => group.fields);
}

function buildValidationIssue(
	field: AdminConfigField,
	kind: AdminConfigValidationIssueKind,
	message: string
): AdminConfigValidationIssue {
	return {
		key: field.key,
		label: field.label,
		kind,
		message,
		requiredForLaunch: field.requiredForLaunch
	};
}

function isSupportedUrl(value: string): boolean {
	if (!EXPLICIT_URL_SCHEME_PATTERN.test(value)) {
		return false;
	}
	try {
		const url = new URL(value);
		return SUPPORTED_URL_PROTOCOLS.has(url.protocol) && url.hostname.trim().length > 0;
	} catch {
		return false;
	}
}

function isSupportedWebSocketUrl(value: string): boolean {
	if (!EXPLICIT_WEBSOCKET_URL_SCHEME_PATTERN.test(value)) {
		return false;
	}
	try {
		const url = new URL(value);
		return SUPPORTED_WEBSOCKET_URL_PROTOCOLS.has(url.protocol) && url.hostname.trim().length > 0;
	} catch {
		return false;
	}
}
