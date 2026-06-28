import { expect, test, type Page, type TestInfo } from 'playwright/test';
import {
	assertAttachedAppReachable,
	attachDiagnostics,
	capturePageDiagnostics
} from './attached-app';
import {
	BIDDING_AUTOMATION_PRICING_MODE,
	BIDDING_AUTOMATION_PRICING_MODE_LABEL
} from '../src/lib/bidding-automation';

const TARGET_PATH =
	process.env.ARTGOD_E2E_BIDDING_TARGET_PATH?.trim() ||
	process.env.ARTGOD_E2E_TARGET_PATH?.trim() ||
	'/ethereum/terraforms/bidding?bid_scope=token';
const TRAIT_TARGET_PATH =
	process.env.ARTGOD_E2E_BIDDING_TRAIT_TARGET_PATH?.trim() ||
	process.env.ARTGOD_E2E_TARGET_PATH?.trim() ||
	'/ethereum/terraforms/bidding?bid_scope=traits';
const PRICE_TIER_LABEL = process.env.ARTGOD_E2E_PRICE_TIER_LABEL?.trim() || null;
const GEOMETRY_TOLERANCE_PX = 4;

test('bidding automation panel keeps tier-pricing fields on a clean grid', async ({
	page,
	request
}, testInfo) => {
	const diagnostics = capturePageDiagnostics(page);

	try {
		await assertAttachedAppReachable(request, {
			targetPath: TARGET_PATH,
			probeName: 'bidding'
		});

		await page.goto(TARGET_PATH, {
			waitUntil: 'domcontentloaded'
		});
		await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');

		await openBiddingPanel(page);
		await selectTierPricing(page);

		const panel = page.locator('.bidding-automation-panel').last();
		await expect(panel).toBeVisible();

		const metrics = await readBiddingPanelMetrics(page);
		assertBiddingPanelMetrics(metrics, testInfo);

		await testInfo.attach('bidding-panel-tier-pricing.png', {
			body: await page.screenshot({ fullPage: false }),
			contentType: 'image/png'
		});
	} catch (error) {
		await attachDiagnostics(testInfo, diagnostics);
		throw error;
	}
});

test('trait bucket bid action opens the bidding panel for that target', async ({
	page,
	request
}, testInfo) => {
	const diagnostics = capturePageDiagnostics(page);

	try {
		await assertAttachedAppReachable(request, {
			targetPath: TRAIT_TARGET_PATH,
			probeName: 'bidding traits'
		});

		await page.goto(TRAIT_TARGET_PATH, {
			waitUntil: 'domcontentloaded'
		});
		await page.waitForFunction(() => document.documentElement.dataset.artgodHydrated === '1');

		const selection = await clickFirstTraitBucketBidAction(page);
		const panel = page.locator('.bidding-automation-panel').last();
		await expect(panel).toBeVisible();
		await expect(panel.locator('.token-bidding-runtime-grid')).toContainText(
			selection.firstTraitValue
		);
		await expect(page.locator('#bidding-automation-floor')).toHaveValue(/\S+/);
		await expect(page.locator('#bidding-automation-ceiling')).toHaveValue(/\S+/);
		await expect(page.locator('#bidding-automation-delta')).toHaveValue(/\S+/);
	} catch (error) {
		await attachDiagnostics(testInfo, diagnostics);
		throw error;
	}
});

async function openBiddingPanel(page: Page): Promise<void> {
	const panel = page.locator('.bidding-automation-panel').last();
	if (await panel.isVisible()) {
		return;
	}

	const candidateButtons = [
		page.getByRole('button', { name: /^bid on all tokens$/ }),
		page.getByRole('button', { name: /^bid on this page$/ }),
		page.getByRole('button', { name: /^bid on traits$/ }),
		page.getByRole('button', { name: /^place collection bid$/ }),
		page.getByRole('button', { name: /^bid$/ })
	];

	for (const buttons of candidateButtons) {
		const count = await buttons.count();
		for (let index = 0; index < count; index += 1) {
			const button = buttons.nth(index);
			if ((await button.isVisible()) && (await button.isEnabled())) {
				await button.click();
				await expect(panel).toBeVisible();
				return;
			}
		}
	}

	throw new Error(
		`Could not open the bidding panel from ${TARGET_PATH}. Load a bidding/offers view with at least one enabled bid target action.`
	);
}

async function clickFirstTraitBucketBidAction(page: Page): Promise<{ firstTraitValue: string }> {
	const rows = page.locator('.bid-book-demand-group-row');
	const rowCount = await rows.count();
	for (let index = 0; index < rowCount; index += 1) {
		const row = rows.nth(index);
		const bidButton = row.getByRole('button', { name: /^place bid on / }).first();
		if (!(await bidButton.isVisible()) || !(await bidButton.isEnabled())) {
			continue;
		}

		const traitValue = row
			.locator('.bid-book-demand-trait-value-link, .bid-book-demand-trait-value')
			.first();
		const firstTraitValue = (await traitValue.innerText()).trim();
		if (!firstTraitValue) {
			continue;
		}

		await bidButton.click();
		return { firstTraitValue };
	}

	throw new Error(
		`Could not find a clickable trait-bucket bid action from ${TRAIT_TARGET_PATH}. Load a trait bid-book view with at least one selectable trait bid.`
	);
}

