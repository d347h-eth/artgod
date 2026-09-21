import { test, expect, type Page, type TestInfo } from 'playwright/test';
import {
	RECOVERY_HARNESS_PATH,
	RECOVERY_HARNESS_SCENARIOS,
	RECOVERY_HARNESS_SCENARIO_KEY,
	type RecoveryHarnessScenario
} from '../src/lib/e2e/runtime-recovery-contract';
import { RECOVERY_FAILURE_REASONS } from '../src/lib/runtime/lifecycle/ports';
import { LISTING_HISTORY_HARNESS } from '../src/lib/e2e/listing-history-contract';
import { BIDDING_AUTOMATION_E2E_COLLECTION_BASE_PATH } from '../src/lib/e2e/bidding-automation-fixtures';
import {
	captureDiagnosticsForTest,
	attachDiagnosticsForTestFailure,
	type PageDiagnosticsRegistry
} from './attached-app';

const diagnostics: PageDiagnosticsRegistry = new Map();

test('daily listings retain historical prices and pinned timestamps after expiry', async ({
	page
}, info) => {
	await page.setViewportSize({ width: 1280, height: 1024 });
	await page.goto(LISTING_HISTORY_HARNESS.path);
	await expect(
		page.getByText('One entry per NFT and seller per UTC day. Historical prices are retained.')
	).toBeVisible();
	await expect(page.getByRole('columnheader', { name: 'price', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: '0.1 ETH', exact: true })).toBeVisible();
	const pinnedTime = () =>
		page.locator('tbody tr').first().locator('td').last().locator('[title]').getAttribute('title');
	const timestamp = await pinnedTime();
	expect(timestamp).toBeTruthy();
	await surface(page, info, 'daily-listing-current');
	await page.getByRole('link', { name: 'older', exact: true }).click();
	await expect(page.getByText('showing 2-2 of 2')).toBeVisible();
	expect(await pinnedTime()).not.toBe(timestamp);
	await surface(page, info, 'daily-listing-second-page');
	await page.getByRole('link', { name: 'newer', exact: true }).click();
	await expect(page.getByText('showing 1-1 of 2')).toBeVisible();
	expect(await pinnedTime()).toBe(timestamp);
	await page.goto(`${LISTING_HISTORY_HARNESS.path}?${LISTING_HISTORY_HARNESS.updatedKey}=1`);
	await expect(page.getByRole('link', { name: '0.05 ETH', exact: true })).toBeVisible();
	expect(await pinnedTime()).toBe(timestamp);
	await surface(page, info, 'daily-listing-price-changed');
	await page.goto(`${LISTING_HISTORY_HARNESS.path}?${LISTING_HISTORY_HARNESS.unavailableKey}=1`);
	await expect(page.getByRole('link', { name: '0.05 ETH', exact: true })).toBeVisible();
	await expect(page.getByText('No current ask', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('link', { name: '104', exact: true })).toBeVisible();
	expect(await pinnedTime()).toBe(timestamp);
	await surface(page, info, 'daily-listing-retained-price');
	await page.goto(`${LISTING_HISTORY_HARNESS.path}?${LISTING_HISTORY_HARNESS.emptyKey}=1`);
	await expect(page.getByText('no activities found', { exact: true })).toBeVisible();
	await surface(page, info, 'daily-listing-empty');
	await page.getByRole('link', { name: 'asks', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`${BIDDING_AUTOMATION_E2E_COLLECTION_BASE_PATH}\\?`));
	await expect(page.getByRole('link', { name: '0.9 ETH', exact: true })).toBeVisible();
	await surface(page, info, 'asks-card-grid');
	await page.getByRole('link', { name: 'listings', exact: true }).click();
	await expect(page.getByRole('link', { name: '0.1 ETH', exact: true })).toBeVisible();
	expect(await pinnedTime()).toBe(timestamp);
});
test.beforeEach(async ({ page }, info) => {
	captureDiagnosticsForTest(diagnostics, page, info);
	await page.clock.install();
});
test.afterEach(async ({ page }, info) => {
	if (info.status !== info.expectedStatus) await surface(page, info, 'failure-surface');
	await attachDiagnosticsForTestFailure(diagnostics, info);
});

async function open(
	page: Page,
	scenario: RecoveryHarnessScenario = RECOVERY_HARNESS_SCENARIOS.manual
) {
	await page.goto(`${RECOVERY_HARNESS_PATH}?${RECOVERY_HARNESS_SCENARIO_KEY}=${scenario}`);
	await page.waitForFunction(() => Boolean(window.runtimeRecoveryFixture));
}

async function surface(page: Page, info: TestInfo, name: string) {
	const path = info.outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: true });
	await info.attach(name, { path, contentType: 'image/png' });
	// Hidden overflow can make document scrollWidth pass while clipping controls.
	for (const button of await page.getByRole('button').all()) {
		if (!(await button.isVisible())) continue;
		const box = await button.boundingBox();
		expect(box?.x).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.width);
	}
	for (const text of await page.locator('.desktop-lifecycle-title-row > *').all()) {
		const box = await text.boundingBox();
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.width);
	}
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);
}

