import { describe, expect, it } from 'vitest';
import { TRADING_BOT_KIND } from '@artgod/shared/types';
import {
	beginAdminBotStart,
	beginAdminBotStop,
	canStopAdminBot,
	createAdminBotActionState,
	finishAdminBotAction,
	isAdminBotStartPending,
	isAdminBotStopPending,
	isCurrentAdminBotAction
} from './admin-bot-action-state';
import { ADMIN_BOT_STATE, type AdminBotState } from './ports';

function botState(state: AdminBotState) {
	return {
		botKind: TRADING_BOT_KIND.Bidding,
		state
	};
}

describe('Admin bot action state', () => {
	it('keeps Stop available throughout the active bot lifecycle', () => {
		const actionState = createAdminBotActionState();
		for (const state of [
			ADMIN_BOT_STATE.AwaitingUnlock,
			ADMIN_BOT_STATE.Starting,
			ADMIN_BOT_STATE.Bootstrapping,
			ADMIN_BOT_STATE.Running
		]) {
			expect(canStopAdminBot(actionState, botState(state))).toBe(true);
		}

		expect(canStopAdminBot(actionState, botState(ADMIN_BOT_STATE.Locked))).toBe(false);
		expect(canStopAdminBot(actionState, botState(ADMIN_BOT_STATE.Stopped))).toBe(false);
	});

	it('allows a pending start to be stopped before its first state event arrives', () => {
		const initial = createAdminBotActionState();
		const start = beginAdminBotStart(initial, TRADING_BOT_KIND.Bidding);
		expect(start).not.toBeNull();
		if (!start) return;

		expect(isAdminBotStartPending(start.state, TRADING_BOT_KIND.Bidding)).toBe(true);
		expect(canStopAdminBot(start.state, botState(ADMIN_BOT_STATE.Locked))).toBe(true);

		const stop = beginAdminBotStop(start.state, TRADING_BOT_KIND.Bidding);
		expect(stop).not.toBeNull();
		if (!stop) return;

		expect(isCurrentAdminBotAction(stop.state, start.request)).toBe(false);
		expect(isCurrentAdminBotAction(stop.state, stop.request)).toBe(true);
		expect(isAdminBotStopPending(stop.state, TRADING_BOT_KIND.Bidding)).toBe(true);
	});

	it('preserves locked or stopped recovery when the cancelled start completes late', () => {
		const start = beginAdminBotStart(createAdminBotActionState(), TRADING_BOT_KIND.Bidding);
		expect(start).not.toBeNull();
		if (!start) return;
		const stop = beginAdminBotStop(start.state, TRADING_BOT_KIND.Bidding);
		expect(stop).not.toBeNull();
		if (!stop) return;

		const recovered = finishAdminBotAction(stop.state, stop.request, {
			stopSucceeded: true
		});
		expect(isAdminBotStartPending(recovered, TRADING_BOT_KIND.Bidding)).toBe(false);
		expect(isAdminBotStopPending(recovered, TRADING_BOT_KIND.Bidding)).toBe(false);
		expect(canStopAdminBot(recovered, botState(ADMIN_BOT_STATE.Locked))).toBe(false);
		expect(canStopAdminBot(recovered, botState(ADMIN_BOT_STATE.Stopped))).toBe(false);

		const afterLateStart = finishAdminBotAction(recovered, start.request);
		expect(afterLateStart).toEqual(recovered);
		expect(isCurrentAdminBotAction(afterLateStart, start.request)).toBe(false);
	});

	it('keeps a pending start stoppable when Stop fails', () => {
		const start = beginAdminBotStart(createAdminBotActionState(), TRADING_BOT_KIND.Bidding);
		expect(start).not.toBeNull();
		if (!start) return;
		const stop = beginAdminBotStop(start.state, TRADING_BOT_KIND.Bidding);
		expect(stop).not.toBeNull();
		if (!stop) return;

		const failedStop = finishAdminBotAction(stop.state, stop.request);
		expect(isAdminBotStartPending(failedStop, TRADING_BOT_KIND.Bidding)).toBe(true);
		expect(canStopAdminBot(failedStop, botState(ADMIN_BOT_STATE.Starting))).toBe(true);
		expect(beginAdminBotStop(failedStop, TRADING_BOT_KIND.Bidding)).not.toBeNull();
	});
});