async function selectTierPricing(page: Page): Promise<void> {
	const pricingMode = page.locator('#bidding-automation-pricing-select');
	await expect(
		pricingMode,
		'The bidding panel must expose pricing controls; create at least one price tier first.'
	).toBeVisible();

	const tagName = await pricingMode.evaluate((element) => element.tagName.toLowerCase());
	if (tagName === 'select') {
		const tierOptions = await pricingMode.locator('option').evaluateAll((options) =>
			options
				.map((option) => ({
					value: (option as HTMLOptionElement).value,
					label: (option.textContent ?? '').trim()
				}))
				.filter((option) => option.value !== BIDDING_AUTOMATION_PRICING_MODE.Manual)
		);
		const targetTier =
			(PRICE_TIER_LABEL
				? tierOptions.find((option) => option.label === PRICE_TIER_LABEL)
				: tierOptions[0]) ?? null;
		if (!targetTier) {
			throw new Error('No selectable price tier exists in the bidding panel.');
		}
		await pricingMode.selectOption(targetTier.value);
	} else {
		const tierButtons = pricingMode.locator('button').filter({
			hasNotText: new RegExp(
				`^${BIDDING_AUTOMATION_PRICING_MODE_LABEL[BIDDING_AUTOMATION_PRICING_MODE.Manual]}$`
			)
		});
		const targetButton = PRICE_TIER_LABEL
			? tierButtons.filter({ hasText: PRICE_TIER_LABEL }).first()
			: tierButtons.first();
		await expect(targetButton, 'No selectable price-tier button exists in the bidding panel.').toBeVisible();
		await targetButton.click();
	}

	await expect(page.locator('#bidding-automation-floor')).toBeVisible();
	await expect(page.locator('#bidding-automation-ceiling')).toBeVisible();
	await expect(page.locator('#bidding-automation-delta')).toBeVisible();
}

async function readBiddingPanelMetrics(page: Page): Promise<BiddingPanelMetrics> {
	return page.evaluate(() => {
		const readRect = (element: Element) => {
			const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
			return { left, top, right, bottom, width, height };
		};
		const panel = document.querySelector('.bidding-automation-panel');
		if (!(panel instanceof HTMLElement)) {
			throw new Error('Bidding automation panel was not found');
		}

		const rows = [...document.querySelectorAll('.token-bidding-form .bootstrap-form-row')].map(
			(row) => {
				const label = row.querySelector('label');
				const control = row.querySelector('input, select, #bidding-automation-pricing-select');
				if (!(label instanceof HTMLElement) || !(control instanceof HTMLElement)) {
					throw new Error('Bidding form row is missing a label or control');
				}
				return {
					row: readRect(row),
					label: readRect(label),
					control: readRect(control),
					controlId: control.id
				};
			}
		);

		const leftAction = document.querySelector(
			'.token-bidding-form-actions-left button:not([hidden])'
		);
		const rightAction = document.querySelector(
			'.token-bidding-form-actions-right button:not([hidden])'
		);

		return {
			viewport: {
				width: window.innerWidth,
				height: window.innerHeight
			},
			scrollWidth: document.documentElement.scrollWidth,
			panel: readRect(panel),
			rows,
			leftAction: leftAction ? readRect(leftAction) : null,
			rightAction: rightAction ? readRect(rightAction) : null
		};
	});
}

function assertBiddingPanelMetrics(metrics: BiddingPanelMetrics, testInfo: TestInfo): void {
	expect(
		metrics.rows.length,
		`${testInfo.project.name} should render bidding form rows`
	).toBeGreaterThanOrEqual(4);
	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport.width + GEOMETRY_TOLERANCE_PX);
	expect(metrics.panel.left).toBeGreaterThanOrEqual(-GEOMETRY_TOLERANCE_PX);
	expect(metrics.panel.top).toBeGreaterThanOrEqual(-GEOMETRY_TOLERANCE_PX);
	expect(metrics.panel.right).toBeLessThanOrEqual(metrics.viewport.width + GEOMETRY_TOLERANCE_PX);
	expect(metrics.panel.bottom).toBeLessThanOrEqual(metrics.viewport.height + GEOMETRY_TOLERANCE_PX);

	const first = metrics.rows[0];
	for (const row of metrics.rows) {
		expect(
			Math.abs(row.row.left - first.row.left),
			`${testInfo.project.name} ${row.controlId} row left edge drifted`
		).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
		expect(
			Math.abs(row.row.right - first.row.right),
			`${testInfo.project.name} ${row.controlId} row right edge drifted`
		).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
		expect(
			Math.abs(row.label.right - first.label.right),
			`${testInfo.project.name} ${row.controlId} label right edge drifted`
		).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
		expect(
			Math.abs(row.control.left - first.control.left),
			`${testInfo.project.name} ${row.controlId} control left edge drifted`
		).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
		expect(
			Math.abs(row.control.right - first.control.right),
			`${testInfo.project.name} ${row.controlId} control right edge drifted`
		).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
		expect(
			Math.abs(row.control.width - first.control.width),
			`${testInfo.project.name} ${row.controlId} control width drifted`
		).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
		expect(row.label.right).toBeLessThan(row.control.left);
		expect(row.row.left).toBeGreaterThanOrEqual(metrics.panel.left - GEOMETRY_TOLERANCE_PX);
		expect(row.row.right).toBeLessThanOrEqual(metrics.panel.right + GEOMETRY_TOLERANCE_PX);
	}

	if (metrics.leftAction) {
		expect(
			Math.abs(metrics.leftAction.left - first.row.left),
			`${testInfo.project.name} left action should align to the form grid`
		).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
	}
	if (metrics.rightAction) {
		expect(
			Math.abs(metrics.rightAction.right - first.control.right),
			`${testInfo.project.name} right action should align to the control column`
		).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
	}
}

type RectSnapshot = {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
};

type BiddingPanelMetrics = {
	viewport: {
		width: number;
		height: number;
	};
	scrollWidth: number;
	panel: RectSnapshot;
	rows: {
		row: RectSnapshot;
		label: RectSnapshot;
		control: RectSnapshot;
		controlId: string;
	}[];
	leftAction: RectSnapshot | null;
	rightAction: RectSnapshot | null;
};
