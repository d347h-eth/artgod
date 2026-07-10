const RELEASE_TAG_PREFIX = "v";
const RELEASE_TEST_TAG_SEPARATOR = "-test.";

// GitHub's ref-type value required for every desktop release operation.
export const RELEASE_TAG_REF_TYPE = "tag";

// Accepts only the exact project tag or its numbered dry-run variant.
export function classifyReleaseTag(tagName, projectVersion) {
    const version = requireNonEmptyValue(projectVersion, "project version");
    const tag = requireNonEmptyValue(tagName, "release tag");
    const releaseTag = `${RELEASE_TAG_PREFIX}${version}`;
    if (tag === releaseTag) {
        return Object.freeze({ tagName: tag, isTestRelease: false });
    }

    const testTagPrefix = `${releaseTag}${RELEASE_TEST_TAG_SEPARATOR}`;
    const testSequence = tag.startsWith(testTagPrefix)
        ? tag.slice(testTagPrefix.length)
        : "";
    if (/^[1-9][0-9]*$/.test(testSequence)) {
        return Object.freeze({ tagName: tag, isTestRelease: true });
    }

    throw new Error(
        `Release tag ${JSON.stringify(tag)} must be ${releaseTag} or ${testTagPrefix}<positive-integer>.`,
    );
}

function requireNonEmptyValue(value, description) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`Missing ${description}.`);
    }
    return normalized;
}
