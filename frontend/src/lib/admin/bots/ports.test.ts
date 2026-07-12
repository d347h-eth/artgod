import { describe, expect, it } from 'vitest';
import { ADMIN_BOT_STATE, formatAdminBotState } from './ports';

describe('Admin bot state labels', () => {
	it('uses user-facing lifecycle language instead of supervisor wire values', () => {
		expect(formatAdminBotState(ADMIN_BOT_STATE.Disabled)).toBe('unavailable');
		expect(formatAdminBotState(ADMIN_BOT_STATE.Locked)).toBe('locked');
		expect(formatAdminBotState(ADMIN_BOT_STATE.AwaitingUnlock)).toBe('waiting for wallet unlock');
		expect(formatAdminBotState(ADMIN_BOT_STATE.Starting)).toBe('starting');
		expect(formatAdminBotState(ADMIN_BOT_STATE.Bootstrapping)).toBe('preparing bidding');
		expect(formatAdminBotState(ADMIN_BOT_STATE.Running)).toBe('running');
		expect(formatAdminBotState(ADMIN_BOT_STATE.Stopped)).toBe('stopped');
		expect(formatAdminBotState(ADMIN_BOT_STATE.Error)).toBe('failed');
	});
});
