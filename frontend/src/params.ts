import { defineParams } from '@sveltejs/kit/params';

function numeric(value: string): string | undefined {
	return /^\d+$/.test(value) ? value : undefined;
}

export const params = defineParams({ numeric });
