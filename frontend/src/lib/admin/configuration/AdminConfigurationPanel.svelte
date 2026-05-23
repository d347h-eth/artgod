<script lang="ts">
	import { onMount } from 'svelte';
	import AdminSectionFrame from '$lib/admin/components/AdminSectionFrame.svelte';
	import { createTauriAdminConfigPort } from '$lib/admin/configuration/adapters/tauri-admin-config-port';
	import type {
		AdminConfigField,
		AdminConfigGroup,
		AdminConfigState
	} from '$lib/admin/configuration/ports';
	import { adminRuntimeStore } from '$lib/admin/runtime/store';

	const configPort = createTauriAdminConfigPort();
	const runtimeState = adminRuntimeStore.state;

	let config = $state<AdminConfigState | null>(null);
	let values = $state<Record<string, string>>({});
	let autoLaunchOnStartup = $state(false);
	let loading = $state(true);
	let editing = $state(false);
	let busyAction = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let saveMessage = $state<string | null>(null);

	const editableGroups = $derived((config?.groups ?? []).filter((group) => group.fields.length > 0));
	const isRuntimeStopped = $derived($runtimeState.status?.state !== 'running');
	const launchDisabled = $derived(
		busyAction !== null ||
			$runtimeState.busyAction !== null ||
			!isRuntimeStopped ||
			($runtimeState.status?.state === 'starting' || $runtimeState.status?.state === 'restarting')
	);

	onMount(() => {
		void loadConfig();
	});

	function applyConfigState(next: AdminConfigState): void {
		config = next;
		values = { ...next.values };
		autoLaunchOnStartup = next.autoLaunchOnStartup;
	}

	async function loadConfig(): Promise<void> {
		loading = true;
		errorMessage = null;
		try {
			const next = await configPort.getConfig();
			applyConfigState(next);
			editing = false;
		} catch (error) {
			errorMessage = toErrorMessage(error, 'Configuration could not be loaded.');
		} finally {
			loading = false;
		}
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
		saveMessage = null;
		errorMessage = null;
	}

	async function useDefaultsAndLaunch(): Promise<void> {
		await withBusyAction('defaults', async () => {
			const next = await configPort.useDefaults();
			applyConfigState(next);
			editing = false;
			await adminRuntimeStore.start();
			saveMessage = 'default settings applied';
		});
	}

	async function launchSavedConfig(): Promise<void> {
		await withBusyAction('launch', async () => {
			await adminRuntimeStore.start();
		});
	}

	async function saveConfig(launchAfterSave: boolean): Promise<void> {
		await withBusyAction(launchAfterSave ? 'saveLaunch' : 'save', async () => {
			const next = await configPort.saveConfig({
				values,
				autoLaunchOnStartup
			});
			applyConfigState(next);
			editing = false;
			saveMessage = 'configuration saved';
			if (launchAfterSave) {
				await adminRuntimeStore.start();
			}
		});
	}

	async function withBusyAction(action: string, work: () => Promise<void>): Promise<void> {
		if (busyAction !== null) {
			return;
		}
		busyAction = action;
		errorMessage = null;
		saveMessage = null;
		try {
			await work();
		} catch (error) {
			errorMessage = toErrorMessage(error, 'Configuration action failed.');
		} finally {
			busyAction = null;
		}
	}

	function fieldValue(field: AdminConfigField): string {
		return values[field.key] ?? '';
	}

	function fieldChecked(field: AdminConfigField): boolean {
		return ['1', 'true', 'yes', 'on'].includes(fieldValue(field).trim().toLowerCase());
	}

	function toErrorMessage(error: unknown, fallback: string): string {
		if (error instanceof Error && error.message.trim().length > 0) {
			return error.message;
		}
		if (typeof error === 'string' && error.trim().length > 0) {
			return error;
		}
		return fallback;
	}
</script>

