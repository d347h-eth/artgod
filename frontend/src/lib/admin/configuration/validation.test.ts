import { describe, expect, it } from 'vitest';
import {
	RPC_ENDPOINT_LIST_ENV_KEY,
	RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY
} from '@artgod/shared/config/rpc-endpoints';
import {
	TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER,
	TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY
} from '@artgod/shared/config/transaction-explorer';

import {
	formatLaunchConfigIssueSummary,
	resolveAdminConfigValidationIssues,
	resolveAdminLaunchConfigIssues
} from './validation';
import type { AdminConfigField, AdminConfigState } from './ports';

const RPC_URL_FIELD: AdminConfigField = {
	key: RPC_ENDPOINT_LIST_ENV_KEY,
	label: 'rpc endpoints',
	inputKind: 'weighted_endpoint_list',
	secret: false,
	options: [],
	help: '',
	requiredForLaunch: true,
	validation: 'rpc_endpoint_list',
	view: 'basic'
};

const RPC_WS_URL_FIELD: AdminConfigField = {
	key: RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY,
	label: 'rpc ws endpoints',
	inputKind: 'weighted_endpoint_list',
	secret: false,
	options: [],
	help: '',
	requiredForLaunch: false,
	validation: 'websocket_endpoint_list',
	view: 'basic'
};

const DESKTOP_LOG_RETENTION_HOURS_FIELD: AdminConfigField = {
	key: 'DESKTOP_LOG_RETENTION_HOURS',
	label: 'desktop log retention hours',
	inputKind: 'text',
	secret: false,
	options: [],
	help: '',
	requiredForLaunch: false,
	validation: 'positive_integer',
	view: 'basic'
};

