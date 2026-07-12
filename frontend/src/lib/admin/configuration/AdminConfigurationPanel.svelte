<script lang="ts">
	import AdminSectionFrame from '$lib/admin/components/AdminSectionFrame.svelte';
	import RpcEndpointListInput from '$lib/admin/configuration/RpcEndpointListInput.svelte';
	import InfoTooltip from '$lib/components/InfoTooltip.svelte';
	import type {
		AdminConfigField,
		AdminConfigGroup,
		AdminRpcEndpointBenchmarkInput,
		AdminRpcEndpointBenchmarkResult,
		AdminConfigSaveInput,
		AdminConfigState
	} from '$lib/admin/configuration/ports';
	import {
		resolveAdminConfigValidationIssues,
		type AdminConfigValidationIssue
	} from '$lib/admin/configuration/validation';
	import {
		RPC_AUTO_SOURCING_TRACKING_POLICY_ENV_KEY,
		RPC_ENDPOINT_BENCHMARK_SOURCES,
		normalizeRpcAutoSourcingTrackingPolicy
	} from '@artgod/shared/config/rpc-auto-sourcing';
	import { RPC_ENDPOINT_LIST_ENV_KEY } from '@artgod/shared/config/rpc-endpoints';

	type AdminConfigView = 'basic' | 'advanced';

	let {
		config,
		loading,
		busyAction = null,
		errorMessage = null,
		infraRunning = false,
		onSave,
		onBenchmarkRpcEndpoints,
		onClose
	}: {
		config: AdminConfigState | null;
		loading: boolean;
		busyAction?: string | null;
		errorMessage?: string | null;
		infraRunning?: boolean;
		onSave: (input: AdminConfigSaveInput) => Promise<void>;
		onBenchmarkRpcEndpoints: (
			input: AdminRpcEndpointBenchmarkInput
		) => Promise<AdminRpcEndpointBenchmarkResult>;
		onClose: () => void;
	} = $props();

	let appliedConfig = $state<AdminConfigState | null>(null);
	let values = $state<Record<string, string>>({});
	let autoLaunchOnStartup = $state(false);
	let configView = $state<AdminConfigView>('basic');
	let rpcCurrentBenchmarkSummary = $state<string | null>(null);
	let rpcSourcingSummary = $state<string | null>(null);

	const editableGroups = $derived(resolveEditableGroups(config?.groups ?? [], configView));
	const formDisabled = $derived(loading || busyAction !== null || config === null);
	const validationIssues = $derived(resolveAdminConfigValidationIssues(config, values));
	const saveDisabled = $derived(formDisabled || validationIssues.length > 0);

	$effect(() => {
		if (!config || config === appliedConfig) {
			return;
		}
		applyConfigState(config);
	});

	function applyConfigState(next: AdminConfigState): void {
		appliedConfig = next;
		values = { ...next.values };
		autoLaunchOnStartup = next.autoLaunchOnStartup;
		clearRpcBenchmarkSummaries();
	}

	function setValue(key: string, value: string): void {
		values = {
			...values,
			[key]: value
		};
	}

	function resetDraftToDefaults(): void {
		if (!config) {
			return;
		}
		values = { ...config.defaults };
		autoLaunchOnStartup = false;
		clearRpcBenchmarkSummaries();
	}

	async function saveConfig(): Promise<void> {
		if (saveDisabled) {
			return;
		}
		await onSave({
			values,
			autoLaunchOnStartup
		});
	}

	function fieldValue(field: AdminConfigField): string {
		return values[field.key] ?? '';
	}

	function fieldChecked(field: AdminConfigField): boolean {
		return ['1', 'true', 'yes', 'on'].includes(fieldValue(field).trim().toLowerCase());
	}

	function fieldValidationIssue(field: AdminConfigField): AdminConfigValidationIssue | null {
		return validationIssues.find((issue) => issue.key === field.key) ?? null;
	}

	async function benchmarkCurrentRpcEndpoints(field: AdminConfigField): Promise<void> {
		// Benchmark the unsaved endpoint draft currently shown in the config inputs.
		const result = await benchmarkRpcEndpoints({
			source: RPC_ENDPOINT_BENCHMARK_SOURCES.configuredEndpoints,
			trackingPolicy: resolveRpcAutoSourcingTrackingPolicy(),
			rpcUrlList: fieldValue(field)
		});
		if (!result) {
			return;
		}
		setValue(RPC_ENDPOINT_LIST_ENV_KEY, result.encodedEndpoints);
		rpcCurrentBenchmarkSummary = formatRpcBenchmarkSummary(result);
	}

	async function benchmarkRpcEndpointSource(source: string): Promise<void> {
		// Source a replacement endpoint list from the configured Chainlist source.
		const result = await benchmarkRpcEndpoints({
			source,
			trackingPolicy: resolveRpcAutoSourcingTrackingPolicy()
		});
		if (!result) {
			return;
		}
		setValue(RPC_ENDPOINT_LIST_ENV_KEY, result.encodedEndpoints);
		rpcSourcingSummary = formatRpcBenchmarkSummary(result);
	}

	async function benchmarkRpcEndpoints(
		input: AdminRpcEndpointBenchmarkInput
	): Promise<AdminRpcEndpointBenchmarkResult | null> {
		if (formDisabled) {
			return null;
		}
		clearRpcBenchmarkSummaries();
		let result: AdminRpcEndpointBenchmarkResult;
		try {
			result = await onBenchmarkRpcEndpoints(input);
		} catch {
			return null;
		}
		return result;
	}

	function resolveRpcAutoSourcingTrackingPolicy(): string {
		return normalizeRpcAutoSourcingTrackingPolicy(
			values[RPC_AUTO_SOURCING_TRACKING_POLICY_ENV_KEY]?.trim()
		);
	}

	function formatRpcBenchmarkSummary(result: AdminRpcEndpointBenchmarkResult): string {
		if (result.source === RPC_ENDPOINT_BENCHMARK_SOURCES.configuredEndpoints) {
			return `${result.sourceDescription}: ${result.successCount}/${result.eligibleCount} endpoints passed`;
		}
		const trackedCount = result.trackingCounts.yes + result.trackingCounts.unspecified;
		return `${result.sourceDescription}: ${result.successCount}/${result.eligibleCount} endpoints passed, tracking none ${result.trackingCounts.none}, limited ${result.trackingCounts.limited}, tracked ${trackedCount}`;
	}

	function clearRpcBenchmarkSummaries(): void {
		rpcCurrentBenchmarkSummary = null;
		rpcSourcingSummary = null;
	}

	function resolveEditableGroups(groups: AdminConfigGroup[], view: AdminConfigView): AdminConfigGroup[] {
		return groups
			.map((group) => ({
				...group,
				fields:
					view === 'advanced'
						? group.fields
						: group.fields.filter((field) => field.view === 'basic')
			}))
			.filter((group) => group.fields.length > 0);
	}

	function fieldSupportsRpcAutoSourcing(field: AdminConfigField): boolean {
		return field.key === RPC_ENDPOINT_LIST_ENV_KEY;
	}
