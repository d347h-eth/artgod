import { readFile } from "node:fs/promises";
import path from "node:path";

export const RELEASE_CHANGELOG_PATH = "CHANGELOG.md";
export const RELEASE_SUMMARY_HEADING = "### Release summary";
export const ENV_DESKTOP_RELEASE_NOTES_PATH = "DESKTOP_RELEASE_NOTES_PATH";

// The changelog contract uses literal, dated H2 release headings and H3 summaries.
export function extractReleaseSummary(changelog, projectVersion) {
    const source = changelog.replace(/\r\n/g, "\n");
    const headings = [...source.matchAll(/^#{1,2} .+$/gm)];
    const releaseHeading = `## ${projectVersion}`;
    const matches = headings.filter(
        ([heading]) =>
            heading === releaseHeading ||
            heading.startsWith(`${releaseHeading} `),
    );
    if (matches.length !== 1) {
        throw new Error(
            `${RELEASE_CHANGELOG_PATH} must contain exactly one section for ${projectVersion}; found ${matches.length}.`,
        );
    }

    const target = matches[0];
    const date = target[0].slice(releaseHeading.length);
    if (!/^ - \d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(
            `Release heading must be ${releaseHeading} - YYYY-MM-DD.`,
        );
    }
    const next = headings[headings.indexOf(target) + 1];
    const section = source.slice(
        target.index + target[0].length,
        next?.index ?? source.length,
    );
    const subsections = [...section.matchAll(/^#{1,3} .+$/gm)];
    const summaries = subsections.filter(
        ([heading]) => heading === RELEASE_SUMMARY_HEADING,
    );
    if (summaries.length !== 1) {
        throw new Error(
            `${projectVersion} must contain exactly one ${RELEASE_SUMMARY_HEADING} section; found ${summaries.length}.`,
        );
    }

    const summaryHeading = summaries[0];
    const nextSubsection = subsections[subsections.indexOf(summaryHeading) + 1];
    const summary = section.slice(
        summaryHeading.index + summaryHeading[0].length,
        nextSubsection?.index ?? section.length,
    );
    const bullets = [];
    for (const line of summary.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        if (/^- \S/.test(line)) {
            bullets.push(line.slice(2).trim());
        } else if (
            /^ {2,}\S/.test(line) &&
            !/^\s+[-*+]\s/.test(line) &&
            bullets.length > 0
        ) {
            // Join Markdown wrapping so each exported bullet stays on one line.
            bullets[bullets.length - 1] += ` ${line.trim()}`;
        } else {
            throw new Error(
                `${projectVersion} release summary must contain only short, unnested '- ' bullets.`,
            );
        }
    }
    if (bullets.length === 0) {
        throw new Error(`${projectVersion} release summary is empty.`);
    }
    return bullets.map((bullet) => `- ${bullet}`).join("\n");
}

export async function readReleaseSummary(projectRoot, projectVersion) {
    const changelog = await readFile(
        path.join(projectRoot, RELEASE_CHANGELOG_PATH),
        "utf8",
    );
    return extractReleaseSummary(changelog, projectVersion);
}

// Identity comes from release admission: the repository and full tag target SHA.
export function formatGitHubReleaseNotes(summary, release, repository) {
    const testHeading = release.isTestRelease
        ? `**Test build: ${release.tagName}**\n\n`
        : "";
    const changelogUrl = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/blob/${release.targetCommit}/${RELEASE_CHANGELOG_PATH}`;
    return `${testHeading}${summary}\n\n[Full changelog](${changelogUrl})\n`;
}
