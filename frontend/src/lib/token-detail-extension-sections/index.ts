import type {
	TokenDetailExtensionSection,
	TokenDetailExtensionSectionContext,
	TokenDetailExtensionSectionRegistrar,
	TokenDetailExtensionSectionRegistration
} from '$lib/token-detail-extension-sections/types';

export type { TokenDetailExtensionSection } from '$lib/token-detail-extension-sections/types';

type RegisteredTokenDetailExtensionSection = TokenDetailExtensionSectionRegistration & {
	registrationIndex: number;
};

const TOKEN_DETAIL_EXTENSION_SECTION_DEFAULT_ORDER = 1000;
let nextRegistrationIndex = 0;
const tokenDetailSectionsByExtension = new Map<
	string,
	Map<string, RegisteredTokenDetailExtensionSection>
>();

// Registers or replaces an extension-owned token detail section.
export function registerTokenDetailExtensionSection(
	registration: TokenDetailExtensionSectionRegistration
): void {
	const extensionSections =
		tokenDetailSectionsByExtension.get(registration.extensionKey) ?? new Map();
	const existing = extensionSections.get(registration.sectionId);
	extensionSections.set(registration.sectionId, {
		...registration,
		registrationIndex: existing?.registrationIndex ?? nextRegistrationIndex++
	});
	tokenDetailSectionsByExtension.set(registration.extensionKey, extensionSections);
}

// Registrar object is the stable API surface passed to extension activation modules.
export const tokenDetailExtensionSectionRegistrar: TokenDetailExtensionSectionRegistrar = {
	registerTokenDetailExtensionSection
};

// Resolves token detail sections for extensions explicitly enabled on the collection.
export function resolveTokenDetailExtensionSections(
	context: TokenDetailExtensionSectionContext
): TokenDetailExtensionSection[] {
	const enabledExtensionKeys = new Set(
		context.collection.extensions?.map((extension) => extension.key) ?? []
	);
	return [...tokenDetailSectionsByExtension.entries()]
		.filter(([extensionKey]) => enabledExtensionKeys.has(extensionKey))
		.flatMap(([extensionKey, sections]) =>
			[...sections.values()].map((section) => ({ ...section, extensionKey }))
		)
		.filter((section) => section.isVisible?.(context) ?? true)
		.sort(compareTokenDetailSections)
		.map((section) => ({
			extensionKey: section.extensionKey,
			sectionId: section.sectionId,
			Section: section.Section
		}));
}

function compareTokenDetailSections(
	left: RegisteredTokenDetailExtensionSection,
	right: RegisteredTokenDetailExtensionSection
): number {
	const orderCompare =
		(left.order ?? TOKEN_DETAIL_EXTENSION_SECTION_DEFAULT_ORDER) -
		(right.order ?? TOKEN_DETAIL_EXTENSION_SECTION_DEFAULT_ORDER);
	if (orderCompare !== 0) return orderCompare;
	return left.registrationIndex - right.registrationIndex;
}
