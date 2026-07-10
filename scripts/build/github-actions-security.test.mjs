import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const workflowsDirectory = path.join(rootDir, ".github", "workflows");
const fullCommitActionReferencePattern = /^[^\s@]+@[a-f0-9]{40}$/;

test("pins every external GitHub Action to a full commit SHA", async () => {
    for (const workflow of await readWorkflows()) {
        const actionReferences = [
            ...workflow.source.matchAll(/^\s*uses:\s+([^\s#]+)/gm),
        ].map((match) => match[1]);
        assert.ok(
            actionReferences.length > 0,
            `${workflow.name} has no Action references to validate.`,
        );
        for (const actionReference of actionReferences) {
            if (actionReference.startsWith("./")) {
                continue;
            }
            assert.match(
                actionReference,
                fullCommitActionReferencePattern,
                `${workflow.name} uses mutable Action reference ${actionReference}.`,
            );
        }
    }
});

test("keeps checkout credentials out of subsequent workflow steps", async () => {
    for (const workflow of await readWorkflows()) {
        const stepPattern =
            /^\s{12}- name: .+(?:\n(?!\s{12}- name: )[\s\S])*?(?=^\s{12}- name: |\s*$)/gm;
        const checkoutSteps = [...workflow.source.matchAll(stepPattern)]
            .map((match) => match[0])
            .filter((step) => step.includes("uses: actions/checkout@"));

        for (const checkoutStep of checkoutSteps) {
            assert.match(
                checkoutStep,
                /persist-credentials:\s*false/,
                `${workflow.name} persists checkout credentials.`,
            );
        }
    }
});

test("separates signing, attestation, and publication trust boundaries", async () => {
    const releaseWorkflow = await readFile(
        path.join(workflowsDirectory, "tauri-release.yml"),
        "utf8",
    );

    assert.match(releaseWorkflow, /^permissions:\n\s{4}contents: read$/m);
    assert.match(releaseWorkflow, /^\s{4}assemble-release:$/m);
    assert.match(releaseWorkflow, /^\s{4}publish-release:$/m);
    assert.match(
        releaseWorkflow,
        /^\s{12}attestations: write\n\s{12}contents: write\n\s{12}id-token: write$/m,
    );

    const cleanupIndex = releaseWorkflow.indexOf(
        "Remove temporary macOS signing credentials",
    );
    const firstArtifactActionIndex = releaseWorkflow.indexOf(
        "Preserve macOS notarization input",
    );
    const attestationIndex = releaseWorkflow.indexOf(
        "Attest release artifacts",
    );
    const publicationIndex = releaseWorkflow.indexOf("Publish GitHub release");
    assert.ok(cleanupIndex >= 0 && cleanupIndex < firstArtifactActionIndex);
    assert.ok(attestationIndex >= 0 && attestationIndex < publicationIndex);
    assert.doesNotMatch(releaseWorkflow, /APPLE_API_KEY_PATH=/);
    assert.doesNotMatch(releaseWorkflow, /MACOS_NOTARIZATION_KEY_FILE_NAME/);
});

async function readWorkflows() {
    const workflowNames = (await readdir(workflowsDirectory))
        .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
        .sort();
    return await Promise.all(
        workflowNames.map(async (name) => ({
            name,
            source: await readFile(path.join(workflowsDirectory, name), "utf8"),
        })),
    );
}
