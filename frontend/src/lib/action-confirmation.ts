// Confirmation belongs to the exact initiating control, including its children.
// Shared by bidding jobs and their collection preset editors.
export function isConfirmationActionTarget(
	target: EventTarget | null,
	actionKey: string | null,
	attribute: string
): boolean {
	if (!actionKey || !(target instanceof Element)) return false;
	for (let element: Element | null = target; element; element = element.parentElement) {
		if (element.getAttribute(attribute) === actionKey) return true;
	}
	return false;
}
export const BIDDING_JOB_REAPPLY_ACTION_KEY = 'reapply:form';