</script>

<AdminSectionFrame>
	<div class="admin-config-body">
		<div class="admin-config-inlay">
			{#if loading}
				<section class="runtime-section">
					<p class="muted">loading configuration</p>
				</section>
			{:else if config}
				<form
					class="admin-config-form"
					onsubmit={(event) => {
						event.preventDefault();
						void saveConfig();
					}}
				>
					<div class="admin-config-view-row">
						<span class="panel-top-actions-label">view:</span>
						<div class="secondary-tabs" aria-label="Config view">
							<button
								type="button"
								class:secondary-tab-active={configView === 'basic'}
								disabled={formDisabled || configView === 'basic'}
								onclick={() => {
									configView = 'basic';
								}}
							>
								basic
							</button>
							<button
								type="button"
								class:secondary-tab-active={configView === 'advanced'}
								disabled={formDisabled || configView === 'advanced'}
								onclick={() => {
									configView = 'advanced';
								}}
							>
								advanced
							</button>
						</div>
					</div>

					<section class="runtime-section admin-config-group">
						<h3>Desktop</h3>
						<label class="admin-setting-row admin-config-checkbox-row">
							<span class="admin-setting-label-cell">autostart infra</span>
							<input
								type="checkbox"
								class="bootstrap-checkbox"
								checked={autoLaunchOnStartup}
								disabled={formDisabled}
								onchange={(event) => {
									autoLaunchOnStartup = (event.currentTarget as HTMLInputElement).checked;
								}}
							/>
						</label>
					</section>

					{#each editableGroups as group (group.id)}
						<section class="runtime-section admin-config-group">
							<h3>{group.label}</h3>
							{#each group.fields as field (field.key)}
								{@const validationIssue = fieldValidationIssue(field)}
								{#if field.inputKind === 'weighted_endpoint_list'}
									<div
										class="admin-setting-row admin-config-textarea-row"
										class:admin-config-row-warning={validationIssue !== null}
									>
										<span class="admin-setting-label-cell">
											<span>{field.label}</span>
											{#if validationIssue}
												<InfoTooltip
													text={validationIssue.message}
													tone="warning"
													className="admin-setting-label-tooltip"
												/>
											{/if}
											<InfoTooltip text={field.help} className="admin-setting-label-tooltip" />
										</span>
										<RpcEndpointListInput
											value={fieldValue(field)}
											disabled={formDisabled}
											invalid={validationIssue !== null}
											validation={field.validation}
											endpointLabel={field.validation === 'websocket_endpoint_list'
												? 'WebSocket endpoint'
												: 'RPC endpoint'}
											currentBenchmarkSummary={fieldSupportsRpcAutoSourcing(field)
												? rpcCurrentBenchmarkSummary
												: null}
											onBenchmarkCurrentEndpoints={fieldSupportsRpcAutoSourcing(field)
												? async () => {
														await benchmarkCurrentRpcEndpoints(field);
													}
												: undefined}
											onChange={(value) => {
												setValue(field.key, value);
											}}
										/>
									</div>
									{#if fieldSupportsRpcAutoSourcing(field)}
										<div class="admin-setting-row admin-config-sourcing-row">
											<span class="admin-setting-label-cell">RPC endpoints sourcing</span>
											<div class="admin-config-sourcing-cell">
												<div class="admin-config-sourcing-actions">
													<button
														type="button"
														disabled={formDisabled}
														onclick={() =>
															void benchmarkRpcEndpointSource(RPC_ENDPOINT_BENCHMARK_SOURCES.savedChainlist)}
													>
														benchmark embedded list
													</button>
													<button
														type="button"
														disabled={formDisabled}
														onclick={() =>
															void benchmarkRpcEndpointSource(RPC_ENDPOINT_BENCHMARK_SOURCES.freshChainlist)}
													>
														fetch fresh list from chainlist.org & benchmark
													</button>
												</div>
												{#if rpcSourcingSummary}
													<p class="admin-config-benchmark-summary">{rpcSourcingSummary}</p>
												{/if}
											</div>
										</div>
									{/if}
								{:else}
									<label
										class="admin-setting-row"
										class:admin-config-textarea-row={field.inputKind === 'textarea'}
										class:admin-config-row-warning={validationIssue !== null}
									>
										<span class="admin-setting-label-cell">
											<span>{field.label}</span>
											{#if validationIssue}
												<InfoTooltip
													text={validationIssue.message}
													tone="warning"
													className="admin-setting-label-tooltip"
												/>
											{/if}
											<InfoTooltip text={field.help} className="admin-setting-label-tooltip" />
										</span>
										{#if field.inputKind === 'checkbox'}
											<input
												type="checkbox"
												class="bootstrap-checkbox"
												checked={fieldChecked(field)}
												disabled={formDisabled}
												onchange={(event) => {
													setValue(field.key, (event.currentTarget as HTMLInputElement).checked ? 'true' : 'false');
												}}
											/>
										{:else if field.inputKind === 'select'}
											<select
												class="bootstrap-control-select admin-config-control"
												class:admin-config-control-warning={validationIssue !== null}
												value={fieldValue(field)}
												disabled={formDisabled}
												aria-invalid={validationIssue !== null}
												onchange={(event) => {
													setValue(field.key, (event.currentTarget as HTMLSelectElement).value);
												}}
											>
												{#each field.options as option}
													<option value={option}>{option}</option>
												{/each}
											</select>
										{:else if field.inputKind === 'textarea'}
											<textarea
												class="bootstrap-control-textarea admin-config-control admin-config-textarea"
												class:admin-config-control-warning={validationIssue !== null}
												value={fieldValue(field)}
												disabled={formDisabled}
												aria-invalid={validationIssue !== null}
												oninput={(event) => {
													setValue(field.key, (event.currentTarget as HTMLTextAreaElement).value);
												}}
											></textarea>
										{:else}
											<input
												class="bootstrap-control admin-config-control"
												class:admin-config-control-warning={validationIssue !== null}
												type={field.inputKind === 'password' ? 'password' : 'text'}
												value={fieldValue(field)}
												disabled={formDisabled}
												aria-invalid={validationIssue !== null}
												oninput={(event) => {
													setValue(field.key, (event.currentTarget as HTMLInputElement).value);
												}}
											/>
										{/if}
									</label>
								{/if}
							{/each}
						</section>
					{/each}

					<section class="runtime-section">
						<div class="admin-config-actions">
							<div class="admin-config-action-group">
								<button
									type="button"
									class="action-button-negative"
									onclick={onClose}
									disabled={busyAction !== null}
								>
									cancel
								</button>
								<button
									type="button"
									class="action-button-negative"
									onclick={resetDraftToDefaults}
									disabled={formDisabled}
								>
									reset defaults
								</button>
							</div>
							<div class="admin-config-action-group admin-config-save-action-group">
								{#if infraRunning}
									<p class="admin-config-restart-note">
										Saved changes apply after you stop and restart infra.
									</p>
								{/if}
								<button type="submit" class="action-button-positive" disabled={saveDisabled}>
									{busyAction === 'save' ? 'saving...' : 'save'}
								</button>
							</div>
						</div>
					</section>
				</form>
			{:else}
				<section class="runtime-section">
					<p class="runtime-error" role="alert">{errorMessage ?? 'configuration unavailable'}</p>
				</section>
			{/if}
		</div>
	</div>
</AdminSectionFrame>

<style>
	.admin-config-body {
		height: 100%;
		display: grid;
		align-content: start;
	}

	.admin-config-inlay {
		display: grid;
		gap: 1.1rem;
		width: min(62rem, 100%);
	}

	.admin-config-form {
		display: grid;
		gap: 1.35rem;
	}

	.admin-config-group {
		align-content: start;
		gap: 0.72rem;
	}

	.admin-config-view-row {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: var(--control-button-gap);
		flex-wrap: wrap;
		width: min(40.15rem, 100%);
		max-width: 100%;
	}

	.admin-config-row-warning .admin-setting-label-cell {
		color: var(--c-yellow);
	}

	.admin-config-checkbox-row {
		grid-template-columns: minmax(9.5rem, 13.6rem) max-content;
	}

	.admin-config-textarea-row {
		align-items: start;
	}

	.admin-config-sourcing-row {
		align-items: start;
	}

	.admin-config-sourcing-cell {
		display: grid;
		gap: 0.45rem;
		width: min(25.85rem, 100%);
	}

	.admin-config-sourcing-actions {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: 0.45rem;
		flex-wrap: wrap;
	}

	.admin-config-sourcing-actions button {
		min-width: 8.75rem;
		white-space: normal;
		text-align: left;
	}

	.admin-config-benchmark-summary {
		margin: 0;
		font-size: 0.78rem;
		color: var(--c-sand);
		line-height: 1.35;
	}

	.admin-config-control {
		width: min(25.85rem, 100%);
	}

	.admin-config-control-warning,
	.admin-config-control-warning:focus {
		border-color: var(--c-yellow);
	}

	.admin-config-textarea {
		min-height: 4.5rem;
		resize: vertical;
	}

	.admin-config-actions {
		display: grid;
		grid-template-columns: max-content 1fr;
		align-items: center;
		gap: 2rem;
		width: min(40.15rem, 100%);
		max-width: 100%;
		overflow-x: auto;
		padding-bottom: 0.1rem;
	}

	.admin-config-action-group {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.admin-config-action-group:last-child {
		justify-self: end;
	}

	.admin-config-save-action-group {
		justify-content: flex-end;
	}

	.admin-config-restart-note {
		margin: 0;
		max-width: 16.5rem;
		color: var(--c-yellow);
		font-size: 0.72rem;
		line-height: 1.25;
		text-align: right;
	}

	.admin-config-actions button {
		min-width: 8.75rem;
	}
</style>