test('manual start, extended checking, services and confirmed Userland readiness', async ({
	page
}, info) => {
	await open(page);
	await expect(page.getByRole('button', { name: 'start infra', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'stop infra', exact: true })).toBeDisabled();
	await surface(page, info, 'before-start');
	await page.getByRole('button', { name: 'start infra', exact: true }).click();
	await expect(page.getByText('Checking queued work…', { exact: true }).first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'stop infra', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'enter the userland' })).toBeDisabled();
	await surface(page, info, 'checking');
	await page.clock.fastForward(45_000);
	await expect(page.getByRole('heading', { name: 'Preparing Runtime' })).toBeVisible();
	expect(await page.evaluate(() => window.runtimeRecoveryFixture.calls.includes('probe'))).toBe(
		false
	);
	await surface(page, info, 'extended-checking');
	await page.getByRole('button', { name: 'logs', exact: true }).click();
	await page.getByRole('button', { name: 'config', exact: true }).click();
	await expect(page.getByRole('button', { name: 'stop infra', exact: true })).toBeEnabled();
	await surface(page, info, 'config-during-checking');
	await page.getByRole('button', { name: 'system', exact: true }).click();
	await page.evaluate(() => window.runtimeRecoveryFixture.services());
	await page.clock.fastForward(60_000);
	await expect(page.getByText('Starting local services…', { exact: true }).first()).toBeVisible();
	await surface(page, info, 'services');
	await page.evaluate(() => window.runtimeRecoveryFixture.running(true));
	await expect
		.poll(() => page.evaluate(() => window.runtimeRecoveryFixture.calls.includes('probe')))
		.toBe(true);
	await expect(page.getByRole('button', { name: 'enter the userland' })).toBeDisabled();
	await surface(page, info, 'api-wait');
	await page.evaluate(() => window.runtimeRecoveryFixture.finishProbe());
	await expect(page.getByRole('button', { name: 'enter the userland' })).toBeEnabled();
	await surface(page, info, 'ready');
	await page.getByRole('button', { name: 'enter the userland' }).click();
	expect(await page.evaluate(() => window.runtimeRecoveryFixture.calls)).toContain('openUserland');
});

for (const reason of Object.values(RECOVERY_FAILURE_REASONS)) {
	test(`${reason} exposes cleanup, failure and a working manual retry`, async ({ page }, info) => {
		await open(page, RECOVERY_HARNESS_SCENARIOS.attached);
		await page.getByRole('button', { name: 'system', exact: true }).click();
		await page.evaluate(() => window.runtimeRecoveryFixture.cleanup());
		await expect(
			page.getByText('Cleaning up startup processes…', { exact: true }).first()
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'start infra', exact: true })).toBeDisabled();
		await surface(page, info, 'cleanup');
		await page.evaluate((reason) => window.runtimeRecoveryFixture.fail(reason), reason);
		await expect(page.getByRole('heading', { name: 'Runtime Failed' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'retry start', exact: true })).toBeEnabled();
		await surface(page, info, reason);
		const oldId = await page.evaluate(() => window.runtimeRecoveryFixture.status().operationId);
		await page.getByRole('button', { name: 'retry start', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Preparing Runtime' })).toBeVisible();
		expect(
			await page.evaluate(() => window.runtimeRecoveryFixture.status().operationId)
		).toBeGreaterThan(oldId);
		await surface(page, info, 'retry');
		await page.evaluate(() => window.runtimeRecoveryFixture.running());
		await expect(page.getByRole('button', { name: 'enter the userland' })).toBeEnabled();
	});
}

