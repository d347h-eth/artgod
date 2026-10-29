import { dev } from '$app/env';
import { error } from '@sveltejs/kit';

export const ssr = false;

export const load = () => {
	if (!dev) throw error(404, 'Not found');
	return {};
};
