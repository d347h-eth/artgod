export type AdminBotKind = 'bidding' | 'sniping';

export type AdminBotOverview = {
	configuredBotKinds: AdminBotKind[];
	restartPolicy: 'prompt_on_restart';
	secretHandoff: 'stdin_pipe_once';
};

export interface AdminBotPort {
	getOverview(): Promise<AdminBotOverview>;
}