test('Stop cancels recovery, waits for cleanup and ignores late success', async ({
	page
}, info) => {
	await open(page, RECOVERY_HARNESS_SCENARIOS.autoStart);
	await expect(page.getByRole('button', { name: 'stop infra', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'stop infra', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Stopping Runtime' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'start infra', exact: true })).toBeDisabled();
	await surface(page, info, 'stopping');
	await page.evaluate(() => window.runtimeRecoveryFixture.finishStop());
	await expect(page.getByRole('button', { name: 'start infra', exact: true })).toBeEnabled();
	await page.evaluate(() => window.runtimeRecoveryFixture.lateRunning());
	await expect(page.getByRole('button', { name: 'enter the userland' })).toBeDisabled();
	await surface(page, info, 'stopped');
	await page.getByRole('button', { name: 'start infra', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Preparing Runtime' })).toBeVisible();
});

test('standalone lifecycle drawer offers Stop during preparation', async ({ page }, info) => {
	await open(page, RECOVERY_HARNESS_SCENARIOS.drawer);
	await expect(page.getByRole('heading', { name: 'Preparing Runtime' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'stop infra', exact: true })).toBeEnabled();
	await surface(page, info, 'standalone-drawer');
	await page.getByRole('button', { name: 'status', exact: true }).click();
	await expect(page.getByRole('button', { name: 'start', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'restart', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'stop', exact: true })).toBeEnabled();
	await surface(page, info, 'standalone-status');
	await page.getByRole('button', { name: 'lifecycle', exact: true }).click();
	await page.getByRole('button', { name: 'stop infra', exact: true }).click();
	await page.evaluate(() => window.runtimeRecoveryFixture.finishStop());
	await expect(
		page.getByText('Runtime stopped. Waiting for start command...', { exact: true })
	).toBeVisible();
});

for (const scenario of [RECOVERY_HARNESS_SCENARIOS.attached, RECOVERY_HARNESS_SCENARIOS.drawer]) {
	test(`SQLite preparation keeps Stop and manual recovery available: ${scenario}`, async ({
		page
	}, info) => {
		await open(page, scenario);
		if (scenario === RECOVERY_HARNESS_SCENARIOS.attached)
			await page.getByRole('button', { name: 'system', exact: true }).click();
		await page.evaluate(() => window.runtimeRecoveryFixture.sqlite());
		await expect(page.getByText('Checking market data…', { exact: true }).first()).toBeVisible();
		await expect(page.getByRole('button', { name: 'stop infra', exact: true })).toBeEnabled();
		await page.clock.fastForward(60_000);
		await surface(page, info, 'sqlite-checking');
		await page.evaluate(
			(reason) => window.runtimeRecoveryFixture.fail(reason),
			RECOVERY_FAILURE_REASONS.timedOut
		);
		await expect(page.getByRole('button', { name: 'retry start', exact: true })).toBeEnabled();
		await surface(page, info, 'sqlite-timeout');
		await page.getByRole('button', { name: 'retry start', exact: true }).click();
		await page.evaluate(() => window.runtimeRecoveryFixture.sqlite());
		await expect(page.getByText('Checking market data…', { exact: true }).first()).toBeVisible();
		await page.evaluate(() => window.runtimeRecoveryFixture.compact());
		await expect(page.getByText('Reclaiming storage…', { exact: true }).first()).toBeVisible();
		await surface(page, info, 'sqlite-compaction');
		await page.getByRole('button', { name: 'stop infra', exact: true }).click();
		await page.evaluate(() => window.runtimeRecoveryFixture.finishStop());
		if (scenario === RECOVERY_HARNESS_SCENARIOS.drawer)
			await expect(
				page.getByText('Runtime stopped. Waiting for start command...', { exact: true })
			).toBeVisible();
		else await expect(page.getByRole('button', { name: 'start infra', exact: true })).toBeEnabled();
	});
}