<AdminSectionFrame>
	<div class="admin-config-body">
		<div class="admin-config-inlay">
			<section class="runtime-section">
				<h3>Launch</h3>
				{#if loading}
					<p class="muted">loading configuration</p>
				{:else if config && !config.configured && !editing}
					<div class="runtime-controls">
						<button
							type="button"
							class="runtime-primary-cta"
							onclick={() => void useDefaultsAndLaunch()}
							disabled={launchDisabled}
						>
							launch with default settings
						</button>
						<button
							type="button"
							onclick={() => {
								editing = true;
							}}
							disabled={busyAction !== null}
						>
							configure first
						</button>
					</div>
				{:else if config && !editing}
					<div class="runtime-controls">
						<button
							type="button"
							class="runtime-primary-cta"
							onclick={() => void launchSavedConfig()}
							disabled={launchDisabled}
						>
							launch ArtGod
						</button>
						<button
							type="button"
							onclick={() => {
								editing = true;
							}}
							disabled={busyAction !== null}
						>
							configuration
						</button>
					</div>
				{/if}

				{#if busyAction}
					<p class="muted">running action: {busyAction}</p>
				{/if}
				{#if errorMessage}
					<p class="runtime-error" role="alert">{errorMessage}</p>
				{/if}
				{#if $runtimeState.error}
					<p class="runtime-error" role="alert">{$runtimeState.error}</p>
				{/if}
				{#if saveMessage}
					<p class="runtime-pass">{saveMessage}</p>
				{/if}
			</section>

			{#if config && editing}
				<form
					class="admin-config-form"
					onsubmit={(event) => {
						event.preventDefault();
						void saveConfig(false);
					}}
				>
					<section class="runtime-section admin-config-group">
						<h3>Desktop</h3>
						<label class="admin-config-row admin-config-checkbox-row">
							<span>launch on startup</span>
							<input
								type="checkbox"
								class="bootstrap-checkbox"
								checked={autoLaunchOnStartup}
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
								<label class="admin-config-row" class:admin-config-textarea-row={field.inputKind === 'textarea'}>
									<span>{field.label}</span>
									{#if field.inputKind === 'checkbox'}
										<input
											type="checkbox"
											class="bootstrap-checkbox"
											checked={fieldChecked(field)}
											onchange={(event) => {
												setValue(field.key, (event.currentTarget as HTMLInputElement).checked ? 'true' : 'false');
											}}
										/>
									{:else if field.inputKind === 'select'}
										<select
											class="bootstrap-control-select admin-config-control"
											value={fieldValue(field)}
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
											value={fieldValue(field)}
											oninput={(event) => {
												setValue(field.key, (event.currentTarget as HTMLTextAreaElement).value);
											}}
										></textarea>
									{:else}
										<input
											class="bootstrap-control admin-config-control"
											type={field.inputKind === 'password' ? 'password' : 'text'}
											value={fieldValue(field)}
											oninput={(event) => {
												setValue(field.key, (event.currentTarget as HTMLInputElement).value);
											}}
										/>
									{/if}
								</label>
							{/each}
						</section>
					{/each}

					<section class="runtime-section">
						<div class="runtime-controls admin-config-actions">
							<button type="submit" disabled={busyAction !== null}>
								{busyAction === 'save' ? 'saving...' : 'save'}
							</button>
							<button
								type="button"
								class="runtime-primary-cta"
								onclick={() => void saveConfig(true)}
								disabled={busyAction !== null || !isRuntimeStopped}
							>
								{busyAction === 'saveLaunch' ? 'saving...' : 'save and launch'}
							</button>
							<button type="button" onclick={resetDraftToDefaults} disabled={busyAction !== null}>
								reset to defaults
							</button>
							{#if config.configured}
								<button
									type="button"
									onclick={() => {
										if (config) {
											applyConfigState(config);
										}
										editing = false;
										errorMessage = null;
										saveMessage = null;
									}}
									disabled={busyAction !== null}
								>
									cancel
								</button>
							{/if}
						</div>
					</section>
				</form>
			{/if}

			{#if config}
				<section class="runtime-section">
					<h3>Paths</h3>
					<div class="runtime-kv-grid">
						<div>
							<span class="runtime-k">settings</span>
							<span class="runtime-v mono admin-config-path">{config.settingsFilePath}</span>
						</div>
						<div>
							<span class="runtime-k">env</span>
							<span class="runtime-v mono admin-config-path">{config.envFilePath}</span>
						</div>
					</div>
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
		gap: 0.85rem;
		width: min(62rem, 100%);
	}

	.admin-config-form {
		display: grid;
		gap: 0.85rem;
	}

	.admin-config-group {
		align-content: start;
	}

	.admin-config-row {
		display: grid;
		grid-template-columns: minmax(12rem, 17rem) minmax(16rem, 34rem);
		align-items: center;
		gap: 0.7rem;
		width: fit-content;
		max-width: 100%;
	}

	.admin-config-row > span {
		font-size: 0.75rem;
		text-transform: uppercase;
		color: var(--c-sand);
		line-height: 1.15;
	}

	.admin-config-checkbox-row {
		grid-template-columns: minmax(12rem, 17rem) max-content;
	}

	.admin-config-textarea-row {
		align-items: start;
	}

	.admin-config-control {
		width: min(34rem, 100%);
	}

	.admin-config-textarea {
		min-height: 4.5rem;
		resize: vertical;
	}

	.admin-config-actions {
		align-items: center;
	}

	.admin-config-path {
		overflow-wrap: anywhere;
	}

	@media (max-width: 48rem) {
		.admin-config-row,
		.admin-config-checkbox-row {
			grid-template-columns: 1fr;
			gap: 0.35rem;
		}

		.admin-config-control {
			width: 100%;
		}
	}
</style>
