import { describe, expect, it } from 'vitest';

import {
	formatLaunchConfigIssueSummary,
	resolveAdminConfigValidationIssues,
	resolveAdminLaunchConfigIssues
} from './validation';
import type { AdminConfigField, AdminConfigState } from './ports';

const RPC_URL_FIELD: AdminConfigField = {
	key: 'RPC_URL',
	label: 'rpc url',
	inputKind: 'text',
	secret: false,
	options: [],
	help: '',
	requiredForLaunch: true,
	validation: 'url',
	view: 'basic'
};

const RPC_WS_URL_FIELD: AdminConfigField = {
	key: 'RPC_WS_URL',
	label: 'rpc ws url',
	inputKind: 'text',
	secret: false,
	options: [],
	help: '',
	requiredForLaunch: false,
	validation: 'websocket_url',
	view: 'basic'
};

function config(
	values: Record<string, string>,
	fields: AdminConfigField[] = [RPC_URL_FIELD]
): AdminConfigState {
	return {
		configured: false,
		envFilePath: '/tmp/.env',
		envFileExists: false,
		settingsFilePath: '/tmp/settings.json',
		settingsFileExists: false,
		autoLaunchOnStartup: false,
		values,
		defaults: {},
		groups: [
			{
				id: 'chain-rpc',
				label: 'chain rpc',
				fields
			}
		]
	};
}

describe('admin config validation', () => {
	it('reports missing launch-required values', () => {
		const issues = resolveAdminLaunchConfigIssues(config({ RPC_URL: '' }));

		expect(issues.map((issue) => issue.key)).toEqual(['RPC_URL']);
		expect(formatLaunchConfigIssueSummary(issues)).toBe(
			'Required configuration is missing: RPC_URL'
		);
	});

	it('reports invalid launch-required URLs', () => {
		const issues = resolveAdminConfigValidationIssues(config({ RPC_URL: 'not a url' }), {
			RPC_URL: 'not a url'
		});

		expect(issues.map((issue) => issue.kind)).toEqual(['url']);
		expect(formatLaunchConfigIssueSummary(issues)).toBe(
			'Required configuration is missing or invalid: RPC_URL'
		);
	});

	it('accepts supported RPC URL schemes', () => {
		expect(resolveAdminLaunchConfigIssues(config({ RPC_URL: 'https://rpc.example' }))).toEqual([]);
		expect(resolveAdminLaunchConfigIssues(config({ RPC_URL: 'http://127.0.0.1:8545' }))).toEqual(
			[]
		);
		expect(resolveAdminLaunchConfigIssues(config({ RPC_URL: 'wss://rpc.example' }))).toEqual([]);
	});

	it('rejects URLs without an explicit scheme separator', () => {
		const issues = resolveAdminLaunchConfigIssues(config({ RPC_URL: 'https:localhost:8545' }));

		expect(issues.map((issue) => issue.kind)).toEqual(['url']);
	});

	it('accepts supported websocket URL schemes for websocket-only fields', () => {
		expect(
			resolveAdminConfigValidationIssues(
				config({ RPC_WS_URL: 'wss://rpc.example' }, [RPC_WS_URL_FIELD]),
				{
					RPC_WS_URL: 'wss://rpc.example'
				}
			)
		).toEqual([]);
		expect(
			resolveAdminConfigValidationIssues(
				config({ RPC_WS_URL: 'ws://127.0.0.1:8546' }, [RPC_WS_URL_FIELD]),
				{
					RPC_WS_URL: 'ws://127.0.0.1:8546'
				}
			)
		).toEqual([]);
	});

	it('rejects non-websocket schemes for websocket-only fields', () => {
		const issues = resolveAdminConfigValidationIssues(
			config({ RPC_WS_URL: 'https://rpc.example' }, [RPC_WS_URL_FIELD]),
			{
				RPC_WS_URL: 'https://rpc.example'
			}
		);

		expect(issues.map((issue) => issue.kind)).toEqual(['url']);
		expect(issues.map((issue) => issue.message)).toEqual([
			'RPC_WS_URL must be a valid WebSocket URL.'
		]);
	});
});
