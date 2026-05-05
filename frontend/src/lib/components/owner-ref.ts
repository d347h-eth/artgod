import {
	isAddressRef,
	isEnsNameRef,
	normalizeAddressRef
} from '@artgod/shared/utils/ref-resolver';
import { resolveOwnerRef } from '$lib/backend-api';

export type ResolveOwnerAddressRefInput = {
	fetchFn: typeof fetch;
	chainRef: string;
	value: string;
};

// Resolves user-entered owner refs into a normalized address for owner-scoped UI actions.
export async function resolveOwnerAddressRef(
	input: ResolveOwnerAddressRefInput
): Promise<string | null> {
	const nextValue = input.value.trim();
	if (!nextValue) {
		return null;
	}
	if (isAddressRef(nextValue)) {
		return normalizeAddressRef(nextValue);
	}
	if (!isEnsNameRef(nextValue) || !input.chainRef.trim()) {
		return null;
	}

	// Delegate ENS resolution to the backend so frontend controls share one chain-aware resolver.
	const resolution = await resolveOwnerRef(input.fetchFn, input.chainRef, nextValue);
	return normalizeAddressRef(resolution.resolvedAddress);
}
