import assert from "node:assert/strict";
import test from "node:test";

import {
    extractReleaseSummary,
    formatGitHubReleaseNotes,
    RELEASE_SUMMARY_HEADING,
} from "./desktop-release-notes.mjs";
import { classifyReleaseTag } from "./desktop-release-contract.mjs";

const version = "0.1.3-alpha";
const releaseHeading = `## ${version} - 2026-10-01`;
const summary = "- Easier collection setup.\n- More reliable market data.";
const entry = `${releaseHeading}\n\n${RELEASE_SUMMARY_HEADING}\n\n${summary}\n\n### Fixed\n\n- Detailed fix.\n`;

test("extracts only the selected version's summary, including wrapped bullets", () => {
    const changelog = [
        "# Changelog",
        "## Unreleased",
        RELEASE_SUMMARY_HEADING,
        "- Future changes.",
        entry.replace(
            "More reliable market data.",
            "More reliable\n  market data.",
        ),
        "## 0.1.2-alpha - 2026-09-01",
        RELEASE_SUMMARY_HEADING,
        "- Older changes.",
    ].join("\n\n");
    for (const source of [changelog, changelog.replace(/\n/g, "\r\n")]) {
        assert.equal(extractReleaseSummary(source, version), summary);
    }
});

test("rejects missing, duplicate, undated, and empty release sections", () => {
    for (const [source, error] of [
        [
            entry.replaceAll(version, `${version}.1`),
            /exactly one section.*found 0/,
        ],
        [`${entry}\n${entry}`, /exactly one section.*found 2/],
        [entry.replace(" - 2026-10-01", ""), /YYYY-MM-DD/],
        [releaseHeading, /exactly one .*Release summary.*found 0/],
        [
            `${releaseHeading}\n\n${RELEASE_SUMMARY_HEADING}\n`,
            /summary is empty/,
        ],
    ]) {
        assert.throws(() => extractReleaseSummary(source, version), error);
    }
});

test("requires exactly one nonempty summary made of unnested bullets", () => {
    for (const [source, error] of [
        [entry.replace(RELEASE_SUMMARY_HEADING, "### Summary"), /found 0/],
        [`${entry}\n${RELEASE_SUMMARY_HEADING}\n\n- Duplicate.\n`, /found 2/],
        [entry.replace(summary, "- "), /only short, unnested/],
        [entry.replace(summary, "A long paragraph."), /only short, unnested/],
        [
            entry.replace(summary, "- Parent.\n  - Nested."),
            /only short, unnested/,
        ],
    ]) {
        assert.throws(() => extractReleaseSummary(source, version), error);
    }
});

test("renders a compact body with the full commit SHA rather than a moving ref", () => {
    const targetCommit = "a".repeat(40);
    const repository = { owner: "owner", name: "artgod" };
    const release = {
        ...classifyReleaseTag(`v${version}`, version),
        targetCommit,
    };
    const body = formatGitHubReleaseNotes(summary, release, repository);
    assert.equal(
        body,
        `${summary}\n\n[Full changelog](https://github.com/owner/artgod/blob/${targetCommit}/CHANGELOG.md)\n`,
    );
    assert.doesNotMatch(body, /Detailed fix|Unreleased|Upgrade notes|\/main\//);
});

test("test releases reuse the application's summary with a test-build heading", () => {
    const tagName = `v${version}-test.2`;
    const body = formatGitHubReleaseNotes(
        extractReleaseSummary(entry, version),
        {
            ...classifyReleaseTag(tagName, version),
            targetCommit: "b".repeat(40),
        },
        { owner: "owner", name: "artgod" },
    );
    assert.match(
        body,
        new RegExp(
            `^\\*\\*Test build: ${tagName.replaceAll(".", "\\.")}\\*\\*`,
        ),
    );
    assert.ok(body.includes(summary));
});
