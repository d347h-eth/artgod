import type { AdminBotOverview, AdminBotPort } from '../ports';

const PLACEHOLDER_BOT_OVERVIEW: AdminBotOverview = {
	configuredBotKinds: ['bidding', 'sniping'],
	restartPolicy: 'prompt_on_restart',
	secretHandoff: 'stdin_pipe_once'
};

export function createPlaceholderAdminBotPort(): AdminBotPort {
	return {
		async getOverview(): Promise<AdminBotOverview> {
			return PLACEHOLDER_BOT_OVERVIEW;
		}
	};
}