const TRANSACTION_EXPLORER_FIELD: AdminConfigField = {
	key: TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY,
	label: 'preferred transaction explorer',
	inputKind: 'text',
	secret: false,
	options: [],
	help: '',
	requiredForLaunch: false,
	validation: 'url',
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
		const issues = resolveAdminLaunchConfigIssues(config({ [RPC_ENDPOINT_LIST_ENV_KEY]: '' }));

		expect(issues.map((issue) => issue.key)).toEqual([RPC_ENDPOINT_LIST_ENV_KEY]);
		expect(formatLaunchConfigIssueSummary(issues)).toBe(
			`Required configuration is missing: ${RPC_ENDPOINT_LIST_ENV_KEY}`
		);
	});

	it('reports invalid launch-required URLs', () => {
		const issues = resolveAdminConfigValidationIssues(
			config({ [RPC_ENDPOINT_LIST_ENV_KEY]: 'not a url' }),
			{
				[RPC_ENDPOINT_LIST_ENV_KEY]: 'not a url'
			}
		);

		expect(issues.map((issue) => issue.kind)).toEqual(['url']);
		expect(formatLaunchConfigIssueSummary(issues)).toBe(
			`Required configuration is missing or invalid: ${RPC_ENDPOINT_LIST_ENV_KEY}`
		);
	});

	it('accepts supported RPC endpoint config values', () => {
		expect(
			resolveAdminLaunchConfigIssues(
				config({
					[RPC_ENDPOINT_LIST_ENV_KEY]:
						'[{"url":"https://rpc-a.example","weight":2},{"url":"https://rpc-b.example","weight":1}]'
				})
			)
		).toEqual([]);
	});

	it('rejects plain URL RPC endpoint values', () => {
		const issues = resolveAdminLaunchConfigIssues(
			config({ [RPC_ENDPOINT_LIST_ENV_KEY]: 'https://rpc.example' })
		);

		expect(issues.map((issue) => issue.kind)).toEqual(['url']);
		expect(issues.map((issue) => issue.message)).toEqual([
			`Invalid ${RPC_ENDPOINT_LIST_ENV_KEY}: endpoint list must be a JSON array`
		]);
	});

	it('rejects websocket RPC endpoints for the HTTP JSON-RPC pool', () => {
		const issues = resolveAdminLaunchConfigIssues(
			config({ [RPC_ENDPOINT_LIST_ENV_KEY]: '[{"url":"wss://rpc.example","weight":1}]' })
		);

		expect(issues.map((issue) => issue.kind)).toEqual(['url']);
	});

	it('rejects URLs without an explicit scheme separator', () => {
		const issues = resolveAdminLaunchConfigIssues(
			config({ [RPC_ENDPOINT_LIST_ENV_KEY]: '[{"url":"https:localhost:8545","weight":1}]' })
		);

		expect(issues.map((issue) => issue.kind)).toEqual(['url']);
	});

	it('accepts supported websocket endpoint config values', () => {
		expect(
			resolveAdminConfigValidationIssues(
				config(
					{
						[RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY]:
							'[{"url":"wss://ws-a.example","weight":2},{"url":"ws://127.0.0.1:8546"}]'
					},
					[RPC_WS_URL_FIELD]
				),
				{
					[RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY]:
						'[{"url":"wss://ws-a.example","weight":2},{"url":"ws://127.0.0.1:8546"}]'
				}
			)
		).toEqual([]);
	});

	it('rejects plain websocket URL endpoint values', () => {
		const issues = resolveAdminConfigValidationIssues(
			config({ [RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY]: 'wss://ws.example' }, [RPC_WS_URL_FIELD]),
			{
				[RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY]: 'wss://ws.example'
			}
		);

		expect(issues.map((issue) => issue.kind)).toEqual(['url']);
		expect(issues.map((issue) => issue.message)).toEqual([
			`Invalid ${RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY}: endpoint list must be a JSON array`
		]);
	});

	it('rejects non-websocket schemes for websocket endpoint pools', () => {
		const issues = resolveAdminConfigValidationIssues(
			config(
				{ [RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY]: '[{"url":"https://rpc.example","weight":1}]' },
				[RPC_WS_URL_FIELD]
			),
			{
				[RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY]: '[{"url":"https://rpc.example","weight":1}]'
			}
		);

		expect(issues.map((issue) => issue.kind)).toEqual(['url']);
		expect(issues.map((issue) => issue.message)).toEqual([
			`Invalid ${RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY}: endpoint 1 URL is invalid`
		]);
	});

	it('validates positive integer fields', () => {
		expect(
			resolveAdminConfigValidationIssues(
				config({ DESKTOP_LOG_RETENTION_HOURS: '48' }, [DESKTOP_LOG_RETENTION_HOURS_FIELD]),
				{
					DESKTOP_LOG_RETENTION_HOURS: '48'
				}
			)
		).toEqual([]);

		const issues = resolveAdminConfigValidationIssues(
			config({ DESKTOP_LOG_RETENTION_HOURS: '0' }, [DESKTOP_LOG_RETENTION_HOURS_FIELD]),
			{
				DESKTOP_LOG_RETENTION_HOURS: '0'
			}
		);

		expect(issues.map((issue) => issue.kind)).toEqual(['integer']);
		expect(issues.map((issue) => issue.message)).toEqual([
			'DESKTOP_LOG_RETENTION_HOURS must be a positive whole number.'
		]);
	});

	it('requires a transaction hash placeholder in transaction explorer templates', () => {
		const issues = resolveAdminConfigValidationIssues(
			config({ [TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY]: 'https://explorer.example/tx/' }, [
				TRANSACTION_EXPLORER_FIELD
			]),
			{
				[TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY]: 'https://explorer.example/tx/'
			}
		);

		expect(issues.map((issue) => issue.kind)).toEqual(['url']);
		expect(issues.map((issue) => issue.message)).toEqual([
			`${TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY} must include ${TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER}.`
		]);
	});

	it('accepts transaction explorer templates with a transaction hash placeholder', () => {
		expect(
			resolveAdminConfigValidationIssues(
				config(
					{
						[TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY]: `https://explorer.example/tx/${TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER}`
					},
					[TRANSACTION_EXPLORER_FIELD]
				),
				{
					[TRANSACTION_EXPLORER_URL_TEMPLATE_ENV_KEY]: `https://explorer.example/tx/${TRANSACTION_EXPLORER_TX_HASH_PLACEHOLDER}`
				}
			)
		).toEqual([]);
	});
});
