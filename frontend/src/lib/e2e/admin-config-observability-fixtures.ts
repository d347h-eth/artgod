import type { AdminConfigState } from '$lib/admin/configuration/ports';
import { SETTINGS_KEY } from '@artgod/shared/config/generated-settings-defaults';
import { DESKTOP_ADMIN_CONFIG_SCHEMA } from '$lib/e2e/generated-desktop-admin-config';
import { LOCAL_DESKTOP_OBSERVABILITY_SCHEMA as localSchema } from '$lib/e2e/generated-local-desktop-observability';

export const LOCAL_DESKTOP_OBSERVABILITY_QUERY = 'local-desktop';
export const ADMIN_CONFIG_RPC_QUERY = 'rpc-settings';

// Manifest-owned keys identify the two observability controls under browser test.
export const ADMIN_CONFIG_OBSERVABILITY_FIELD = {
	Enabled: SETTINGS_KEY.TRADING_METRICS_ENABLED,
	Port: SETTINGS_KEY.TRADING_METRICS_PORT_BIDDING_BOT
} as const;

// Stable selectors expose harness-only save results without changing the rendered product surface.
export const ADMIN_CONFIG_OBSERVABILITY_TEST_ID = {
	SavedConfig: 'observability-saved-config'
} as const;

function requireGeneratedConfigGroup(keys: readonly string[]) {
	const group = DESKTOP_ADMIN_CONFIG_SCHEMA.groups.find((candidate) =>
		keys.every((key) => candidate.fields.some((field) => field.key === key))
	);
	if (!group) {
		throw new Error(`Desktop Admin schema is missing the controls: ${keys.join(', ')}`);
	}

	return group;
}

const generatedObservabilityGroup = requireGeneratedConfigGroup(
	Object.values(ADMIN_CONFIG_OBSERVABILITY_FIELD)
);
const generatedRpcGroup = requireGeneratedConfigGroup([
	SETTINGS_KEY.RPC_HTTP_MAX_RESPONSE_BODY_SIZE_BYTES
]);
const generatedIndexerGroup = requireGeneratedConfigGroup([SETTINGS_KEY.GAP_FILL_MODE]);

// Uses the native manifest's groups for observability and optional RPC settings journeys.
export function createAdminConfigObservabilityFixture(
	localDesktop = false,
	rpcSettings = false
): AdminConfigState {
	const groups = [
		...(localDesktop ? localSchema.groups : []),
		...(rpcSettings ? [generatedRpcGroup, generatedIndexerGroup] : []),
		generatedObservabilityGroup
	].map((group) => ({
		...group,
		fields: group.fields.map((field) => ({ ...field, options: [...field.options] }))
	}));
	const generatedDefaults: Record<string, string> = DESKTOP_ADMIN_CONFIG_SCHEMA.defaults;
	const defaults = Object.fromEntries(
		groups.flatMap((group) =>
			group.fields.map((field) => [field.key, generatedDefaults[field.key] ?? ''])
		)
	);
	const selectedDefaults = localDesktop ? { ...defaults, ...localSchema.defaults } : defaults;
	const values = { ...selectedDefaults };
	if (rpcSettings) {
		values[SETTINGS_KEY.RPC_URL_LIST] = JSON.stringify([{ url: 'https://rpc.example', weight: 1 }]);
	}
	return {
		configured: true,
		envFilePath: 'app-config.env',
		envFileExists: true,
		settingsFilePath: 'settings.toml',
		settingsFileExists: true,
		autoLaunchOnStartup: false,
		values,
		defaults: selectedDefaults,
		groups: groups as AdminConfigState['groups']
	};
}
