import type { AdminConfigField, AdminConfigState } from '$lib/admin/configuration/ports';
import { SETTINGS_KEY } from '@artgod/shared/config/generated-settings-defaults';
import { DESKTOP_ADMIN_CONFIG_SCHEMA } from '$lib/e2e/generated-desktop-admin-config';
import { LOCAL_DESKTOP_OBSERVABILITY_SCHEMA as localSchema } from '$lib/e2e/generated-local-desktop-observability';

export const LOCAL_DESKTOP_OBSERVABILITY_QUERY = 'local-desktop';

// Manifest-owned keys identify the two observability controls under browser test.
export const ADMIN_CONFIG_OBSERVABILITY_FIELD = {
	Enabled: SETTINGS_KEY.TRADING_METRICS_ENABLED,
	Port: SETTINGS_KEY.TRADING_METRICS_PORT_BIDDING_BOT
} as const;

// Stable selectors expose harness-only save results without changing the rendered product surface.
export const ADMIN_CONFIG_OBSERVABILITY_TEST_ID = {
	SavedConfig: 'observability-saved-config'
} as const;

function requireGeneratedObservabilityGroup() {
	const group = DESKTOP_ADMIN_CONFIG_SCHEMA.groups.find(
		(candidate) =>
			candidate.fields.some((field) => field.key === ADMIN_CONFIG_OBSERVABILITY_FIELD.Enabled) &&
			candidate.fields.some((field) => field.key === ADMIN_CONFIG_OBSERVABILITY_FIELD.Port)
	);
	if (!group) {
		throw new Error('Desktop Admin schema is missing the trading observability controls');
	}

	return group;
}

const generatedObservabilityGroup = requireGeneratedObservabilityGroup();

// Builds the disabled-by-default observability controls delivered by the native manifest.
export function createAdminConfigObservabilityFixture(localDesktop = false): AdminConfigState {
	const fields: AdminConfigField[] = generatedObservabilityGroup.fields.map((field) => ({
		...field,
		options: [...field.options]
	}));
	const generatedDefaults: Record<string, string> = DESKTOP_ADMIN_CONFIG_SCHEMA.defaults;
	const defaults = Object.fromEntries(
		fields.map((field) => [field.key, generatedDefaults[field.key] ?? ''])
	);

	const groups = [
		...(localDesktop
			? localSchema.groups.map((group) => ({
					...group,
					fields: group.fields.map((field) => ({ ...field, options: [...field.options] }))
				}))
			: []),
		{ id: generatedObservabilityGroup.id, label: generatedObservabilityGroup.label, fields }
	];
	const selectedDefaults = localDesktop ? { ...defaults, ...localSchema.defaults } : defaults;
	return {
		configured: true,
		envFilePath: 'app-config.env',
		envFileExists: true,
		settingsFilePath: 'settings.toml',
		settingsFileExists: true,
		autoLaunchOnStartup: false,
		values: { ...selectedDefaults },
		defaults: selectedDefaults,
		groups: groups as AdminConfigState['groups']
	};
}
