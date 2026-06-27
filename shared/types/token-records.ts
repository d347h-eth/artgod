// Token row kinds distinguish onchain token identities from local browse-only rows.
export const TOKEN_RECORD_KIND = {
    Canonical: "canonical",
    ExtensionSynthetic: "extension_synthetic",
} as const;

export type TokenRecordKind =
    (typeof TOKEN_RECORD_KIND)[keyof typeof TOKEN_RECORD_KIND];
